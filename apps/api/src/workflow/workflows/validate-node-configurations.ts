import { walkGraphDefinitions, type WorkflowDefinition } from '@dramaflow/contracts';
import {
  NodeRegistrationError,
  NodeRegistry,
  isIterationNodeManifest,
  isSubworkflowNodeManifest,
} from '@dramaflow/workflow';
import { BadRequestException } from '@nestjs/common';

function invalidConfiguration(): BadRequestException {
  // 不附带 Zod issues / 原始配置 / cause，避免将凭证字段值带入响应或日志。
  return new BadRequestException({
    code: 'WORKFLOW_NODE_CONFIGURATION_INVALID',
    message: '工作流节点配置无效',
  });
}

export function validateWorkflowNodeConfigurations(
  definition: WorkflowDefinition,
  registry: NodeRegistry,
): void {
  for (const { graph } of walkGraphDefinitions(definition)) {
    for (const node of graph.nodes) {
      let nodeType: ReturnType<NodeRegistry['get']>;
      try {
        nodeType = registry.get(node.type, node.typeVersion);
      } catch (error) {
        // 编辑中的草稿可引用尚不可用的类型；正式发布另走完整语义校验。
        if (error instanceof NodeRegistrationError && error.code === 'unavailable_type') continue;
        throw error;
      }
      if (
        nodeType.manifest.executionKind !== 'action' &&
        !isIterationNodeManifest(nodeType.manifest) &&
        !isSubworkflowNodeManifest(nodeType.manifest)
      )
        continue;
      const allowed = new Set(nodeType.manifest.config.map((field) => field.key));
      if (Object.keys(node.config).some((key) => !allowed.has(key))) throw invalidConfiguration();
    }
  }
}
