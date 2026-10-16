import { Annotation, Command, END, interrupt, START, StateGraph } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  humanResponseSchema,
  jsonObjectSchema,
  workflowDefinitionSchema,
} from '@dramaflow/contracts';
import type { JsonObject, NodeResult, WorkflowNode } from '@dramaflow/contracts';
import { nodeConfigSchemas } from './catalog.js';
import { resolveNodeInputs, WorkflowInputError, WorkflowCanceledError } from './inputs.js';
import { evaluateCondition } from './nodes/condition.js';
import { operationRequest } from './nodes/generation.js';
import { createBatchGraph } from './nodes/batch.js';
import { dependenciesOf, validateWorkflow } from './validation.js';
import type {
  InvokeOptions,
  ResumeOptions,
  RuntimeHost,
  RuntimeOptions,
  RuntimeResult,
} from './types.js';

const mergeRecords = <T>(left: Record<string, T>, right: Record<string, T>) => ({
  ...left,
  ...right,
});
const RuntimeState = Annotation.Root({
  runId: Annotation<string>,
  attemptId: Annotation<string>,
  inputs: Annotation<JsonObject>,
  nodeResults: Annotation<Record<string, NodeResult>>({
    reducer: mergeRecords<NodeResult>,
    default: () => ({}),
  }),
  outputCollections: Annotation<Record<string, JsonObject>>({
    reducer: mergeRecords<JsonObject>,
    default: () => ({}),
  }),
  reusedResults: Annotation<Record<string, NodeResult>>,
  executeNodeIds: Annotation<string[] | null>,
});
type State = typeof RuntimeState.State;

function safeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof WorkflowInputError) return { code: error.code, message: error.message };
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return { code: error.code, message: error instanceof Error ? error.message : '节点执行失败' };
  }
  return { code: 'NODE_EXECUTION_FAILED', message: '节点执行失败，请检查运行记录' };
}

async function record(
  host: RuntimeHost,
  state: State,
  node: WorkflowNode,
  result: NodeResult,
): Promise<Partial<State>> {
  const completed: NodeResult = { ...result, attemptId: state.attemptId };
  await host.recordNodeResult({
    runId: state.runId,
    nodeId: node.id,
    attemptId: state.attemptId,
    result: completed,
  });
  const eventType =
    completed.status === 'running' ? 'node.started' : (`node.${completed.status}` as const);
  await host.onEvent?.({
    runId: state.runId,
    nodeId: node.id,
    type: eventType,
    data: jsonObjectSchema.parse(completed),
  });
  return {
    nodeResults: { [node.id]: completed },
    ...(node.type === 'output' && completed.status === 'succeeded'
      ? { outputCollections: { [node.id]: completed.outputs } }
      : {}),
  };
}

/** Compile a static AND graph. A skipped branch still completes its wrapper, so joins never wait for unselected nodes. */
export function createWorkflowRuntime(options: RuntimeOptions) {
  const definition = workflowDefinitionSchema.parse(options.definition);
  const validation = validateWorkflow(definition);
  if (!validation.valid)
    throw new WorkflowInputError(
      'INVALID_WORKFLOW',
      validation.issues.map((issue) => issue.message).join('；'),
    );
  const { host } = options;
  const builder = new StateGraph(RuntimeState).addNode('__finalize__' as string, () => ({}));
  for (const node of definition.nodes) {
    const batchGraph = node.type === 'batch' ? createBatchGraph(node, host) : undefined;
    builder.addNode(node.id, async (state, runtimeConfig) => {
      if (runtimeConfig.signal?.aborted || (await host.isCancelled(state.runId)))
        throw new WorkflowCanceledError();
      const reused = state.reusedResults[node.id];
      if (reused) return record(host, state, node, { ...reused, reused: true });
      if (state.executeNodeIds && !state.executeNodeIds.includes(node.id))
        return record(host, state, node, { status: 'skipped', outputs: {}, activePorts: [] });
      const incoming = definition.controlEdges.filter((edge) => edge.target === node.id);
      if (node.type !== 'input') {
        if (
          incoming.some((edge) =>
            ['failed', 'blocked'].includes(state.nodeResults[edge.source]?.status ?? ''),
          )
        )
          return record(host, state, node, {
            status: 'blocked',
            outputs: {},
            activePorts: [],
            error: { code: 'UPSTREAM_FAILED', message: '执行依赖的上游节点失败' },
          });
        if (
          !incoming.some((edge) =>
            state.nodeResults[edge.source]?.activePorts.includes(edge.sourcePort),
          )
        )
          return record(host, state, node, { status: 'skipped', outputs: {}, activePorts: [] });
      }
      let input: JsonObject;
      try {
        input = resolveNodeInputs(node, definition, state.inputs, state.nodeResults);
      } catch (error) {
        return record(host, state, node, {
          status:
            error instanceof WorkflowInputError && error.code === 'UPSTREAM_FAILED'
              ? 'blocked'
              : 'failed',
          outputs: {},
          activePorts: [],
          error: safeFailure(error),
        });
      }
      if (node.type === 'review') {
        const payload: JsonObject = {
          nodeId: node.id,
          prompt: nodeConfigSchemas.review.parse(node.config).prompt,
          value: input.value ?? null,
        };
        await record(host, state, node, { status: 'waiting', outputs: {}, activePorts: [] });
        // interrupt uses a control-flow exception. Keep it outside the executor's error boundary.
        const response = humanResponseSchema.parse(interrupt(payload));
        const reviewedValue =
          response.values && Object.hasOwn(response.values, 'value')
            ? response.values.value!
            : (input.value ?? null);
        return record(host, state, node, {
          status: 'succeeded',
          outputs: {
            value: reviewedValue,
            decision: response.decision,
            feedback: response.feedback ?? '',
          },
          activePorts: response.decision === 'approve' ? ['out', 'approve'] : ['reject'],
        });
      }
      await record(host, state, node, { status: 'running', outputs: {}, activePorts: [] });
      try {
        let outputs: JsonObject;
        let activePorts = ['out'];
        switch (node.type) {
          case 'input':
            outputs = { value: state.inputs };
            break;
          case 'output':
            outputs = input;
            break;
          case 'condition': {
            const matched = evaluateCondition(node, input);
            outputs = { value: input.value ?? null, matched };
            activePorts = [matched ? 'true' : 'false'];
            break;
          }
          case 'merge': {
            const values = Object.values(input);
            if (nodeConfigSchemas.merge.parse(node.config).mode === 'selected') {
              if (values.length !== 1)
                throw new WorkflowInputError(
                  'MERGE_SELECTION_COUNT',
                  `selected 合并需要恰好一个可用输入，当前为 ${values.length} 个`,
                );
              outputs = { value: values[0]! };
            } else outputs = { values };
            break;
          }
          case 'batch': {
            if (!Array.isArray(input.items))
              throw new WorkflowInputError('BATCH_INPUT_NOT_ARRAY', '批量输入必须为数组');
            const batch = await batchGraph!.invoke(
              { runId: state.runId, attemptId: state.attemptId, items: input.items },
              {
                ...runtimeConfig,
                maxConcurrency: nodeConfigSchemas.batch.parse(node.config).maxConcurrency,
              },
            );
            outputs = { items: batch.output };
            break;
          }
          default:
            outputs = jsonObjectSchema.parse(
              await host.executeOperation(
                operationRequest(node, state, input, runtimeConfig.signal),
              ),
            );
        }
        if (node.type === 'output')
          await host.onEvent?.({
            runId: state.runId,
            nodeId: node.id,
            type: 'output.collected',
            data: outputs,
          });
        return record(host, state, node, { status: 'succeeded', outputs, activePorts });
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'OPERATION_RECOVERABLE'
        )
          throw error;
        if (error instanceof WorkflowCanceledError || runtimeConfig.signal?.aborted) throw error;
        return record(host, state, node, {
          status: 'failed',
          outputs: {},
          activePorts: [],
          error: safeFailure(error),
        });
      }
    });
  }
  // All dynamic business choices are evaluated by wrappers; LangGraph alone owns scheduling.
  for (const node of definition.nodes) {
    const dependencies = dependenciesOf(definition, node.id);
    if (dependencies.length) builder.addEdge(dependencies, node.id);
    else builder.addEdge(START, node.id);
  }
  const leaves = definition.nodes
    .filter(
      (node) =>
        !definition.nodes.some((target) => dependenciesOf(definition, target.id).includes(node.id)),
    )
    .map((node) => node.id);
  builder.addEdge(leaves, '__finalize__');
  builder.addEdge('__finalize__', END);
  const graph = builder.compile({ checkpointer: options.checkpointer });

  const configFor = (runId: string, attemptId: string, signal?: AbortSignal): RunnableConfig => ({
    configurable: { thread_id: `${runId}:${attemptId}` },
    maxConcurrency: options.maxConcurrency ?? 8,
    recursionLimit: definition.nodes.length + 10,
    ...(signal ? { signal } : {}),
  });

  async function resultFor(runId: string, attemptId: string): Promise<RuntimeResult> {
    const snapshot = await graph.getState(configFor(runId, attemptId));
    const values = snapshot.values as State;
    const interrupts: RuntimeResult['interrupts'] = [];
    // Pending writes may retain an old interrupt on an already-completed sibling.
    // Only tasks that remain in `next` are still awaiting a response.
    for (const task of snapshot.tasks.filter((entry) => snapshot.next.includes(entry.name)))
      for (const interrupted of task.interrupts ?? []) {
        if (!interrupted.id) continue;
        const payload = jsonObjectSchema.parse(interrupted.value);
        if (typeof payload.nodeId !== 'string')
          throw new WorkflowInputError('INVALID_INTERRUPT', '人工中断缺少节点标识');
        interrupts.push({ id: interrupted.id, nodeId: payload.nodeId, payload });
        await host.createHumanTask({
          runId,
          attemptId,
          nodeId: payload.nodeId,
          interruptId: interrupted.id,
          payload,
        });
      }
    const nodeResults = { ...(values.nodeResults ?? {}) };
    for (const waiting of interrupts)
      nodeResults[waiting.nodeId] = { status: 'waiting', outputs: {}, activePorts: [], attemptId };
    const status = (await host.isCancelled(runId))
      ? 'canceled'
      : interrupts.length
        ? 'waiting'
        : Object.values(nodeResults).some(
              (result) => result.status === 'failed' || result.status === 'blocked',
            )
          ? 'failed'
          : 'succeeded';
    return { status, nodeResults, outputCollections: values.outputCollections ?? {}, interrupts };
  }

  async function invoke(input: InvokeOptions): Promise<RuntimeResult> {
    jsonObjectSchema.parse(input.inputs);
    try {
      await graph.invoke(
        {
          runId: input.runId,
          attemptId: input.attemptId,
          inputs: input.inputs,
          reusedResults: input.reusedResults ?? {},
          executeNodeIds: input.executeNodeIds ?? null,
        },
        { ...configFor(input.runId, input.attemptId, input.signal), durability: 'sync' },
      );
    } catch (error) {
      if (!(error instanceof WorkflowCanceledError) && !input.signal?.aborted) throw error;
      return { ...(await resultFor(input.runId, input.attemptId)), status: 'canceled' };
    }
    return resultFor(input.runId, input.attemptId);
  }

  async function resume(input: ResumeOptions): Promise<RuntimeResult> {
    humanResponseSchema.parse(input.response);
    const snapshot = await graph.getState(configFor(input.runId, input.attemptId));
    const pending = snapshot.tasks
      .filter((task) => snapshot.next.includes(task.name))
      .flatMap((task) => task.interrupts ?? []);
    if (!pending.some((entry) => entry.id === input.interruptId))
      throw new WorkflowInputError('STALE_HUMAN_INTERRUPT', '人工任务已处理或不属于当前运行');
    try {
      await graph.invoke(new Command({ resume: { [input.interruptId]: input.response } }), {
        ...configFor(input.runId, input.attemptId, input.signal),
        durability: 'sync',
      });
    } catch (error) {
      if (!(error instanceof WorkflowCanceledError) && !input.signal?.aborted) throw error;
      return { ...(await resultFor(input.runId, input.attemptId)), status: 'canceled' };
    }
    return resultFor(input.runId, input.attemptId);
  }

  async function recover(
    input: Pick<InvokeOptions, 'runId' | 'attemptId' | 'signal'>,
  ): Promise<RuntimeResult> {
    const snapshot = await graph.getState(configFor(input.runId, input.attemptId));
    if (!snapshot.createdAt)
      throw new WorkflowInputError('RUN_CHECKPOINT_MISSING', '未找到此运行的持久化检查点');
    if (snapshot.tasks.some((task) => task.interrupts?.length))
      return resultFor(input.runId, input.attemptId);
    try {
      await graph.invoke(null, {
        ...configFor(input.runId, input.attemptId, input.signal),
        durability: 'sync',
      });
    } catch (error) {
      if (!(error instanceof WorkflowCanceledError) && !input.signal?.aborted) throw error;
      return { ...(await resultFor(input.runId, input.attemptId)), status: 'canceled' };
    }
    return resultFor(input.runId, input.attemptId);
  }
  return { invoke, resume, recover };
}
