'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, Plug, ShieldCheck } from 'lucide-react';
import {
  jsonObjectSchema,
  type JsonObject,
  type PluginInstallation,
  type Workspace,
} from '@dramaflow/contracts';
import { api, queryKeys } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, FormField } from '@/components/ui/form-field';
import { SchemaForm, toFormSchema } from '@/components/ui/schema-form';

const capabilityLabels = {
  chat: '对话',
  'text.generate': '文本生成',
  'image.generate': '图片生成',
  'video.generate': '视频生成',
};

export function PluginSettings({
  workspace,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const plugins = useQuery({
    queryKey: queryKeys.plugins(workspace.id),
    queryFn: () => api.plugins(workspace.id),
  });
  const connections = useQuery({
    queryKey: queryKeys.connections(workspace.id),
    queryFn: () => api.connections(workspace.id),
  });
  const [selected, setSelected] = useState<PluginInstallation | null>(null);
  const toggle = useMutation({
    mutationFn: (plugin: PluginInstallation) =>
      api.togglePlugin(workspace.id, plugin.pluginId, plugin.pluginVersion, !plugin.enabled),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.plugins(workspace.id) }),
  });
  return (
    <Dialog title="插件与模型连接" onClose={onClose} wide>
      <div className="plugin-layout">
        <div>
          <span className="eyebrow">TRUSTED CAPABILITIES</span>
          <p className="muted text-xs leading-relaxed" style={{ margin: '12px 0 20px' }}>
            由管理员安装受信任插件。节点按能力显式选择模型，平台不会替换你的厂商。
          </p>
          {plugins.error && (
            <ErrorNotice error={plugins.error} onRetry={() => void plugins.refetch()} />
          )}
          {toggle.error && <ErrorNotice error={toggle.error} />}
          {plugins.isPending && (
            <div className="loading-row">
              <Loader2 className="animate-spin" size={14} />
              加载插件…
            </div>
          )}
          {plugins.data?.items.map((plugin) => (
            <div key={`${plugin.pluginId}@${plugin.pluginVersion}`} className="plugin-card">
              <h3>
                <Plug size={15} />
                {plugin.manifest.name}
                <span className="muted" style={{ marginLeft: 'auto', fontSize: 9 }}>
                  {plugin.pluginVersion}
                </span>
              </h3>
              <p>{plugin.manifest.description}</p>
              <div className="plugin-capabilities">
                {plugin.manifest.capabilities.map((capability) => (
                  <span className="badge" key={capability}>
                    {capabilityLabels[capability]}
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 15 }}>
                {workspace.role === 'admin' && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate(plugin)}
                  >
                    {plugin.enabled ? '停用插件' : '启用插件'}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!plugin.enabled || workspace.role === 'viewer'}
                  onClick={() => setSelected(plugin)}
                >
                  <KeyRound size={12} />
                  添加连接
                </Button>
              </div>
            </div>
          ))}
          {plugins.data?.items.length === 0 && (
            <EmptyState icon={<Plug />} title="尚未安装插件">
              请由管理员在服务端安装受信任插件包。
            </EmptyState>
          )}
        </div>
        <div>
          <span className="eyebrow">YOUR CONNECTIONS</span>
          <p className="muted text-xs leading-relaxed" style={{ margin: '12px 0 18px' }}>
            密钥只提交一次，并在服务端加密保存。浏览器只显示连接名称与状态。
          </p>
          {connections.error && <ErrorNotice error={connections.error} />}
          {connections.data?.items.map((connection) => (
            <div key={connection.id} className="plugin-connection">
              <div>
                <h4>{connection.name}</h4>
                <small>
                  {connection.pluginId} · {connection.pluginVersion}
                </small>
              </div>
              <span className="badge">
                <ShieldCheck size={10} />
                {connection.hasCredential ? '已配置凭证' : '缺少凭证'}
              </span>
            </div>
          ))}
          {connections.data?.items.length === 0 && (
            <EmptyState icon={<KeyRound />} title="还没有模型连接">
              先启用插件，再为它添加独立凭证。
            </EmptyState>
          )}
          {selected && (
            <ConnectionForm
              workspaceId={workspace.id}
              plugin={selected}
              onDone={() => {
                setSelected(null);
                void client.invalidateQueries({ queryKey: queryKeys.connections(workspace.id) });
              }}
              onCancel={() => setSelected(null)}
            />
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ConnectionForm({
  workspaceId,
  plugin,
  onDone,
  onCancel,
}: {
  workspaceId: string;
  plugin: PluginInstallation;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [configuration, setConfiguration] = useState<JsonObject>({});
  const create = useMutation({
    mutationFn: (data: { name: string; credential: string }) =>
      api.createConnection(workspaceId, {
        ...data,
        pluginId: plugin.pluginId,
        pluginVersion: plugin.pluginVersion,
        configuration,
      }),
    onSuccess: onDone,
  });
  return (
    <form
      style={{ marginTop: 25, paddingTop: 20, borderTop: '1px solid var(--border)' }}
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        create.mutate({
          name: String(form.get('name')),
          credential: String(form.get('credential')),
        });
      }}
    >
      <h3 style={{ margin: '0 0 17px', fontSize: 13 }}>添加 {plugin.manifest.name} 连接</h3>
      {create.error && <ErrorNotice error={create.error} />}
      <FormField label="连接名称">
        <input name="name" required maxLength={120} placeholder="例如：团队创作专用" />
      </FormField>
      <SchemaForm
        schema={toFormSchema(plugin.manifest.connectionSchema)}
        value={configuration}
        onChange={(value) => setConfiguration(jsonObjectSchema.parse(value))}
      />
      <FormField label="API 密钥">
        <input
          name="credential"
          type="password"
          required
          autoComplete="off"
          placeholder="仅提交到团队服务端"
        />
      </FormField>
      <div className="inline-form">
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending && <Loader2 className="animate-spin" />}保存连接
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}
