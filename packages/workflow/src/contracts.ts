import {
  workflowOutputSourceSchema,
  workflowPortNameSchema,
  type WorkflowOutputSource,
  type WorkflowRunMetadata,
  type WorkflowVersionMetadata,
} from '@dramaflow/contracts';
import { z } from 'zod';

// 执行层使用的已编译值契约，不能作为包含 Zod 实例的浏览器协议传输。
export interface WorkflowInputContract {
  name: string;
  schema: z.ZodType;
}

export interface WorkflowOutputContract extends WorkflowInputContract {
  source: WorkflowOutputSource;
}

export class WorkflowContractError extends Error {
  constructor(
    public readonly code:
      'duplicate_port' | 'missing_node_result' | 'missing_node_output' | 'version_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowContractError';
  }
}

function valueSchema(contracts: readonly WorkflowInputContract[]) {
  const names = new Set<string>();
  const fields = contracts.map(({ name, schema }) => {
    workflowPortNameSchema.parse(name);
    if (names.has(name)) {
      throw new WorkflowContractError('duplicate_port', `输入输出名称重复：${name}`);
    }
    names.add(name);
    return [name, schema] as const;
  });
  return z.object(Object.fromEntries(fields)).strict();
}

export function parseWorkflowInputs(
  contracts: readonly WorkflowInputContract[],
  input: unknown,
): Record<string, z.JSONType> {
  const parsed = valueSchema(contracts).parse(input);
  return z.record(z.string(), z.json()).parse(parsed);
}

export function collectWorkflowOutputs(
  contracts: readonly WorkflowOutputContract[],
  nodeResults: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): Record<string, z.JSONType> {
  const schema = valueSchema(contracts);
  const values = contracts.map(({ name, source }) => {
    workflowOutputSourceSchema.parse(source);
    const result = nodeResults.get(source.nodeId);
    if (!result) {
      throw new WorkflowContractError('missing_node_result', `工作流输出 ${name} 缺少来源节点结果`);
    }
    if (!Object.hasOwn(result, source.outputKey)) {
      throw new WorkflowContractError('missing_node_output', `工作流输出 ${name} 缺少来源输出键`);
    }
    return [name, result[source.outputKey]];
  });
  const parsed = schema.parse(Object.fromEntries(values));
  return z.record(z.string(), z.json()).parse(parsed);
}

export function assertWorkflowRunVersion(
  run: WorkflowRunMetadata,
  version: WorkflowVersionMetadata,
): void {
  if (run.workflowVersionId !== version.id || run.workflowId !== version.workflowId) {
    throw new WorkflowContractError('version_mismatch', '运行与工作流版本不匹配');
  }
}
