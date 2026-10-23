'use client';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { Alert, Button, Form, Input, Modal, Select } from 'antd';
import {
  createModelProviderSchema,
  createUserCatalogProviderRequestSchema,
  createModelConfigurationSchema,
  type ModelProvider,
  type ProviderCatalogItem,
  type ProviderPluginDescription,
  type ManagedModelConfiguration,
} from '@dramaflow/contracts';
import { modelApi } from './model-api';
import { trySchemaFields } from './schema-fields';
import { CredentialInputs, SchemaFormFields, validateCredentials } from './schema-form';

const findPlugin = (plugins: ProviderPluginDescription[], provider: ModelProvider | undefined) =>
  plugins.find(
    (plugin) => plugin.id === provider?.pluginId && plugin.version === provider.pluginVersion,
  );
export { findPlugin };
const pluginKey = (plugin: ProviderPluginDescription) =>
  JSON.stringify([plugin.id, plugin.version]);
const failure = (error: unknown) =>
  error instanceof Error ? error.message : '请求未完成，请刷新列表核对';
export function credentialSubmitLabel(
  fields: readonly { key: string }[],
  action: 'configure' | 'save',
) {
  const apiKey = fields.length === 1 && fields[0]?.key === 'apiKey';
  if (action === 'configure') return apiKey ? '配置 API Key' : '配置';
  return apiKey ? '保存 API Key' : '保存凭证';
}

function blankConfiguration(schema: unknown) {
  if (!schema || typeof schema !== 'object' || !('properties' in schema)) return true;
  const properties = schema.properties;
  return !properties || (typeof properties === 'object' && Object.keys(properties).length === 0);
}

export function ConfigureCatalogProviderForm({
  provider,
  onClose,
  onCreated,
}: {
  provider: ProviderCatalogItem;
  onClose: () => void;
  onCreated: (provider: ModelProvider) => void | Promise<void>;
}) {
  const [form] = Form.useForm();
  const compiled = trySchemaFields(provider.configurationSchema);
  const configurationError =
    !compiled.form && !blankConfiguration(provider.configurationSchema) ? compiled.error : null;
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const ready = Boolean(
    provider.available && provider.credentialFields.length && !configurationError,
  );
  const submitLabel = credentialSubmitLabel(provider.credentialFields, 'save');
  async function submit() {
    if (lock.current || !ready) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    let sent = false;
    try {
      const values: unknown = compiled.form?.fields.length ? await form.validateFields() : {};
      const name = createUserCatalogProviderRequestSchema.shape.name.parse(provider.displayName);
      const userConfiguration = compiled.form?.fields.length
        ? compiled.form.validate(
            z.object({ configuration: z.unknown() }).parse(values).configuration,
          )
        : undefined;
      const invalid = validateCredentials(provider.credentialFields, credentials);
      if (invalid) {
        setError(invalid);
        return;
      }
      const submitted = { ...credentials };
      setCredentials({});
      sent = true;
      await onCreated(
        await modelApi.createCatalogProvider({
          name,
          providerDefinitionId: provider.id,
          credentials: submitted,
          ...(userConfiguration ? { configuration: userConfiguration } : {}),
        }),
      );
    } catch (error) {
      setError(sent ? `${failure(error)}。凭证已清空，请刷新列表核对后再提交。` : '请检查访问凭证');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={`配置 ${provider.displayName}`}
      onCancel={onClose}
      closable={!busy}
      maskClosable={false}
      keyboard={!busy}
      destroyOnHidden
      footer={[
        <Button key="cancel" disabled={busy} onClick={onClose}>
          返回列表
        </Button>,
        <Button
          key="submit"
          type="primary"
          aria-label={submitLabel}
          loading={busy}
          disabled={busy || !ready}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>,
      ]}
    >
      <p className="model-form-copy">
        为 {provider.displayName} 填写访问凭证。支持：
        {provider.capabilities.map((capability) => capability.name).join('、')}。
      </p>
      {configurationError ? <Alert showIcon type="error" title={configurationError} /> : null}
      {compiled.form?.fields.length ? (
        <Form
          form={form}
          layout="vertical"
          requiredMark="optional"
          disabled={busy}
          preserve={false}
          initialValues={{ configuration: compiled.form.defaults }}
        >
          <SchemaFormFields schema={compiled.form} group="configuration" disabled={busy} />
        </Form>
      ) : null}
      {ready ? (
        <div className="model-secret-section">
          <h3>访问凭证</h3>
          <p className="model-form-copy">
            凭证不会回显。发送保存请求或关闭后清空，保存请求失败也需要重新输入。
          </p>
          <CredentialInputs
            fields={provider.credentialFields}
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
      maskClosable={false}
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

export function CredentialRotationForm({
  provider,
  fields,
  onClose,
  onRotated,
}: {
  provider: ModelProvider;
  fields: ProviderCatalogItem['credentialFields'];
  onClose: () => void;
  onRotated: () => void;
}) {
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  async function submit() {
    if (lock.current) return;
    const invalid = validateCredentials(fields, credentials);
    if (invalid) {
      setError(invalid);
      return;
    }
    const submitted = { ...credentials };
    setCredentials({});
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await modelApi.replaceCredentials(provider.id, submitted);
      onRotated();
    } catch (error) {
      setError(`${failure(error)}。输入已清空，请重新输入需要保存的完整凭证。`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title="轮换访问凭证"
      onCancel={onClose}
      closable={!busy}
      maskClosable={false}
      keyboard={!busy}
      footer={[
        <Button key="cancel" disabled={busy} onClick={onClose}>
          返回列表
        </Button>,
        <Button
          key="rotate"
          aria-label="确认轮换"
          type="primary"
          loading={busy}
          onClick={() => void submit()}
        >
          确认轮换
        </Button>,
      ]}
    >
      <p className="model-form-copy">
        为“{provider.name}”填写完整的新凭证。已保存的模型和启用状态保持不变，已保存凭证无法查看。
      </p>
      <CredentialInputs
        fields={fields}
        values={credentials}
        onChange={setCredentials}
        disabled={busy}
      />
      {error ? <Alert showIcon type="error" title="凭证轮换未确认" description={error} /> : null}
    </Modal>
  );
}

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
