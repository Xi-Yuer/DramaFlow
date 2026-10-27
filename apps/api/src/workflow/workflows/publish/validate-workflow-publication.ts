import type { WorkflowDefinition } from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';
import { ModelConfigurationError, type ModelProviderService } from '@dramaflow/server';
import {
  validateGraphDefinitionSemantics,
  assertGraphPublishTopology,
  assertGraphExecutionCapabilities,
  WorkflowPublishValidationError,
  textGenerationConfigSchema,
  type NodeRegistry,
} from '@dramaflow/workflow';
import { BadRequestException } from '@nestjs/common';

export async function validateWorkflowPublication(
  tx: Prisma.TransactionClient,
  ownerId: string,
  snapshot: WorkflowDefinition,
  registry: NodeRegistry,
  models: ModelProviderService,
): Promise<void> {
  try {
    const nodes = validateGraphDefinitionSemantics(snapshot, registry);
    assertGraphPublishTopology(snapshot, registry);
    for (const { node, nodeType, config } of nodes) {
      const requirements = nodeType.manifest.capabilities ?? [];
      if (requirements.length === 0) continue;
      // 当前正式能力节点只有文本生成；资源绑定规则属于应用层，不按 UI 控件推断。
      if (node.type !== 'ai.text_generate')
        throw new BadRequestException({
          code: 'WORKFLOW_CAPABILITY_BINDING_UNSUPPORTED',
          message: '节点能力绑定尚不支持发布',
        });
      const { modelConfigurationId } = textGenerationConfigSchema.parse(config);
      for (const capability of requirements)
        await models.assertPublishableConfiguration(
          tx,
          ownerId,
          modelConfigurationId,
          capability.type,
        );
    }
    // 完整静态校验与后代资源授权后，仍必须通过当前 Compiler 执行门禁。
    assertGraphExecutionCapabilities(snapshot, registry);
  } catch (error) {
    if (error instanceof WorkflowPublishValidationError) {
      if (error.code === 'NODE_CONFIG_INVALID')
        throw new BadRequestException({
          code: 'WORKFLOW_NODE_CONFIGURATION_INVALID',
          message: '工作流节点配置无效',
        });
      throw new BadRequestException({
        code: 'WORKFLOW_PUBLISH_VALIDATION_FAILED',
        message: error.message,
        issues: [
          {
            code: error.code,
            nodeId: error.nodeId,
            ...(error.portKey === undefined ? {} : { portKey: error.portKey }),
          },
        ],
      });
    }
    if (error instanceof ModelConfigurationError)
      throw new BadRequestException({
        code: error.code,
        message: '发布所选模型配置无效或不可用',
      });
    throw error;
  }
}
