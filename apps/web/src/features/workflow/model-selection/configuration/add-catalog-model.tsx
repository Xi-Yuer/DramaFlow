'use client';
import { useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Form, Modal, Spin } from 'antd';
import { z } from 'zod';
import type { ManagedModelConfiguration, ModelProvider } from '@dramaflow/contracts';
import { ApiError } from '../../../../lib/http';
import { modelApi, modelKeys } from '../../../models/model-api';
import { SchemaFormFields } from '../../../models/schema-form';
import { trySchemaFields } from '../../../models/schema-fields';
import { failure, queryOptions } from '../selection/model-selection-resources';

export function AddCatalogModel({
  target,
  providers,
  onClose,
  onCreated,
}: {
  target: { catalogId: string; displayName: string; providerId: string; capability: string };
  providers: readonly ModelProvider[];
  onClose: () => void;
  onCreated: (model: ManagedModelConfiguration) => void;
}) {
  const plugins = useQuery({
    ...queryOptions,
    queryKey: modelKeys.catalog,
    queryFn: ({ signal }) => modelApi.catalog(signal),
  });
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const provider = providers.find((item) => item.id === target.providerId);
  const plugin = plugins.data?.items.find(
    (item) => item.id === provider?.pluginId && item.version === provider.pluginVersion,
  );
  const capability = plugin?.capabilities.find((item) => item.type === target.capability);
  const compiled = capability ? trySchemaFields(capability.modelSettingsSchema) : null;

  async function submit() {
    if (lock.current || !provider?.enabled || !compiled?.form) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    let sent = false;
    try {
      const values: unknown = await form.validateFields();
      const settings = compiled.form.validate(
        z.object({ settings: z.unknown() }).parse(values).settings,
      );
      sent = true;
      onCreated(
        await modelApi.createModel({
          providerId: provider.id,
          capability: target.capability,
          model: target.catalogId,
          settings,
        }),
      );
    } catch (error) {
      if (sent)
        setError(error instanceof ApiError ? error.message : '模型配置未确认，请刷新后核对');
      else if (!(error instanceof Object && 'errorFields' in error)) setError('请检查生成参数');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  let body: ReactNode;
  if (plugins.isPending) body = <Spin size="small" />;
  else if (plugins.isError) body = <Alert showIcon type="error" title={failure(plugins.error)} />;
  else if (!provider?.enabled) body = <Alert showIcon type="warning" title="供应商当前不可用" />;
  else if (!compiled?.form)
    body = <Alert showIcon type="error" title={compiled?.error ?? '当前无法添加该模型'} />;
  else
    body = (
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{ settings: compiled.form.defaults }}
      >
        <SchemaFormFields schema={compiled.form} group="settings" disabled={busy} />
      </Form>
    );

  return (
    <Modal
      open
      title={`添加 ${target.displayName}`}
      onCancel={onClose}
      closable={!busy}
      maskClosable={false}
      keyboard={!busy}
      destroyOnHidden
      footer={[
        <Button key="cancel" autoInsertSpace={false} disabled={busy} onClick={onClose}>
          取消
        </Button>,
        <Button
          key="submit"
          type="primary"
          aria-label="添加并选择"
          loading={busy}
          disabled={busy || !compiled?.form || !provider?.enabled}
          onClick={() => void submit()}
        >
          添加并选择
        </Button>,
      ]}
    >
      <p className="model-selector-note">
        填写该模型在我的模型配置中的生成参数。节点只保存这次选择。
      </p>
      {body}
      {error ? <Alert showIcon type="error" title="模型配置未确认" description={error} /> : null}
    </Modal>
  );
}
