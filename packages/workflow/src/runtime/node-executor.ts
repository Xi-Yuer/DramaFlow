import type { NodeDefinition, RuntimeValue, WorkflowDefinition } from '@dramaflow/contracts';
import type { RunnableConfig } from '@langchain/core/runnables';
import { NodeRegistry } from '../node/registry.js';
import type { BindingResolver } from './binding-resolver.js';
import { failNodeRun, type NodeExecutionStage } from './node-execution-error.js';
import type { NodeRunRepository } from '../run/node-run-repository.js';
import type { RuntimeValueCodec } from './values/runtime-value-codec.js';
import type { RuntimeValueContext } from './values/value-codec.js';
import type { WorkflowState } from './state.js';

export interface CapabilityInvoker {
  invoke(capability: string, input: unknown): Promise<unknown>;
}

export interface NodeExecutionContext extends RuntimeValueContext {
  readonly scopeKey: string;
  readonly childExecutionId?: string;
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
    private readonly nodeRunRepository: NodeRunRepository,
    private readonly capabilities?: CapabilityInvoker,
  ) {}

  async execute(node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
    // Repository 故障属于基础设施异常，必须位于业务失败的 catch 范围之外。
    const occurrence = await this.nodeRunRepository.getOrCreateOccurrence({
      workflowRunId: context.workflowRunId,
      nodeId: node.id,
      scopeKey: context.scopeKey,
    });
    const nodeRun = await this.nodeRunRepository.createRunning({
      workflowRunId: context.workflowRunId,
      nodeId: node.id,
      occurrenceId: occurrence.id,
      ...(context.childExecutionId ? { childExecutionId: context.childExecutionId } : {}),
    });
    let nodeType: ReturnType<NodeRegistry['getAction']>;
    let runtimeInputs: Record<string, RuntimeValue>;
    try {
      // getAction 复用 get 的精确类型版本查找，并拒绝所有非 action 声明。
      nodeType = this.nodeRegistry.getAction(node.type, node.typeVersion);
      runtimeInputs = await this.bindingResolver.resolveInputs({
        node,
        nodeType: nodeType.manifest,
        edges: context.workflow.edges,
        state: context.state,
        workflowInputs: context.workflow.inputs,
      });
    } catch (cause) {
      return failNodeRun(this.nodeRunRepository, node, nodeRun.id, 'resolve_input', cause);
    }

    await this.nodeRunRepository.updateInputs(nodeRun.id, runtimeInputs);

    let stage: NodeExecutionStage = 'decode_input';
    const encodedOutputs: Record<string, RuntimeValue> = {};
    try {
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
        ...(this.capabilities ? { capabilities: this.capabilities } : {}),
      });
      stage = 'validate_output';
      const output = nodeType.outputSchema.parse(rawOutput);
      stage = 'encode_output';
      for (const port of nodeType.manifest.outputs) {
        encodedOutputs[port.key] = await this.runtimeValueCodec.encode(output[port.key], {
          type: port.dataType,
          storagePolicy: port.storagePolicy ?? 'auto',
          context: {
            projectId: context.projectId,
            workflowRunId: context.workflowRunId,
            nodeRunId: nodeRun.id,
            nodeId: node.id,
            outputKey: port.key,
          },
        });
      }
    } catch (cause) {
      return failNodeRun(this.nodeRunRepository, node, nodeRun.id, stage, cause);
    }

    await this.nodeRunRepository.markCompleted(nodeRun.id, encodedOutputs);
    return { output: encodedOutputs };
  }
}
