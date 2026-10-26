import {
  isTypeAssignable,
  StringType,
  type NodeDefinition,
  type NodeTypeManifest,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import type { NodeDeclaration } from '../../node/registry/type.js';
import { evaluateCondition } from './condition-evaluator.js';
import type { LangGraphNode, NodeCompilationStrategy, WorkflowValueServices } from '../strategy.js';
import type { WorkflowState } from '../../runtime/state/state.js';

export type IfExecutionServices = WorkflowValueServices;
interface IfCompilationContext {
  node: NodeDefinition;
  declaration: NodeDeclaration;
  workflow: WorkflowDefinition;
  services: IfExecutionServices;
  addNode(id: string, node: LangGraphNode): void;
}
export class IfNodeCompilationStrategy implements NodeCompilationStrategy<IfCompilationContext> {
  supports(manifest: NodeTypeManifest): boolean {
    return (
      manifest.executionKind === 'control' && manifest.type === 'flow.if' && manifest.version === 1
    );
  }
  compile(context: IfCompilationContext): void {
    const { node, declaration, workflow, services } = context;
    if (
      !this.supports(declaration.manifest) ||
      node.type !== declaration.manifest.type ||
      node.typeVersion !== declaration.manifest.version
    )
      throw new Error('If 编译策略仅支持 flow.if@1');
    const config = declaration.configSchema.parse(node.config);
    context.addNode(node.id, async (state) => {
      const inputs = await services.bindings.resolveInputs({
        node,
        nodeType: declaration.manifest,
        edges: workflow.edges,
        state,
        workflowInputs: workflow.inputs,
      });
      const value = inputs.value;
      if (!Object.hasOwn(inputs, 'value') || !value || !isTypeAssignable(value.type, StringType))
        throw new Error('If 输入必须为 string RuntimeValue');
      const raw = await services.codec.decodeRecord(inputs, {
        projectId: state.run.projectId,
        workflowRunId: state.run.workflowRunId,
      });
      const input = declaration.inputSchema.parse(raw);
      const result = evaluateCondition(config.condition, { value: input.value });
      return { execution: { controlResults: { [node.id]: result } } };
    });
  }
}

// 条件边只读取已计算且已进入当前 State 的结果，绝不重新 Binding / decode / 求值。
export function readIfRoute(state: WorkflowState, nodeId: string): 'true' | 'false' {
  const results = state.execution.controlResults;
  if (!results || !Object.hasOwn(results, nodeId) || typeof results[nodeId] !== 'boolean')
    throw new Error('If 内部路由结果缺失');
  return results[nodeId] ? 'true' : 'false';
}
