import {
  isTypeAssignable,
  runtimeValueMapSchema,
  workflowInputDefinitionSchema,
  type DataType,
  type RuntimeValue,
  type WorkflowInputDefinition,
} from '@dramaflow/contracts';
import { z } from 'zod';
import { DataTypeRegistry, DataTypeSchemaUnavailableError } from '../data/registry.js';

const messages = {
  WORKFLOW_INVOCATION_CONTRACT_INVALID: '工作流调用契约无效',
  WORKFLOW_INVOCATION_INPUTS_INVALID: '工作流调用输入结构无效',
  WORKFLOW_INVOCATION_INPUT_REQUIRED: '缺少必填工作流输入',
  WORKFLOW_INVOCATION_INPUT_UNKNOWN: '调用包含未声明的工作流输入',
  WORKFLOW_INVOCATION_INPUT_TYPE_MISMATCH: '工作流输入的运行值类型与声明不兼容',
  WORKFLOW_INVOCATION_INPUT_VALUE_INVALID: '工作流输入的内联内容不符合类型契约',
  WORKFLOW_INVOCATION_TYPE_SCHEMA_UNAVAILABLE: '工作流输入的数据类型校验 Schema 不可用',
} as const;

export type WorkflowInvocationValidationCode = keyof typeof messages;

// 只携带稳定码和定位，不保存输入值、Zod issues 或原始 cause。
export class WorkflowInvocationValidationError extends Error {
  constructor(
    readonly code: WorkflowInvocationValidationCode,
    readonly inputName?: string,
    readonly dataTypeName?: string,
  ) {
    super(messages[code]);
    this.name = 'WorkflowInvocationValidationError';
  }
}

const definitionsSchema = z.array(workflowInputDefinitionSchema).superRefine((inputs, context) => {
  const names = new Set<string>();
  for (const input of inputs) {
    if (names.has(input.name)) context.addIssue({ code: 'custom', message: '输入名称重复' });
    names.add(input.name);
  }
});

// 纯领域校验：所有调用入口复用同一版本契约；不解析引用、不应用业务默认值。
export class WorkflowInvocationContractValidator {
  constructor(private readonly dataTypes: DataTypeRegistry = new DataTypeRegistry()) {}

  validate(
    definitionInputs: readonly WorkflowInputDefinition[],
    invocationInputs: unknown,
  ): Record<string, RuntimeValue> {
    const definitions = definitionsSchema.safeParse(definitionInputs);
    if (!definitions.success)
      throw new WorkflowInvocationValidationError('WORKFLOW_INVOCATION_CONTRACT_INVALID');
    const invocation = runtimeValueMapSchema.safeParse(invocationInputs);
    if (!invocation.success)
      throw new WorkflowInvocationValidationError('WORKFLOW_INVOCATION_INPUTS_INVALID');
    const inputs = invocation.data;
    const declared = new Set(definitions.data.map((input) => input.name));
    for (const input of definitions.data) {
      if (input.required && !Object.hasOwn(inputs, input.name))
        throw new WorkflowInvocationValidationError(
          'WORKFLOW_INVOCATION_INPUT_REQUIRED',
          input.name,
        );
    }
    for (const name of Object.keys(inputs)) {
      if (!declared.has(name))
        throw new WorkflowInvocationValidationError('WORKFLOW_INVOCATION_INPUT_UNKNOWN', name);
    }
    for (const input of definitions.data) {
      if (!Object.hasOwn(inputs, input.name)) continue;
      if (!isTypeAssignable(inputs[input.name]!.type, input.type))
        throw new WorkflowInvocationValidationError(
          'WORKFLOW_INVOCATION_INPUT_TYPE_MISMATCH',
          input.name,
        );
    }
    for (const input of definitions.data) {
      if (!Object.hasOwn(inputs, input.name)) continue;
      const value = inputs[input.name]!;
      if (value.storage === 'reference') continue;
      // 也验证来源标签，防止声明为 any / 宽 union 时掩盖伪造的具体类型标签。
      this.validateInline(value.type, value.value, input.name);
      this.validateInline(input.type, value.value, input.name);
    }
    return inputs;
  }

  private validateInline(type: DataType, value: unknown, inputName: string): void {
    let schema: z.ZodType;
    try {
      schema = this.dataTypes.schemaFor(type);
    } catch (error) {
      if (error instanceof DataTypeSchemaUnavailableError)
        throw new WorkflowInvocationValidationError(
          'WORKFLOW_INVOCATION_TYPE_SCHEMA_UNAVAILABLE',
          inputName,
          error.typeName,
        );
      throw error;
    }
    if (!schema.safeParse(value).success)
      throw new WorkflowInvocationValidationError(
        'WORKFLOW_INVOCATION_INPUT_VALUE_INVALID',
        inputName,
      );
    // 不使用 Schema 变换结果回写输入；受信任 Schema 仅用于判断合法性。
  }
}
