import {
  BooleanType,
  NumberType,
  StringType,
  workflowDefinitionSchema,
  type DataType,
  type RuntimeValue,
  type WorkflowInputDefinition,
} from '@dramaflow/contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  DataTypeRegistry,
  WorkflowInvocationContractValidator,
  WorkflowInvocationValidationError,
} from '../../src/index.js';

const nullableString: DataType = {
  kind: 'union',
  types: [StringType, { kind: 'primitive', name: 'null' }],
};
const character: DataType = { kind: 'named', name: 'story.character' };
const inline = (type: DataType, value: z.JSONType): RuntimeValue => ({
  storage: 'inline',
  type,
  value,
});
const contract = (type: DataType = StringType, required = true): WorkflowInputDefinition[] => [
  { name: 'content', type, required },
];
const validator = new WorkflowInvocationContractValidator();

describe('Workflow Invocation Contract Validator', () => {
  it('required missing 拒绝，optional missing 保持缺失且不补默认值', () => {
    expect(() => validator.validate(contract(), {})).toThrow(
      expect.objectContaining({
        code: 'WORKFLOW_INVOCATION_INPUT_REQUIRED',
        inputName: 'content',
      }),
    );
    expect(validator.validate(contract(StringType, false), {})).toEqual({});
  });

  it('未知输入拒绝，错误不包含输入内容', () => {
    try {
      validator.validate([], { unknown: inline(StringType, 'private-input-body') });
      expect.fail('应拒绝未知输入');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowInvocationValidationError);
      expect(error).toMatchObject({
        code: 'WORKFLOW_INVOCATION_INPUT_UNKNOWN',
        inputName: 'unknown',
      });
      expect(JSON.stringify(error)).not.toContain('private-input-body');
    }
  });

  it('类型不兼容先报 TYPE_MISMATCH，不混同实际值错误', () => {
    expect(() =>
      validator.validate(contract(), { content: inline(NumberType, '错误内容') }),
    ).toThrow(expect.objectContaining({ code: 'WORKFLOW_INVOCATION_INPUT_TYPE_MISMATCH' }));
  });

  it('标签兼容但实际值错误报 VALUE_INVALID，声明 any 也不能掩盖伪造标签', () => {
    for (const type of [StringType, { kind: 'any' } as const, nullableString]) {
      expect(() =>
        validator.validate(contract(type), { content: inline(StringType, 123) }),
      ).toThrow(
        expect.objectContaining({
          code: 'WORKFLOW_INVOCATION_INPUT_VALUE_INVALID',
          inputName: 'content',
        }),
      );
    }
  });

  it.each([
    [BooleanType, false],
    [NumberType, 0],
    [StringType, ''],
  ] as const)('值 %s / %s 视为已提供', (type, value) => {
    const inputs = { content: inline(type, value) };
    expect(validator.validate(contract(type), inputs)).toEqual(inputs);
  });

  it.each([true, false])('nullable 与 optional 独立：required=%s', (required) => {
    const inputs = { content: inline({ kind: 'primitive', name: 'null' }, null) };
    expect(validator.validate(contract(nullableString, required), inputs)).toEqual(inputs);
    expect(() => validator.validate(contract(StringType, required), inputs)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_INVOCATION_INPUT_TYPE_MISMATCH' }),
    );
    expect(() =>
      validator.validate(contract(StringType, required), { content: inline(StringType, null) }),
    ).toThrow(expect.objectContaining({ code: 'WORKFLOW_INVOCATION_INPUT_VALUE_INVALID' }));
  });

  it('required nullable 缺少 key 仍拒绝', () => {
    expect(() => validator.validate(contract(nullableString), {})).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_INVOCATION_INPUT_REQUIRED' }),
    );
  });

  it('继承属性不满足 required，undefined 和非 RuntimeValue 也不合法', () => {
    const inputs: Record<string, RuntimeValue> = {};
    Object.setPrototypeOf(inputs, { content: inline(StringType, '继承') });
    expect(() => validator.validate(contract(), inputs)).toThrow();
    for (const content of [
      undefined,
      null,
      'raw',
      { storage: 'inline', type: StringType, value: new Date() },
    ]) {
      expect(() => validator.validate(contract(), { content })).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_INVOCATION_INPUTS_INVALID' }),
      );
    }
  });

  it('递归校验 array/object/union，保留结构兼容允许的额外字段且不修改原输入', () => {
    const type: DataType = {
      kind: 'object',
      properties: {
        lines: { kind: 'array', itemType: StringType },
        note: nullableString,
      },
    };
    const inputs = { content: inline(type, { lines: ['第一句'], note: null, extra: '保留' }) };
    const result = validator.validate(contract(type), inputs);
    expect(result).toEqual(inputs);
    expect(result).not.toBe(inputs);
    if (
      result.content?.storage === 'inline' &&
      typeof result.content.value === 'object' &&
      result.content.value !== null &&
      !Array.isArray(result.content.value)
    ) {
      result.content.value.extra = '改动';
    }
    expect(inputs.content).toEqual(inline(type, { lines: ['第一句'], note: null, extra: '保留' }));
    const invalidValues: z.JSONType[] = [{ lines: [1], note: null }, { lines: [] }];
    for (const value of invalidValues) {
      expect(() => validator.validate(contract(type), { content: inline(type, value) })).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_INVOCATION_INPUT_VALUE_INVALID' }),
      );
    }
  });

  it.each(['artifact', 'asset'] as const)(
    'reference %s 仅检查类型，不读取资源或要求 named Schema',
    (kind) => {
      const inputs: Record<string, RuntimeValue> = {
        content: {
          storage: 'reference',
          type: character,
          reference:
            kind === 'artifact'
              ? { kind, id: 'not-a-real-resource' }
              : { kind, id: 'not-a-real-resource', versionId: 'v1' },
        },
      };
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不能访问外部资源'));
      try {
        expect(validator.validate(contract(character), inputs)).toEqual(inputs);
        expect(() => validator.validate(contract(StringType), inputs)).toThrow(
          expect.objectContaining({ code: 'WORKFLOW_INVOCATION_INPUT_TYPE_MISMATCH' }),
        );
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    },
  );

  it('未注册 named inline 及嵌套 named 不猜测结构，any 目标也不降级', () => {
    for (const type of [character, { kind: 'array', itemType: character } as const]) {
      for (const target of [type, { kind: 'any' } as const]) {
        expect(() => validator.validate(contract(target), { content: inline(type, []) })).toThrow(
          expect.objectContaining({
            code: 'WORKFLOW_INVOCATION_TYPE_SCHEMA_UNAVAILABLE',
            dataTypeName: 'story.character',
          }),
        );
      }
    }
  });

  it('注册真实 named Schema 后可校验业务结构；Schema 默认/变换结果不回写', () => {
    const registry = new DataTypeRegistry();
    registry.register({
      manifest: {
        name: 'story.character',
        displayName: '角色',
        category: 'story',
        storage: 'auto',
      },
      schema: z
        .object({ name: z.string(), note: z.string().default('内部默认') })
        .transform((value) => ({ ...value, name: value.name.toUpperCase() })),
    });
    const registered = new WorkflowInvocationContractValidator(registry);
    const inputs = { content: inline(character, { name: 'alice' }) };
    expect(registered.validate(contract(character), inputs)).toEqual(inputs);
    expect(() =>
      registered.validate(contract(character), { content: inline(character, { name: 123 }) }),
    ).toThrow(expect.objectContaining({ code: 'WORKFLOW_INVOCATION_INPUT_VALUE_INVALID' }));
  });

  it('历史 definition.required 缺省为 true，缺失调用仍拒绝，不回写旧定义', () => {
    const legacy = {
      inputs: [{ name: 'content', type: StringType }],
      nodes: [],
      edges: [],
      outputs: [],
    };
    const definition = workflowDefinitionSchema.parse(legacy);
    expect(() => validator.validate(definition.inputs, {})).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_INVOCATION_INPUT_REQUIRED' }),
    );
    expect(legacy.inputs[0]).not.toHaveProperty('required');
  });

  it('重复输入契约作为契约错误拒绝，不覆盖前一条声明', () => {
    expect(() => validator.validate([...contract(), ...contract()], {})).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_INVOCATION_CONTRACT_INVALID' }),
    );
  });
});
