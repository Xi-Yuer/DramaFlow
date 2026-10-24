import {
  humanReviewDecisionV1Schema,
  isTypeAssignable,
  StringType,
  type NodeDefinition,
  type NodeTypeManifest,
  type RuntimeValue,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { interrupt } from '@langchain/langgraph';
import {
  createHumanReviewInterruptPayload,
  humanReviewOutputFromDecision,
  isHumanReviewNodeManifest,
} from '../../node/human-review.js';
import type { NodeDeclaration } from '../../node/type.js';
import type { HumanReviewNodeRunRepository } from '../../run/node-run-repository.js';
import { areRuntimeValueMapsEqual } from '../../runtime/values/runtime-value-equivalence.js';
import { failNodeRun, type NodeExecutionStage } from '../../runtime/node-execution-error.js';
import type { LangGraphNode, NodeCompilationStrategy, WorkflowValueServices } from '../strategy.js';

interface HumanReviewCompilationContext {
  node: NodeDefinition;
  declaration: NodeDeclaration;
  workflow: WorkflowDefinition;
  services: WorkflowValueServices;
  nodeRuns: HumanReviewNodeRunRepository;
  scopeKey: string;
  addNode(id: string, node: LangGraphNode): void;
}

export class HumanReviewNodeCompilationStrategy implements NodeCompilationStrategy<HumanReviewCompilationContext> {
  supports(manifest: NodeTypeManifest): boolean {
    return isHumanReviewNodeManifest(manifest);
  }

  compile({
    node,
    declaration,
    workflow,
    services,
    nodeRuns,
    scopeKey,
    addNode,
  }: HumanReviewCompilationContext): void {
    if (
      !this.supports(declaration.manifest) ||
      node.type !== declaration.manifest.type ||
      node.typeVersion !== declaration.manifest.version
    )
      throw new Error('Human Review 编译策略仅支持 flow.human_review@1');
    // 当前能力边界下每个 node / Run 仅一次逻辑审核；重入不是新 attempt。
    addNode(node.id, async (state) => {
      const acquire = async () => {
        const occurrence = await nodeRuns.getOrCreateOccurrence({
          workflowRunId: state.run.workflowRunId,
          nodeId: node.id,
          scopeKey,
        });
        return nodeRuns.getOrCreateHumanReviewRunning({
          workflowRunId: state.run.workflowRunId,
          workflowVersionId: state.run.workflowVersionId,
          nodeId: node.id,
          occurrenceId: occurrence.id,
        });
      };
      let values: Record<string, RuntimeValue>;
      try {
        values = await services.bindings.resolveInputs({
          node,
          nodeType: declaration.manifest,
          edges: workflow.edges,
          state,
          workflowInputs: workflow.inputs,
        });
      } catch (cause) {
        const audit = await acquire();
        return failNodeRun(nodeRuns, node, audit.id, 'resolve_input', cause);
      }
      // Repository 故障留作基础设施异常，不把持久化失败反向写成业务失败。
      const audit = await acquire();
      if (audit.inputs !== undefined) {
        if (!areRuntimeValueMapsEqual(audit.inputs, values))
          return failNodeRun(
            nodeRuns,
            node,
            audit.id,
            'resolve_input',
            new Error('Human Review 输入与首次审核不一致'),
          );
      } else {
        await nodeRuns.updateInputs(audit.id, values);
      }
      let stage: NodeExecutionStage = 'decode_input';
      const encoded: Record<string, RuntimeValue> = {};
      try {
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
        stage = 'validate_output';
        const result = humanReviewOutputFromDecision(input, decision);
        const output = declaration.outputSchema.parse(result);
        stage = 'encode_output';
        for (const port of declaration.manifest.outputs) {
          encoded[port.key] = await services.codec.encode(output[port.key], {
            type: port.dataType,
            storagePolicy: port.storagePolicy ?? 'auto',
            context: { ...identity, nodeRunId: audit.id, nodeId: node.id, outputKey: port.key },
          });
        }
      } catch (cause) {
        return failNodeRun(nodeRuns, node, audit.id, stage, cause);
      }
      // 完成持久化之后才提交 State；markCompleted 失败不能转为业务 failed。
      await nodeRuns.markCompleted(audit.id, encoded);
      return { outputs: { [node.id]: encoded } };
    });
  }
}
