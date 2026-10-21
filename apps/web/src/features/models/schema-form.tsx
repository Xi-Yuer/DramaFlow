'use client';
import { Form, Input, InputNumber, Select } from 'antd';
import type { InputHTMLAttributes } from 'react';
import type { ProviderPluginDescription } from '@dramaflow/contracts';
import { fieldLabel, type SchemaField, type SchemaFields } from './schema-fields';

function ScalarInput({
  field,
  value,
  onChange,
  disabled,
  ...accessibility
}: {
  field: SchemaField;
  value?: unknown;
  onChange?: (value: unknown) => void;
  disabled?: boolean;
} & Pick<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'aria-describedby' | 'aria-required' | 'aria-invalid'
>) {
  if (field.enum) {
    const index = field.enum.findIndex((item) => Object.is(item, value));
    return (
      <Select<number>
        {...accessibility}
        virtual={false}
        disabled={disabled}
        allowClear={!field.required}
        value={index >= 0 ? index : undefined}
        options={field.enum.map((item, value) => ({ value, label: String(item) }))}
        onChange={(index) => onChange?.(field.enum?.[index])}
      />
    );
  }
  if (field.type === 'boolean')
    return (
      <Select<string>
        {...accessibility}
        virtual={false}
        disabled={disabled}
        allowClear={!field.required}
        value={typeof value === 'boolean' ? String(value) : undefined}
        options={[
          { value: 'true', label: '是' },
          { value: 'false', label: '否' },
        ]}
        onChange={(next) => onChange?.(next === undefined ? undefined : next === 'true')}
      />
    );
  if (field.type === 'number' || field.type === 'integer')
    return (
      <InputNumber
        {...accessibility}
        className="model-number-input"
        disabled={disabled}
        value={typeof value === 'number' ? value : null}
        min={field.minimum}
        max={field.maximum}
        step={field.multipleOf ?? (field.type === 'integer' ? 1 : 0.1)}
        changeOnBlur={false}
        onChange={(next) => onChange?.(next ?? undefined)}
        placeholder={field.required ? '请输入' : '不设置，使用服务默认值'}
      />
    );
  return (
    <Input
      {...accessibility}
      disabled={disabled}
      value={typeof value === 'string' ? value : ''}
      maxLength={field.maxLength}
      inputMode={field.format === 'uri' ? 'url' : undefined}
      autoComplete="off"
      onChange={(event) => onChange?.(event.target.value)}
    />
  );
}
export function SchemaFormFields({
  schema,
  group,
  disabled,
}: {
  schema: SchemaFields;
  group: string;
  disabled?: boolean;
}) {
  return schema.fields.map((field) => (
    <Form.Item
      key={field.key}
      name={[group, field.key]}
      label={field.label}
      required={field.required}
      extra={field.description}
      rules={[
        {
          validator: async (_, input: unknown) => {
            const value = input === null || (!field.required && input === '') ? undefined : input;
            if (!field.validator.safeParse(value).success)
              throw new Error(`请检查${field.label}的格式和取值范围`);
          },
        },
      ]}
    >
      <ScalarInput field={field} disabled={disabled} aria-required={field.required} />
    </Form.Item>
  ));
}
export function CredentialInputs({
  fields,
  values,
  onChange,
  disabled,
}: {
  fields: ProviderPluginDescription['credentialFields'];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  disabled: boolean;
}) {
  return fields.map((field) => (
    <Form.Item key={field.key} label={fieldLabel(field.key)} required={field.required}>
      {/* 不注册到 AntD Form store，不提供已保存值或占位密文。 */}
      <Input.Password
        aria-label={fieldLabel(field.key)}
        value={values[field.key] ?? ''}
        disabled={disabled}
        autoComplete="new-password"
        visibilityToggle={false}
        spellCheck={false}
        maxLength={field.maxLength}
        onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
      />
    </Form.Item>
  ));
}
export function validateCredentials(
  fields: ProviderPluginDescription['credentialFields'],
  values: Record<string, string>,
) {
  for (const field of fields) {
    const value = values[field.key] ?? '';
    if (field.required && !value.trim()) return `请填写${fieldLabel(field.key)}`;
    if (
      value &&
      ((field.minLength !== undefined && value.trim().length < field.minLength) ||
        (field.maxLength !== undefined && value.length > field.maxLength))
    )
      return `请检查${fieldLabel(field.key)}的长度`;
  }
  return null;
}
