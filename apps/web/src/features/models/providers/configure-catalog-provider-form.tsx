'use client';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { Alert, Button, Form, Modal } from 'antd';
import {
  createUserCatalogProviderRequestSchema,
  type ModelProvider,
  type ProviderCatalogItem,
} from '@dramaflow/contracts';
import { modelApi } from '../model-api';
import { trySchemaFields } from '../shared/schema-fields';
import { CredentialInputs, SchemaFormFields, validateCredentials } from '../shared/schema-form';
import { blankConfiguration, failure, credentialSubmitLabel } from './provider-form-helpers';

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
