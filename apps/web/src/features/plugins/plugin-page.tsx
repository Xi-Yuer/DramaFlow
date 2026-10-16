'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Spin } from 'antd';
import { Clapperboard } from 'lucide-react';
import type { CredentialField, InstallationSummary, PluginManifest } from '@dramaflow/contracts';
import { AuthBoundary } from '@/features/auth/auth-boundary';
import { AccountMenuButton } from '@/features/auth/account-menu';
import { pluginApi, pluginKeys } from './plugin-api';

export function PluginPage() {
  return <AuthBoundary>{() => <PluginBoard />}</AuthBoundary>;
}

function PluginBoard() {
  const catalog = useQuery({
    queryKey: pluginKeys.catalog,
    queryFn: pluginApi.catalog,
    staleTime: 60_000,
  });
  const installed = useQuery({
    queryKey: pluginKeys.installations,
    queryFn: pluginApi.installations,
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  if (catalog.isPending || installed.isPending)
    return (
      <PluginFrame>
        <div className="page-loading">
          <Spin />
          <span>正在读取模型插件…</span>
        </div>
      </PluginFrame>
    );
  if (catalog.error || installed.error || !catalog.data || !installed.data) {
    const message = catalog.error?.message ?? installed.error?.message ?? '无法读取模型插件';
    return (
      <PluginFrame>
        <Alert
          type="error"
          title={message}
          showIcon
          action={
            <Button
              size="small"
              onClick={() => {
                void catalog.refetch();
                void installed.refetch();
              }}
            >
              重试
            </Button>
          }
        />
      </PluginFrame>
    );
  }
  const active = catalog.data.items.find((item) => item.id === activeId) ?? null;
  return (
    <PluginFrame>
      <div className="project-heading">
        <div>
          <span className="small-kicker">MODEL PLUGINS</span>
          <h1>模型插件</h1>
          <p className="secondary-copy">
            安装厂商插件并填写密钥。需要模型的节点会选择这里的安装，密钥只保存在服务端。
          </p>
        </div>
      </div>
      <section className="plugin-section" aria-label="已安装插件">
        <h2>已安装</h2>
        {installed.data.items.length === 0 ? (
          <p className="secondary-copy">还没有安装。从下面选择一个厂商插件。</p>
        ) : (
          <div className="plugin-grid">
            {installed.data.items.map((item) => {
              const manifest = catalog.data.items.find((plugin) => plugin.id === item.pluginId);
              return manifest ? (
                <InstallationCard key={item.id} item={item} manifest={manifest} />
              ) : null;
            })}
          </div>
        )}
      </section>
      <section className="plugin-section" aria-label="可安装插件">
        <h2>系统插件</h2>
        <div className="plugin-grid">
          {catalog.data.items.map((manifest) => (
            <article key={manifest.id} className="plugin-card">
              <span className="flow-kicker">{manifest.vendor}</span>
              <h3>{manifest.title}</h3>
              <p>{manifest.description}</p>
              <span className="plugin-meta">{capabilityText(manifest)}</span>
              <Button size="small" onClick={() => setActiveId(manifest.id)}>
                安装
              </Button>
            </article>
          ))}
        </div>
      </section>
      {active ? <InstallDialog manifest={active} onClose={() => setActiveId(null)} /> : null}
    </PluginFrame>
  );
}

function PluginFrame({ children }: { children: ReactNode }) {
  return (
    <main className="account-layout">
      <header className="account-header">
        <Link href="/" className="brand">
          <span className="brand-symbol">
            <Clapperboard size={20} />
          </span>
          <span>DramaFlow</span>
        </Link>
        <span className="account-location">模型插件</span>
        <div className="account-actions">
          <Link href="/" className="header-link">
            项目
          </Link>
          <AccountMenuButton />
        </div>
      </header>
      <section className="account-space">{children}</section>
    </main>
  );
}

function capabilityText(manifest: PluginManifest) {
  const names = { text: '文本', image: '图片', video: '视频' };
  return manifest.capabilities.map((item) => names[item]).join(' · ');
}

function InstallationCard({
  item,
  manifest,
}: {
  item: InstallationSummary;
  manifest: PluginManifest;
}) {
  const { message, modal } = App.useApp();
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const remove = useMutation({
    mutationFn: () => pluginApi.remove(item.id),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: pluginKeys.installations });
      void message.success('已移除插件');
    },
    onError: (error) => void message.error(error.message),
  });
  const address = item.publicConfig.baseUrl;
  return (
    <article className="plugin-card">
      <span className="flow-kicker">{manifest.vendor}</span>
      <h3>{item.label}</h3>
      <p>
        {manifest.title}
        {address ? ` · ${address}` : ''}
      </p>
      <div className="plugin-actions">
        <Button size="small" onClick={() => setEditing(true)}>
          修改
        </Button>
        <Button
          size="small"
          danger
          loading={remove.isPending}
          onClick={() =>
            modal.confirm({
              title: `移除「${item.label}」？`,
              content: '已引用它的节点在下次保存时需要重新选择插件。',
              okText: '移除',
              cancelText: '取消',
              okButtonProps: { danger: true },
              onOk: () => remove.mutateAsync(),
            })
          }
        >
          移除
        </Button>
      </div>
      {editing ? (
        <CredentialForm
          manifest={manifest}
          initialLabel={item.label}
          submitLabel="保存修改"
          secretHint="留空则不修改"
          onCancel={() => setEditing(false)}
          onSubmit={async (label, credentials) => {
            await pluginApi.update(item.id, { label, credentials });
            await cache.invalidateQueries({ queryKey: pluginKeys.installations });
            setEditing(false);
            void message.success('插件已更新');
          }}
        />
      ) : null}
    </article>
  );
}

function InstallDialog({ manifest, onClose }: { manifest: PluginManifest; onClose: () => void }) {
  const { message } = App.useApp();
  const cache = useQueryClient();
  return (
    <div className="plugin-dialog" role="dialog" aria-label={`安装${manifest.title}`}>
      <div className="plugin-dialog-card">
        <span className="flow-kicker">{manifest.vendor}</span>
        <h2>安装 {manifest.title}</h2>
        <CredentialForm
          manifest={manifest}
          initialLabel={manifest.title}
          submitLabel="安装"
          onCancel={onClose}
          onSubmit={async (label, credentials) => {
            await pluginApi.install({ pluginId: manifest.id, label, credentials });
            await cache.invalidateQueries({ queryKey: pluginKeys.installations });
            void message.success('插件已安装');
            onClose();
          }}
        />
      </div>
    </div>
  );
}

function CredentialForm({
  manifest,
  initialLabel,
  submitLabel,
  secretHint,
  onCancel,
  onSubmit,
}: {
  manifest: PluginManifest;
  initialLabel: string;
  submitLabel: string;
  secretHint?: string;
  onCancel: () => void;
  onSubmit: (label: string, credentials: Record<string, string>) => Promise<void>;
}) {
  const { message } = App.useApp();
  const [label, setLabel] = useState(initialLabel);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      manifest.credentialFields.map((field) => [
        field.key,
        field.secret ? '' : (field.defaultValue ?? ''),
      ]),
    ),
  );
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!label.trim()) {
      void message.error('请填写安装名称');
      return;
    }
    setPending(true);
    try {
      await onSubmit(label.trim(), values);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="plugin-form" onSubmit={(event) => void submit(event)}>
      <label>
        安装名称
        <input value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
      </label>
      {manifest.credentialFields.map((field) => (
        <CredentialInput
          key={field.key}
          field={field}
          value={values[field.key] ?? ''}
          hint={field.secret ? secretHint : undefined}
          onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
        />
      ))}
      <div className="plugin-actions">
        <Button size="small" htmlType="submit" type="primary" loading={pending}>
          {submitLabel}
        </Button>
        <Button size="small" htmlType="button" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

function CredentialInput({
  field,
  value,
  hint,
  onChange,
}: {
  field: CredentialField;
  value: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  const label = hint ? `${field.label}（${hint}）` : field.label;
  return (
    <label>
      {label}
      <input
        type={field.secret ? 'password' : 'text'}
        value={value}
        maxLength={2000}
        autoComplete="off"
        placeholder={field.defaultValue}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
