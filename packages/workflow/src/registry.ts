import { z } from 'zod';
import {
  nodeDefinitionSchema,
  stepConfigSchema,
  startNodeConfigSchema,
  textNodeConfigSchema,
  characterNodeConfigSchema,
  imageNodeConfigSchema,
  modelNodeConfigSchema,
  foundationNodeDefinitions,
  validateWorkflow,
  type NodeDefinition,
  type WorkflowDefinition,
  type WorkflowNode,
  type JsonObject,
} from '@dramaflow/contracts';
import type { RunnableConfig } from '@langchain/core/runnables';

export type NodeExecutionInput = {
  node: WorkflowNode;
  inputs: JsonObject;
};
export type NodeExecutor = (
  input: NodeExecutionInput,
  config: RunnableConfig,
) => Promise<JsonObject>;
export type NodeRegistration = {
  definition: NodeDefinition;
  config: z.ZodType<JsonObject>;
  executor?: NodeExecutor;
};
/** 只保存服务端受信任的注册项；客户端不能上传执行代码。 */
export class NodeRegistry {
  private readonly registrations = new Map<string, NodeRegistration>();
  register(registration: NodeRegistration): this {
    const definition = nodeDefinitionSchema.parse(registration.definition);
    const key = `${definition.type}@${definition.version}`;
    if (this.registrations.has(key)) throw new Error(`重复注册节点：${key}`);
    if (definition.executable !== Boolean(registration.executor))
      throw new Error(`节点执行声明与执行器不一致：${key}`);
    registration.config.parse(definition.defaultConfig);
    this.registrations.set(key, { ...registration, definition });
    return this;
  }
  catalog(): NodeDefinition[] {
    return structuredClone([...this.registrations.values()].map((r) => r.definition));
  }
  get(node: Pick<WorkflowNode, 'type' | 'version'>): NodeRegistration {
    const registration = this.registrations.get(`${node.type}@${node.version}`);
    if (!registration) throw new Error(`节点类型或版本未安装：${node.type}@${node.version}`);
    return registration;
  }
  validate(definition: WorkflowDefinition) {
    const issues = validateWorkflow(definition, this.catalog());
    for (const node of definition.nodes) {
      const registration = this.registrations.get(`${node.type}@${node.version}`);
      if (registration && !registration.config.safeParse(node.config).success)
        issues.push({
          code: 'invalid_config',
          message: '节点配置不符合已安装版本的协议',
          nodeId: node.id,
        });
    }
    return issues;
  }
}
const nodeConfigs = {
  'core.step@1': stepConfigSchema,
  'drama.start@1': startNodeConfigSchema,
  'drama.text@1': textNodeConfigSchema,
  'drama.character@1': characterNodeConfigSchema,
  'drama.image@1': imageNodeConfigSchema,
  'drama.llm@1': modelNodeConfigSchema,
  'drama.image-gen@1': modelNodeConfigSchema,
  'drama.video-gen@1': modelNodeConfigSchema,
};
export function createFoundationRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  for (const definition of foundationNodeDefinitions) {
    const config =
      nodeConfigs[`${definition.type}@${definition.version}` as keyof typeof nodeConfigs];
    if (!config) throw new Error(`节点缺少配置协议：${definition.type}`);
    registry.register({ definition, config });
  }
  return registry;
}
