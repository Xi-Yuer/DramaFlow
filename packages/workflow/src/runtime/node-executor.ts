import type {
  NodeDefinition,
  NodeRun,
  RuntimeValue,
  WorkflowDefinition,
} from '@dramaflow/contracts';
import type { RunnableConfig } from '@langchain/core/runnables';
import { isGraphBubbleUp } from '@langchain/langgraph';
import { NodeRegistry } from '../node/registry.js';
import type { BindingResolver } from './binding-resolver.js';
import {
  NodeExecutionError,
  NodeRunRecordingError,
  toNodeRunError,
  type NodeExecutionStage,
} from './node-execution-error.js';
import type { NodeRunRepository } from '../run/node-run-repository.js';
import type { RuntimeValueCodec } from './runtime-value-codec.js';
import type { RuntimeValueContext } from './value-codec.js';
import type { WorkflowState } from './state.js';

export interface CapabilityInvoker {
  invoke(capability: string, input: unknown): Promise<unknown>;
}

export interface NodeExecutionContext extends RuntimeValueContext {
  readonly workflow: WorkflowDefinition;
  readonly state: WorkflowState;
  readonly signal?: AbortSignal;
  readonly capabilities?: CapabilityInvoker;
  readonly runnableConfig?: RunnableConfig;
}
export interface NodeExecutionResult {
  readonly output: Record<string, RuntimeValue>;
}

export interface NodeExecutor {
  execute(node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult>;
}

export class DefaultNodeExecutor implements NodeExecutor {
  constructor(
    private readonly nodeRegistry: NodeRegistry,
    private readonly bindingResolver: BindingResolver,
    private readonly runtimeValueCodec: RuntimeValueCodec,
    private readonly nodeRuns: NodeRunRepository,
  ) {}

  async execute(node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
    let stage: NodeExecutionStage = 'create_run';
    let nodeRun: NodeRun | undefined;
    try {
      nodeRun = await this.nodeRuns.createRunning({
        workflowRunId: context.workflowRunId,
        nodeId: node.id,
      });
      stage = 'resolve_input';
      // getAction 复用 get 的精确类型版本查找，并拒绝所有非 action 声明。
      const nodeType = this.nodeRegistry.getAction(node.type, node.typeVersion);
      const runtimeInputs = await this.bindingResolver.resolveInputs({
        node,
        nodeType: nodeType.manifest,
        edges: context.workflow.edges,
        state: context.state,
      });

      stage = 'record_inputs';
      await this.nodeRuns.updateInputs(nodeRun.id, runtimeInputs);

      stage = 'decode_input';
      const rawInputs = await this.runtimeValueCodec.decodeRecord(runtimeInputs, {
        projectId: context.projectId,
        workflowRunId: context.workflowRunId,
      });

      stage = 'validate_input';
      const input = nodeType.inputSchema.parse(rawInputs);
      stage = 'validate_config';
      const config = nodeType.configSchema.parse(node.config);
      stage = 'execute';
      const rawOutput = await nodeType.execute(input, config, {
        ...context,
        nodeRunId: nodeRun.id,
      });
      stage = 'validate_output';
      const output = nodeType.outputSchema.parse(rawOutput);
      stage = 'encode_output';
      const encodedOutputs: Record<string, RuntimeValue> = {};
      for (const port of nodeType.manifest.outputs) {
        encodedOutputs[port.key] = await this.runtimeValueCodec.encode(output[port.key], {
          type: port.dataType,
          storagePolicy: port.storagePolicy ?? 'auto',
          context: {
            projectId: context.projectId,
            workflowRunId: context.workflowRunId,
            nodeId: node.id,
            outputKey: port.key,
          },
        });
      }
      stage = 'complete_run';
      await this.nodeRuns.markCompleted(nodeRun.id, encodedOutputs);
      return { output: encodedOutputs };
    } catch (cause) {
      // 中断、父图 Command 等原生控制异常必须交还 LangGraph，不能记为业务失败。
      if (cause !== null && isGraphBubbleUp(cause)) throw cause;
      const error = new NodeExecutionError(node.id, node.type, stage, cause);
      if (nodeRun !== undefined) {
        try {
          await this.nodeRuns.markFailed(nodeRun.id, toNodeRunError(error));
        } catch (recordingError) {
          throw new NodeRunRecordingError(nodeRun.id, error, recordingError);
        }
      }
      throw error;
    }
  }
}
