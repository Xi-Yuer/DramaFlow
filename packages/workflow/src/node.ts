import {
  edgeDefinitionSchema,
  nodeDefinitionSchema,
  nodePresetSchema,
  nodeTypeIdSchema,
  nodeTypeVersionSchema,
  workflowIdentifierSchema,
  type InputBinding,
  type NodeDefinition,
} from '@dramaflow/contracts';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';

// 执行侧的有效契约。相同 Runtime type 可以为不同 Preset 提供不同输入输出 Schema。
// 不包含执行器、插件适配器或可传往浏览器的服务端实例。
export interface NodeContract<
  InputSchema extends z.ZodObject = z.ZodObject,
  OutputSchema extends z.ZodObject = z.ZodObject,
  ConfigSchema extends z.ZodObject = z.ZodObject,
> {
  type: string;
  version: number;
  preset?: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  configSchema: ConfigSchema;
}

export type NodeOperation<Inputs, Config> = (
  parameters: { inputs: Inputs; config: Config },
  runnableConfig?: RunnableConfig,
) => unknown | Promise<unknown>;

export class NodeContractError extends Error {
  constructor(
    public readonly code:
      | 'contract_mismatch'
      | 'unknown_input'
      | 'preset_mismatch'
      | 'unknown_config_field'
      | 'port_schema_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'NodeContractError';
  }
}

function parseRecord<Schema extends z.ZodObject>(schema: Schema, value: unknown): z.output<Schema> {
  const json = z.record(z.string(), z.json()).parse(value);
  // strict 仅改变额外字段的处理策略，保留字段类型、转换和已有对象校验。
  const strict = schema.strict() as Schema;
  const parsed = strict.parse(json);
  z.record(z.string(), z.json()).parse(parsed);
  return structuredClone(parsed);
}

function validateContractIdentity(contract: NodeContract): void {
  nodeTypeIdSchema.parse(contract.type);
  nodeTypeVersionSchema.parse(contract.version);
  if (contract.preset !== undefined) workflowIdentifierSchema.parse(contract.preset);
}

export function parseNodeDefinition(contract: NodeContract, input: unknown): NodeDefinition {
  validateContractIdentity(contract);
  const node = nodeDefinitionSchema.parse(input);
  if (
    node.type !== contract.type ||
    node.typeVersion !== contract.version ||
    node.preset !== contract.preset
  ) {
    throw new NodeContractError('contract_mismatch', '节点与所选类型 / Preset 契约不匹配');
  }
  for (const binding of node.inputs) {
    if (!Object.hasOwn(contract.inputSchema.shape, binding.target)) {
      throw new NodeContractError('unknown_input', `节点绑定了未声明的输入端口：${binding.target}`);
    }
  }
  // Definition 保存 Schema 的原始输入；转换与默认值只用于验证，不回写到可再次解析的配置。
  // 真正调用时再从这份独立 JSON 配置解析，避免编译 / Preset / 调用累积 transform。
  parseRecord(contract.configSchema, node.config);
  return node;
}

// 显式应用已选择的 Preset；实例配置覆盖 Preset 配置，不选择厂商或执行任务。
export function applyNodePreset(
  contract: NodeContract,
  input: unknown,
  presetInput: unknown,
): NodeDefinition {
  const node = nodeDefinitionSchema.parse(input);
  const preset = nodePresetSchema.parse(presetInput);
  if (
    node.type !== preset.type ||
    node.typeVersion !== preset.typeVersion ||
    contract.type !== preset.type ||
    contract.version !== preset.typeVersion ||
    contract.preset !== preset.id
  ) {
    throw new NodeContractError('preset_mismatch', 'Preset 与节点类型或有效契约不匹配');
  }
  return parseNodeDefinition(contract, {
    ...node,
    preset: preset.id,
    config: { ...preset.config, ...node.config },
  });
}

export function inputBindingFromEdge(input: unknown): InputBinding {
  const edge = edgeDefinitionSchema.parse(input);
  return {
    target: edge.targetHandle,
    source: { nodeId: edge.sourceNodeId, outputKey: edge.sourceHandle },
  };
}

// Compiler 内的值操作校验工具，不是节点扩展接口或独立 Runtime。
export async function invokeNodeOperation<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodObject,
  ConfigSchema extends z.ZodObject,
>(
  contract: NodeContract<InputSchema, OutputSchema, ConfigSchema>,
  parameters: unknown,
  operation: NodeOperation<z.output<InputSchema>, z.output<ConfigSchema>>,
  runnableConfig?: RunnableConfig,
): Promise<z.output<OutputSchema>> {
  validateContractIdentity(contract);
  const values = z.object({ inputs: z.json(), config: z.json() }).strict().parse(parameters);
  const inputs = parseRecord(contract.inputSchema, values.inputs);
  const config = parseRecord(contract.configSchema, values.config);
  const result = await operation({ inputs, config }, runnableConfig);
  return parseRecord(contract.outputSchema, result);
}
