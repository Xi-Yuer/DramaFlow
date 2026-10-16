'use client';

import { FormField } from './form-field';
import { JsonEditor } from './json-editor';

export type FormSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, FormSchema>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: FormSchema;
  additionalProperties?: boolean | FormSchema;
};

const fieldLabels: Record<string, string> = {
  prompt: '生成需求',
  systemPrompt: '系统提示词',
  operator: '判断方式',
  expected: '比较值',
  mode: '汇合方式',
  capability: '生成能力',
  maxConcurrency: '最大并发',
  maxItems: '最大条目数',
  baseUrl: 'API 地址',
  contextWindow: '上下文窗口（tokens）',
  maxOutputTokens: '最大输出（tokens）',
  temperature: '随机程度',
  size: '图片尺寸',
  quality: '图片质量',
  n: '图片数量',
  responseFormat: '响应格式',
};
const enumLabels: Record<string, string> = {
  equals: '等于',
  notEquals: '不等于',
  contains: '包含',
  greaterThan: '大于',
  lessThan: '小于',
  isTruthy: '为真值',
  selected: '选择可用分支',
  collect: '收集可用结果',
  'text.generate': '文本生成',
  'image.generate': '图片生成',
};

export function SchemaForm({
  schema,
  value,
  onChange,
  disabled = false,
}: {
  schema: FormSchema;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const properties = Object.entries(schema.properties ?? {});
  if (!properties.length) return <p className="field-hint">该能力没有额外参数。</p>;
  return (
    <div className="schema-form">
      {properties.map(([name, field]) => {
        const current = value[name];
        const label = `${field.title ?? fieldLabels[name] ?? name}${schema.required?.includes(name) ? ' *' : ''}`;
        const set = (next: unknown) => {
          const changed = { ...value };
          if (next === undefined) delete changed[name];
          else changed[name] = next;
          onChange(changed);
        };
        if (field.enum)
          return (
            <FormField key={name} label={label} hint={field.description}>
              <select
                disabled={disabled}
                value={current === undefined ? '' : JSON.stringify(current)}
                onChange={(event) =>
                  set(event.target.value ? (JSON.parse(event.target.value) as unknown) : undefined)
                }
              >
                <option value="">
                  使用默认值
                  {field.default === undefined
                    ? ''
                    : ` · ${enumLabels[String(field.default)] ?? String(field.default)}`}
                </option>
                {field.enum.map((option) => (
                  <option key={JSON.stringify(option)} value={JSON.stringify(option)}>
                    {enumLabels[String(option)] ?? String(option)}
                  </option>
                ))}
              </select>
            </FormField>
          );
        if (field.type === 'boolean')
          return (
            <label className="check-field" key={name}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={current === true}
                onChange={(event) => set(event.target.checked)}
              />
              <span>
                {label}
                {field.description && <small>{field.description}</small>}
              </span>
            </label>
          );
        if (field.type === 'object' || field.type === 'array' || !field.type)
          return (
            <JsonEditor
              key={name}
              label={label}
              hint={field.description}
              value={current ?? (field.type === 'array' ? [] : field.type === 'object' ? {} : null)}
              onChange={set}
              disabled={disabled}
            />
          );
        if (field.type === 'string' && /prompt|description|instruction/i.test(name))
          return (
            <FormField key={name} label={label} hint={field.description}>
              <textarea
                rows={4}
                disabled={disabled}
                value={typeof current === 'string' ? current : ''}
                placeholder={
                  field.default === undefined ? '填写本节点的具体要求…' : String(field.default)
                }
                onChange={(event) => set(event.target.value)}
              />
            </FormField>
          );
        return (
          <FormField key={name} label={label} hint={field.description}>
            <input
              disabled={disabled}
              type={field.type === 'integer' || field.type === 'number' ? 'number' : 'text'}
              min={field.minimum}
              max={field.maximum}
              step={field.type === 'integer' ? 1 : undefined}
              value={typeof current === 'string' || typeof current === 'number' ? current : ''}
              placeholder={field.default === undefined ? '可选参数' : String(field.default)}
              onChange={(event) =>
                set(
                  field.type === 'integer' || field.type === 'number'
                    ? event.target.value === ''
                      ? undefined
                      : Number(event.target.value)
                    : event.target.value,
                )
              }
            />
          </FormField>
        );
      })}
    </div>
  );
}

/** 平台 JSON Schema 到表单描述的边界适配；未知扩展由服务端继续校验。 */
export function toFormSchema(value: unknown): FormSchema {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const result: FormSchema = {};
  if (typeof record.type === 'string') result.type = record.type;
  if (typeof record.title === 'string') result.title = record.title;
  if (typeof record.description === 'string') result.description = record.description;
  if (Array.isArray(record.enum)) result.enum = record.enum;
  if (Array.isArray(record.required))
    result.required = record.required.filter((entry): entry is string => typeof entry === 'string');
  if (typeof record.minimum === 'number') result.minimum = record.minimum;
  if (typeof record.maximum === 'number') result.maximum = record.maximum;
  if (record.default !== undefined) result.default = record.default;
  if (
    typeof record.properties === 'object' &&
    record.properties !== null &&
    !Array.isArray(record.properties)
  )
    result.properties = Object.fromEntries(
      Object.entries(record.properties).map(([name, property]) => [name, toFormSchema(property)]),
    );
  if (record.items) result.items = toFormSchema(record.items);
  return result;
}
