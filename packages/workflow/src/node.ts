import {
  edgeDefinitionSchema,
  nodeDefinitionSchema,
  nodePresetSchema,
  workflowIdentifierSchema,
  type InputBinding,
  type NodeDefinition,
} from '@dramaflow/contracts';
import { z } from 'zod';

// 执行侧的有效契约。相同 Runtime type 可以为不同 Preset 提供不同输入输出 Schema。
// 不包含执行器、插件适配器或可传往浏览器的服务端实例。
export interface NodeTypeDefinition<
  InputSchema extends z.ZodObject = z.ZodObject,
  OutputSchema extends z.ZodObject = z.ZodObject,
  ConfigSchema extends z.ZodObject = z.ZodObject,
> {
  type: string;
  preset?: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  configSchema: ConfigSchema;
}

export type NodeExecutor<Inputs, Config> = (parameters: {
  inputs: Inputs;
  config: Config;
}) => unknown | Promise<unknown>;

export class NodeContractError extends Error {
  constructor(
    public readonly code: 'contract_mismatch' | 'unknown_input' | 'preset_mismatch',
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

function validateContractIdentity(contract: NodeTypeDefinition): void {
  workflowIdentifierSchema.parse(contract.type);
  if (contract.preset !== undefined) workflowIdentifierSchema.parse(contract.preset);
}

export function parseNodeDefinition(contract: NodeTypeDefinition, input: unknown): NodeDefinition {
  validateContractIdentity(contract);
  const node = nodeDefinitionSchema.parse(input);
  if (node.type !== contract.type || node.preset !== contract.preset) {
    throw new NodeContractError('contract_mismatch', '节点与所选类型 / Preset 契约不匹配');
  }
  for (const binding of node.inputs) {
    if (!Object.hasOwn(contract.inputSchema.shape, binding.target)) {
      throw new NodeContractError('unknown_input', `节点绑定了未声明的输入端口：${binding.target}`);
    }
  }
  const config = parseRecord(contract.configSchema, node.config);
  return { ...node, config: nodeDefinitionSchema.shape.config.parse(config) };
}

// 显式应用已选择的 Preset；实例配置覆盖 Preset 配置，不选择厂商或执行任务。
export function applyNodePreset(
  contract: NodeTypeDefinition,
  input: unknown,
  presetInput: unknown,
): NodeDefinition {
  const node = nodeDefinitionSchema.parse(input);
  const preset = nodePresetSchema.parse(presetInput);
  if (node.type !== preset.type || contract.type !== preset.type || contract.preset !== preset.id) {
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

// 单次调用边界，不调度图、不解析上游、不更新 NodeRun，不内置任何外部能力。
export async function executeNode<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodObject,
  ConfigSchema extends z.ZodObject,
>(
  contract: NodeTypeDefinition<InputSchema, OutputSchema, ConfigSchema>,
  parameters: unknown,
  executor: NodeExecutor<z.output<InputSchema>, z.output<ConfigSchema>>,
): Promise<z.output<OutputSchema>> {
  validateContractIdentity(contract);
  const values = z.object({ inputs: z.json(), config: z.json() }).strict().parse(parameters);
  const inputs = parseRecord(contract.inputSchema, values.inputs);
  const config = parseRecord(contract.configSchema, values.config);
  const result = await executor({ inputs, config });
  return parseRecord(contract.outputSchema, result);
}
