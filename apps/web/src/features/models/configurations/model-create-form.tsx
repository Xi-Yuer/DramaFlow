'use client';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { Alert, Button, Form, Input, Modal, Select } from 'antd';
import {
  createModelConfigurationSchema,
  type ModelProvider,
  type ProviderPluginDescription,
  type ManagedModelConfiguration,
} from '@dramaflow/contracts';
import { modelApi } from '../model-api';
import { trySchemaFields } from '../shared/schema-fields';
import { SchemaFormFields } from '../shared/schema-form';
import { findPlugin, failure } from '../providers/provider-form-helpers';

export function ModelCreateForm({
  providers,
  plugins,
  initialProviderId,
  onClose,
  onCreated,
}: {
  providers: ModelProvider[];
  plugins: ProviderPluginDescription[];
  initialProviderId?: string;
  onClose: () => void;
  onCreated: (model: ManagedModelConfiguration) => void;
}) {
  const [form] = Form.useForm();
  const [providerId, setProviderId] = useState(initialProviderId);
  const [capability, setCapability] = useState<string>();
  const provider = providers.find((item) => item.id === providerId);
  const plugin = findPlugin(plugins, provider);
  const selected = plugin?.capabilities.find((item) => item.type === capability);
  const compiled = selected ? trySchemaFields(selected.modelSettingsSchema) : null;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  async function submit() {
    if (lock.current || !provider?.enabled || !selected || !compiled?.form) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    let sent = false;
    try {
      const values: unknown = await form.validateFields();
      const input = z
        .object({ model: createModelConfigurationSchema.shape.model, settings: z.unknown() })
        .parse(values);
      const settings = compiled.form.validate(input.settings);
      sent = true;
      onCreated(
        await modelApi.createModel({
          providerId: provider.id,
          capability: selected.type,
          model: input.model,
          settings,
        }),
      );
    } catch (error) {
      setError(sent ? `${failure(error)}。请刷新列表核对后再提交。` : '请检查模型名称和参数');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title="添加模型"
      onCancel={onClose}
      closable={!busy}
      maskClosable={false}
      keyboard={!busy}
      footer={[
        <Button key="cancel" disabled={busy} onClick={onClose}>
          返回列表
        </Button>,
        <Button
          key="submit"
          aria-label="添加模型"
          type="primary"
          loading={busy}
          disabled={busy || !compiled?.form || !provider?.enabled}
          onClick={() => void submit()}
        >
          添加模型
        </Button>,
      ]}
    >
      <p className="model-form-copy">
        同一供应商可以添加多个模型，也可以为同一模型保存不同参数。模型和参数保存后固定，需要调整时添加新配置。
      </p>
      <Form form={form} layout="vertical" requiredMark="optional" disabled={busy} preserve={false}>
        <Form.Item label="模型供应商" required>
          <Select
            virtual={false}
            aria-label="模型供应商"
            placeholder="选择已启用的供应商"
            value={providerId}
            options={providers.map((item) => ({
              value: item.id,
              label: item.enabled ? item.name : `${item.name}（已停用）`,
              disabled: !item.enabled || !findPlugin(plugins, item),
            }))}
            onChange={(value) => {
              setProviderId(value);
              setCapability(undefined);
              setError(null);
              form.setFieldValue('settings', {});
            }}
          />
        </Form.Item>
        <Form.Item label="模型能力" required>
          <Select
            virtual={false}
            aria-label="模型能力"
            placeholder="选择模型能力"
            value={capability}
            disabled={!plugin || busy}
            options={plugin?.capabilities.map((item) => ({
              value: item.type,
              label: `${item.name}（${item.type}）`,
            }))}
            onChange={(value) => {
              setCapability(value);
              setError(null);
              const next = plugin?.capabilities.find((item) => item.type === value);
              form.setFieldValue(
                'settings',
                next ? (trySchemaFields(next.modelSettingsSchema).form?.defaults ?? {}) : {},
              );
            }}
          />
        </Form.Item>
        <Form.Item
          name="model"
          label="模型名称"
          required
          extra="填写该供应商提供的准确模型名称，不会自动拉取模型列表。"
          rules={[
            {
              validator: async (_, value: unknown) => {
                if (!createModelConfigurationSchema.shape.model.safeParse(value).success)
                  throw new Error('请填写 1～200 个字符的模型名称');
              },
            },
          ]}
        >
          <Input maxLength={200} placeholder="填写服务所接受的模型名称" />
        </Form.Item>
        {compiled?.error ? <Alert type="error" showIcon title={compiled.error} /> : null}
        {compiled?.form ? (
          <SchemaFormFields
            key={`${providerId}-${capability}`}
            schema={compiled.form}
            group="settings"
            disabled={busy}
          />
        ) : null}
      </Form>
      {error ? <Alert showIcon type="error" title="模型未确认保存" description={error} /> : null}
    </Modal>
  );
}
