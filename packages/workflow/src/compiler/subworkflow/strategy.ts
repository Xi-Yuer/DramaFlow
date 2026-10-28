import {
  isSubworkflowNodeManifest,
  resolveNodePorts,
  type NodeDefinition,
  type NodeTypeManifest,
  type WorkflowDefinition,
  type WorkflowRun,
  type RuntimeValue,
} from '@dramaflow/contracts';
import {
  START,
  END,
  StateGraph,
  isGraphBubbleUp,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import {
  RunnableLambda,
  RunnableSequence,
  type RunnableInterface,
} from '@langchain/core/runnables';
import type { NodeRegistry } from '../../node/registry/registry.js';
import type { NodeDeclaration } from '../../node/registry/type.js';
import type { NodeExecutor } from '../../runtime/node/node-executor.js';
import type { ChildGraphRunRepository } from '../../runtime/execution/child-execution-repository.js';
import {
  deriveChildScope,
  graphExecutionIdentitySchema,
} from '../../runtime/execution/execution-scope.js';
import { createLocalGraphInvocation } from '../../runtime/execution/graph-invocation.js';
import { failNodeRun, NodeExecutionError } from '../../runtime/node/node-execution-error.js';
import { failCompositeExecution } from '../../runtime/execution/composite-failure-boundary.js';
import type { WorkflowState, WorkflowStateUpdate } from '../../runtime/state/state.js';
import type { NodeCompilationStrategy, WorkflowValueServices } from '../strategy.js';
import {
  compileGraph,
  readGraphExecutionIdentity,
  type GraphExecutionContext,
  type GraphNodeRegistrationOptions,
} from '../graph/graph-compiler.js';
import type { GraphCompilationPlan, GraphStrategyStructure } from '../graph/compilation-plan.js';
import {
  SUBWORKFLOW_FRAME,
  SUBWORKFLOW_PARENT_EXECUTION,
  SUBWORKFLOW_CALL,
  SUBWORKFLOW_RESULT,
  SUBWORKFLOW_INVOCATION_KEY,
  subworkflowCallSchema,
  subworkflowFrameSchema,
  subworkflowResultSchema,
  SubworkflowState,
  SubworkflowChildInput,
  SubworkflowChildOutput,
  SubworkflowChildState,
  SubworkflowParentInput,
  SubworkflowParentOutput,
} from './state.js';

export interface SubWorkflowCompilationContext<State extends WorkflowState = WorkflowState> {
  node: NodeDefinition;
  declaration: NodeDeclaration;
  workflow: WorkflowDefinition;
  run: WorkflowRun;
  execution: GraphExecutionContext<State>;
  registry: NodeRegistry;
  executor?: NodeExecutor;
  services: WorkflowValueServices;
  runs: ChildGraphRunRepository;
  childCompilation: GraphCompilationPlan;
  addNode(
    id: string,
    node: RunnableInterface<State, WorkflowStateUpdate, LangGraphRunnableConfig>,
    options?: GraphNodeRegistrationOptions,
  ): void;
}
export class SubWorkflowNodeCompilationStrategy implements NodeCompilationStrategy<SubWorkflowCompilationContext> {
  supports(manifest: NodeTypeManifest): boolean {
    return isSubworkflowNodeManifest(manifest);
  }
  graphStructure(): GraphStrategyStructure {
    return { wrapperNodes: 3, childBoundaries: { graph: { entry: true, completion: true } } };
  }
  compile<State extends WorkflowState>(context: SubWorkflowCompilationContext<State>): void {
    const {
      node,
      declaration,
      workflow,
      run,
      execution: parentExecution,
      registry,
      executor,
      services,
      runs,
      childCompilation,
    } = context;
    if (!this.supports(declaration.manifest) || node.composite?.kind !== 'subworkflow')
      throw new Error('SubWorkflow strategy 仅支持 flow.subworkflow@1');
    const definition = node.composite.graph;
    const failChild = (
      state: typeof SubworkflowChildState.State,
      cause: unknown,
    ): Promise<never> => {
      const call = subworkflowCallSchema.parse(state[SUBWORKFLOW_CALL]);
      return failCompositeExecution(call.childExecutionId, cause, (error) =>
        runs.markChildExecutionAndParentFailed(call.childExecutionId, error),
      );
    };
    const child = new StateGraph<
      typeof SubworkflowChildState.spec,
      typeof SubworkflowChildState.State,
      Partial<typeof SubworkflowChildState.State>,
      string,
      typeof SubworkflowChildInput.spec,
      typeof SubworkflowChildOutput.spec
    >({
      stateSchema: SubworkflowChildState,
      input: SubworkflowChildInput,
      output: SubworkflowChildOutput,
    });
    compileGraph<typeof SubworkflowChildState.State>({
      plan: childCompilation,
      registry,
      run,
      execution: {
        resolve: (state) => {
          const call = subworkflowCallSchema.parse(state[SUBWORKFLOW_CALL]);
          return { scopeKey: call.scopeKey, childExecutionId: call.childExecutionId };
        },
      },
      runtime: { executor, services, childGraphRuns: runs },
      target: {
        addNode: (id, execute, options) => {
          child.addNode(id, execute, options);
        },
        addBoundaryNode: (id, execute) => {
          child.addNode(id, execute);
        },
        addEdge: (sources, target) => {
          child.addEdge(sources, target);
        },
        addConditionalEdges: (id, route, paths) => {
          child.addConditionalEdges(id, route, paths);
        },
      },
      failureBoundary: failChild,
      entry: {
        name: '__dramaflow_subworkflow_inputs',
        execute: async (state) => {
          const frame = subworkflowFrameSchema.parse(state[SUBWORKFLOW_FRAME]);
          return {
            ...frame.state,
            [SUBWORKFLOW_CALL]: {
              parentNodeRunId: frame.parentNodeRunId,
              childExecutionId: frame.childExecutionId,
              scopeKey: frame.scopeKey,
            },
          };
        },
      },
      completion: {
        name: '__dramaflow_subworkflow_outputs',
        onOutputError: async (state, cause) => {
          if (cause !== null && isGraphBubbleUp(cause)) throw cause;
          return failChild(
            state,
            new NodeExecutionError(node.id, node.type, 'validate_output', cause),
          );
        },
        execute: async (state, outputs) => ({
          [SUBWORKFLOW_RESULT]: {
            ...subworkflowCallSchema.parse(state[SUBWORKFLOW_CALL]),
            outputs,
          },
        }),
      },
    });
    const invocation = new StateGraph<
      typeof SubworkflowState.spec,
      typeof SubworkflowState.State,
      Partial<typeof SubworkflowState.State>,
      string,
      typeof SubworkflowParentInput.spec,
      typeof SubworkflowParentOutput.spec
    >({
      stateSchema: SubworkflowState,
      input: SubworkflowParentInput,
      output: SubworkflowParentOutput,
    });
    invocation.addNode('prepare', async (state) => {
      if (
        state.run.workflowRunId !== run.id ||
        state.run.workflowVersionId !== run.workflowVersionId ||
        state.run.projectId !== run.projectId
      )
        throw new Error('SubWorkflow 与已授权 Run 不匹配');
      const identity = graphExecutionIdentitySchema.parse(
        'identity' in parentExecution
          ? parentExecution.identity
          : state[SUBWORKFLOW_PARENT_EXECUTION],
      );
      const occurrence = await runs.getOrCreateOccurrence({
        workflowRunId: run.id,
        nodeId: node.id,
        scopeKey: identity.scopeKey,
      });
      const parent = await runs.createRunning({
        workflowRunId: run.id,
        nodeId: node.id,
        occurrenceId: occurrence.id,
        ...(identity.childExecutionId ? { childExecutionId: identity.childExecutionId } : {}),
      });
      let inputs: Record<string, RuntimeValue>;
      let local: ReturnType<typeof createLocalGraphInvocation>;
      const childScope = deriveChildScope(identity.scopeKey, {
        kind: 'subworkflow_call',
        ownerOccurrenceId: occurrence.id,
        ownerNodeRunId: parent.id,
        slot: 'graph',
        callKey: SUBWORKFLOW_INVOCATION_KEY,
      });
      try {
        inputs = await services.bindings.resolveInputs({
          node,
          nodeType: declaration.manifest,
          ports: resolveNodePorts(node, declaration.manifest),
          edges: workflow.edges,
          workflowInputs: workflow.inputs,
          state,
        });
        local = createLocalGraphInvocation({
          definition,
          definitionLocation: childCompilation.definitionLocation,
          scopeKey: childScope,
          run: state.run,
          sources: inputs,
          mappings: definition.inputs
            .filter((input) => Object.hasOwn(inputs, input.name))
            .map((input) => ({ source: input.name, target: input.name })),
        });
      } catch (cause) {
        return failNodeRun(runs, node, parent.id, 'resolve_input', cause);
      }
      await runs.updateInputs(parent.id, inputs);
      const execution = await runs.getOrCreateChildExecutionRunning({
        workflowRunId: run.id,
        parentNodeRunId: parent.id,
        parentNodeId: node.id,
        scopeKey: childScope,
        kind: 'subworkflow',
        invocationKey: SUBWORKFLOW_INVOCATION_KEY,
        metadata: {},
      });
      return {
        [SUBWORKFLOW_FRAME]: {
          parentNodeRunId: parent.id,
          childExecutionId: execution.id,
          scopeKey: childScope,
          state: local.state,
        },
      };
    });
    invocation.addNode('graph', child.compile(), { input: SubworkflowChildInput });
    invocation.addNode('collect', async (state) => {
      const frame = subworkflowFrameSchema.parse(state[SUBWORKFLOW_FRAME]);
      const result = subworkflowResultSchema.parse(state[SUBWORKFLOW_RESULT]);
      if (
        result.parentNodeRunId !== frame.parentNodeRunId ||
        result.childExecutionId !== frame.childExecutionId ||
        result.scopeKey !== frame.scopeKey
      )
        throw new Error('SubWorkflow result 身份不匹配');
      await runs.markChildExecutionCompleted(frame.childExecutionId);
      await runs.markCompleted(frame.parentNodeRunId, result.outputs);
      return { outputs: { [node.id]: result.outputs } };
    });
    invocation.addEdge(START, 'prepare');
    invocation.addEdge('prepare', 'graph');
    invocation.addEdge('graph', 'collect');
    invocation.addEdge('collect', END);
    const compiled = invocation.compile();
    if ('identity' in parentExecution) {
      context.addNode(node.id, compiled, { subgraphs: [compiled] });
      return;
    }
    // 先读取调用图的完整 State；原生子图输入过滤后只保留明确的执行身份。
    // 使用 Runnable 管道并显式登记子图，不手写 invoke，不更改原生 checkpoint 调度。
    const input = RunnableLambda.from((state: State, config: LangGraphRunnableConfig) => ({
      ...state,
      [SUBWORKFLOW_PARENT_EXECUTION]: readGraphExecutionIdentity(parentExecution, state, config),
    }));
    context.addNode(node.id, RunnableSequence.from<State, WorkflowStateUpdate>([input, compiled]), {
      subgraphs: [compiled],
    });
  }
}
