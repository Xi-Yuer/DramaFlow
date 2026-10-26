'use client';
import { useRef, useState } from 'react';
import { Alert, Button, Modal } from 'antd';
import type { ModelProvider, ProviderCatalogItem } from '@dramaflow/contracts';
import { modelApi } from '../model-api';
import { CredentialInputs, validateCredentials } from '../shared/schema-form';
import { failure } from './provider-form-helpers';

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
