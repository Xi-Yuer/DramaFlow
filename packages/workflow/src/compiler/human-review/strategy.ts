import {
  humanReviewDecisionV1Schema,
  isTypeAssignable,
  StringType,
  type NodeDefinition,
  type NodeTypeManifest,
  type RuntimeValue,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { interrupt, isGraphBubbleUp } from '@langchain/langgraph';
import {
  createHumanReviewInterruptPayload,
  humanReviewOutputFromDecision,
  isHumanReviewNodeManifest,
} from '../../node/human-review.js';
import type { NodeDeclaration } from '../../node/type.js';
import { NodeExecutionError, type NodeExecutionStage } from '../../runtime/node-execution-error.js';
import type { LangGraphNode, NodeCompilationStrategy, WorkflowValueServices } from '../strategy.js';

interface HumanReviewCompilationContext {
  node: NodeDefinition;
  declaration: NodeDeclaration;
  workflow: WorkflowDefinition;
  services: WorkflowValueServices;
  addNode(id: string, node: LangGraphNode): void;
}

export class HumanReviewNodeCompilationStrategy implements NodeCompilationStrategy<HumanReviewCompilationContext> {
  supports(manifest: NodeTypeManifest): boolean {
    return isHumanReviewNodeManifest(manifest);
  }

  compile({ node, declaration, workflow, services, addNode }: HumanReviewCompilationContext): void {
    if (
      !this.supports(declaration.manifest) ||
      node.type !== declaration.manifest.type ||
      node.typeVersion !== declaration.manifest.version
    )
      throw new Error('Human Review 编译策略仅支持 flow.human_review@1');
    // interrupt 前仅做纯数据转换；LangGraph 恢复时会从函数开头重入。
    // 不创建 NodeRun，不提交输出，也不在这里管理 WorkflowRun waiting。
    addNode(node.id, async (state) => {
      let stage: NodeExecutionStage = 'resolve_input';
      try {
        const values = await services.bindings.resolveInputs({
          node,
          nodeType: declaration.manifest,
          edges: workflow.edges,
          state,
          workflowInputs: workflow.inputs,
        });
        stage = 'decode_input';
        const content = values.content;
        if (!content || content.storage !== 'inline' || !isTypeAssignable(content.type, StringType))
          throw new Error('Human Review V1 仅支持 inline string content');
        const identity = { projectId: state.run.projectId, workflowRunId: state.run.workflowRunId };
        const raw = await services.codec.decodeRecord(values, identity);
        stage = 'validate_input';
        const input = declaration.inputSchema.parse(raw);
        stage = 'validate_config';
        const config = declaration.configSchema.parse(node.config);
        stage = 'execute';
        const payload = createHumanReviewInterruptPayload(node.id, input, config);
        const decision = humanReviewDecisionV1Schema.parse(interrupt<unknown>(payload));
        const result = humanReviewOutputFromDecision(input, decision);
        stage = 'validate_output';
        const output = declaration.outputSchema.parse(result);
        stage = 'encode_output';
        const encoded: Record<string, RuntimeValue> = {};
        for (const port of declaration.manifest.outputs) {
          encoded[port.key] = await services.codec.encode(output[port.key], {
            type: port.dataType,
            storagePolicy: port.storagePolicy ?? 'auto',
            context: { ...identity, nodeId: node.id, outputKey: port.key },
          });
        }
        return { outputs: { [node.id]: encoded } };
      } catch (error) {
        // GraphInterrupt 属于官方暂停信号，不能包装成节点业务失败。
        if (isGraphBubbleUp(error)) throw error;
        throw new NodeExecutionError(node.id, node.type, stage, error);
      }
    });
  }
}
