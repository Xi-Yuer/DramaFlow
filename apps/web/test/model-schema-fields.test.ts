import { describe, expect, it } from 'vitest';
import { compileSchemaFields, trySchemaFields } from '../src/features/models/schema-fields';

const schema = () => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['endpoint'],
  properties: {
    endpoint: { type: 'string', format: 'uri', maxLength: 100, title: '服务地址' },
    timeout: { type: 'integer', minimum: 100, maximum: 180000, default: 60000 },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    enabled: { type: 'boolean' },
    mode: { type: 'string', enum: ['short', 'long'] },
  },
});
describe('模型管理公开 Schema 的表单适配', () => {
  it('自定义字段来自 Schema 而非厂商，默认值、可选字段及 0 / false 完整保留', () => {
    const compiled = compileSchemaFields(schema());
    expect(compiled.fields[0]).toMatchObject({
      key: 'endpoint',
      label: '服务地址',
      required: true,
    });
    expect(compiled.defaults).toEqual({ timeout: 60000 });
    expect(
      compiled.validate({
        endpoint: 'https://custom.example/v1',
        temperature: 0,
        enabled: false,
        mode: '',
      }),
    ).toEqual({
      endpoint: 'https://custom.example/v1',
      timeout: 60000,
      temperature: 0,
      enabled: false,
    });
    expect(
      compiled.validate({
        endpoint: 'http://localhost:8080',
        timeout: null,
        temperature: undefined,
      }),
    ).toEqual({ endpoint: 'http://localhost:8080', timeout: 60000 });
  });
  it.each([
    {},
    { endpoint: 'bad URL' },
    { endpoint: 'https://a.test', timeout: 1 },
    { endpoint: 'https://a.test', timeout: 100.5 },
    { endpoint: 'https://a.test', temperature: 3 },
    { endpoint: 'https://a.test', mode: 'unknown' },
    { endpoint: 'https://a.test', extra: 'not declared' },
  ])('使用 Schema 校验必填、格式、范围、整数、枚举及未知字段：%j', (values) => {
    expect(() => compileSchemaFields(schema()).validate(values)).toThrow();
  });
  it.each([
    { ...schema(), allOf: [] },
    { ...schema(), properties: { nested: { type: 'object', properties: {} } } },
    { ...schema(), properties: { list: { type: 'array', items: { type: 'string' } } } },
    { ...schema(), required: ['missing'] },
    { ...schema(), properties: { unsupported: { type: 'string', unknownConstraint: true } } },
    { ...schema(), properties: JSON.parse('{"__proto__":{"type":"string"}}') as unknown },
  ])('不支持的结构或约束拒绝呈现与提交，不静默过滤：%j', (schema) => {
    expect(trySchemaFields(schema).form).toBeNull();
    expect(trySchemaFields(schema).error).toContain('表单格式');
  });
});
