'use client';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { Alert, Button, Form, Input, Modal, Select } from 'antd';
import {
  createModelProviderSchema,
  type ModelProvider,
  type ProviderPluginDescription,
} from '@dramaflow/contracts';
import { modelApi } from '../model-api';
import { trySchemaFields } from '../shared/schema-fields';
import { CredentialInputs, SchemaFormFields, validateCredentials } from '../shared/schema-form';
import { pluginKey, failure } from './provider-form-helpers';

export function ProviderCreateForm({
  plugins,
  onClose,
  onCreated,
}: {
  plugins: ProviderPluginDescription[];
  onClose: () => void;
  onCreated: (provider: ModelProvider) => void;
}) {
  const [form] = Form.useForm();
  const [selected, setSelected] = useState<string>();
  const plugin = plugins.find((item) => pluginKey(item) === selected);
  const compiled = plugin ? trySchemaFields(plugin.configurationSchema) : null;
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  async function submit() {
    if (lock.current || !plugin || !compiled?.form) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    let sent = false;
    try {
      const values: unknown = await form.validateFields();
      const input = z
        .object({ name: createModelProviderSchema.shape.name, configuration: z.unknown() })
        .parse(values);
      const configuration = compiled.form.validate(input.configuration);
      const invalid = validateCredentials(plugin.credentialFields, credentials);
      if (invalid) {
        setError(invalid);
        return;
      }
      const submitted = { ...credentials };
      setCredentials({}); // 提交即清空，失败也不恢复，不进入 Query mutation variables。
      sent = true;
      const provider = await modelApi.createProvider({
        name: input.name,
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        configuration,
        credentials: submitted,
      });
      onCreated(provider);
    } catch (error) {
      setError(
        sent
          ? `${failure(error)}。凭证已清空，请刷新列表核对后再提交。`
          : '请检查名称、服务地址和参数',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title="自定义接入"
      onCancel={onClose}
      closable={!busy}
      keyboard={!busy}
      destroyOnHidden
      footer={[
        <Button key="cancel" disabled={busy} onClick={onClose}>
          返回列表
        </Button>,
        <Button
          key="submit"
          aria-label="添加供应商"
          type="primary"
          loading={busy}
          disabled={busy || !compiled?.form}
          onClick={() => void submit()}
        >
          添加供应商
        </Button>,
      ]}
    >
      <p className="model-form-copy">
        自定义接入用于自行指定兼容服务地址。名称、接入方式和地址保存后固定，调整时请添加新供应商。
      </p>
      <Form form={form} layout="vertical" requiredMark="optional" disabled={busy} preserve={false}>
        <Form.Item
          name="name"
          label="供应商名称"
          required
          rules={[
            {
              validator: async (_, value: unknown) => {
                if (!createModelProviderSchema.shape.name.safeParse(value).success)
                  throw new Error('请填写 1～80 个字符的名称');
              },
            },
          ]}
        >
          <Input maxLength={80} placeholder="为这个服务起一个容易辨认的名称" />
        </Form.Item>
        <Form.Item label="接入方式" required>
          <Select
            virtual={false}
            aria-label="接入方式"
            placeholder="选择接入方式"
            value={selected}
            options={plugins.map((plugin) => ({
              value: pluginKey(plugin),
              label: `${plugin.name} · v${plugin.version}`,
            }))}
            onChange={(value) => {
              setSelected(value);
              setCredentials({});
              setError(null);
              const next = plugins.find((item) => pluginKey(item) === value);
              form.setFieldValue(
                'configuration',
                next ? (trySchemaFields(next.configurationSchema).form?.defaults ?? {}) : {},
              );
            }}
          />
        </Form.Item>
        {plugin ? (
          <p className="model-form-copy">
            {plugin.description} 支持：
            {plugin.capabilities.map((capability) => capability.name).join('、')}
          </p>
        ) : null}
        {compiled?.error ? <Alert showIcon type="error" title={compiled.error} /> : null}
        {compiled?.form ? (
          <SchemaFormFields
            key={selected}
            schema={compiled.form}
            group="configuration"
            disabled={busy}
          />
        ) : null}
      </Form>
      {plugin && compiled?.form ? (
        <div className="model-secret-section">
          <h3>访问凭证</h3>
          <p className="model-form-copy">
            凭证不会回显。发送保存请求或关闭后清空，保存请求失败也需要重新输入。
          </p>
          <CredentialInputs
            fields={plugin.credentialFields}
            values={credentials}
            onChange={setCredentials}
            disabled={busy}
          />
        </div>
      ) : null}
      {error ? (
        <Alert
          className="model-form-error"
          showIcon
          type="error"
          title="供应商未确认保存"
          description={error}
        />
      ) : null}
    </Modal>
  );
}
