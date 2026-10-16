'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import type {
  InstallationSummary,
  JsonObject,
  ModelListing,
  NodeDefinition,
  PluginCapability,
  PluginManifest,
} from '@dramaflow/contracts';
import { pluginApi, pluginKeys } from '@/features/plugins/plugin-api';
import type { CanvasNode } from './graph';

const textFields = [
  ['text', '用户输入', 20000, '写下交给下游的文本'],
  ['body', '内容', 20000, '写下剧本、旁白或提示词'],
  ['summary', '角色设定', 4000, '外貌、性格和关系'],
  ['caption', '说明', 500, '这张图在流程里的用途'],
  ['notes', '备注', 2000, '给这个步骤留一点说明'],
] as const;

export function NodeInspector({
  node,
  definition,
  manifests,
  installations,
  onChange,
  onRemove,
}: {
  node: CanvasNode;
  definition: NodeDefinition | undefined;
  manifests: PluginManifest[];
  installations: InstallationSummary[];
  onChange: (patch: Partial<CanvasNode['data']>) => void;
  onRemove: () => void;
}) {
  const capability = definition?.pluginCapability ?? null;
  const config = node.data.config;
  function setConfig(patch: JsonObject) {
    onChange({ config: { ...config, ...patch } });
  }
  const installationId = typeof config.installationId === 'string' ? config.installationId : '';
  const modelId = typeof config.modelId === 'string' ? config.modelId : '';
  const instruction = typeof config.instruction === 'string' ? config.instruction : '';
  const url = typeof config.url === 'string' ? config.url : null;
  const fileUrl = typeof config.fileUrl === 'string' ? config.fileUrl : null;
  const selected = installations.find((item) => item.id === installationId);
  const manifest = manifests.find((item) => item.id === selected?.pluginId);
  const choices = capability
    ? installations.filter((item) =>
        manifests.find((plugin) => plugin.id === item.pluginId)?.capabilities.includes(capability),
      )
    : [];
  return (
    <aside className="node-inspector" aria-label="节点设置">
      <span className="flow-kicker">{definition?.title ?? '节点'}</span>
      <label>
        标题
        <input
          value={node.data.title}
          maxLength={80}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </label>
      {capability ? (
        <PluginFields
          capability={capability}
          choices={choices}
          manifests={manifests}
          installationId={installationId}
          modelId={modelId}
          instruction={instruction}
          modelListing={manifest?.modelListing ?? null}
          allowCustomModel={manifest?.allowCustomModel ?? true}
          onConfig={setConfig}
        />
      ) : null}
      {fileUrl !== null ? (
        <label>
          文件地址
          <input
            value={fileUrl}
            maxLength={2000}
            placeholder="https://"
            onChange={(event) => setConfig({ fileUrl: event.target.value })}
          />
        </label>
      ) : null}
      {url !== null ? (
        <label>
          图片地址
          <input
            value={url}
            maxLength={2000}
            placeholder="https://"
            onChange={(event) => setConfig({ url: event.target.value })}
          />
        </label>
      ) : null}
      {textFields.map(([key, label, max, placeholder]) => {
        const value = config[key];
        return typeof value === 'string' ? (
          <label key={key}>
            {label}
            <textarea
              value={value}
              maxLength={max}
              rows={key === 'notes' ? 4 : 5}
              placeholder={placeholder}
              onChange={(event) => setConfig({ [key]: event.target.value })}
            />
          </label>
        ) : null;
      })}
      <p>{definition?.description ?? '这个节点类型当前未安装，保存时会被拒绝。'}</p>
      <Button size="small" danger onClick={onRemove}>
        删除节点
      </Button>
    </aside>
  );
}

function PluginFields({
  capability,
  choices,
  manifests,
  installationId,
  modelId,
  instruction,
  modelListing,
  allowCustomModel,
  onConfig,
}: {
  capability: PluginCapability;
  choices: InstallationSummary[];
  manifests: PluginManifest[];
  installationId: string;
  modelId: string;
  instruction: string;
  modelListing: ModelListing | null;
  allowCustomModel: boolean;
  onConfig: (patch: JsonObject) => void;
}) {
  const remote = useQuery({
    queryKey: pluginKeys.models(installationId),
    queryFn: () => pluginApi.models(installationId),
    enabled: Boolean(installationId) && modelListing !== 'none' && modelListing !== null,
  });
  const models = remote.data?.items ?? [];
  const known = models.some((model) => model.id === modelId);
  return (
    <>
      <label>
        模型插件
        {choices.length === 0 ? (
          <span className="inspector-hint">
            {`还没有可用的${capability === 'text' ? '文本' : capability === 'image' ? '图片' : '视频'}插件。`}
            <Link href="/plugins">去安装</Link>
          </span>
        ) : (
          <select
            value={installationId}
            onChange={(event) => onConfig({ installationId: event.target.value, modelId: '' })}
          >
            <option value="">选择已安装的插件</option>
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} ·{' '}
                {manifests.find((plugin) => plugin.id === item.pluginId)?.title ?? item.pluginId}
              </option>
            ))}
          </select>
        )}
      </label>
      {installationId && modelListing !== 'none' ? (
        <label>
          账号中的模型
          {remote.isLoading ? (
            <span className="inspector-hint">正在从插件账号读取模型…</span>
          ) : remote.error ? (
            <span className="inspector-hint">{remote.error.message}</span>
          ) : models.length > 0 ? (
            <select
              value={known ? modelId : ''}
              onChange={(event) => onConfig({ modelId: event.target.value })}
            >
              <option value="">选择模型</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="inspector-hint">
              {remote.data?.unavailableReason ?? '这个账号没有返回可用模型'}
            </span>
          )}
        </label>
      ) : null}
      {installationId && modelListing === 'none' ? (
        <span className="inspector-hint">这个插件没有公开的模型列表，请填写模型 ID。</span>
      ) : null}
      {installationId && allowCustomModel ? (
        <label>
          模型 ID
          <input
            value={modelId}
            maxLength={160}
            placeholder={
              models.length > 0 ? '可从上方选择，也可直接填写' : '填写厂商账号中的模型 ID'
            }
            onChange={(event) => onConfig({ modelId: event.target.value })}
          />
        </label>
      ) : null}
      <label>
        指令
        <textarea
          value={instruction}
          maxLength={8000}
          rows={4}
          placeholder="只保存给这个节点的指令，当前不会发起生成"
          onChange={(event) => onConfig({ instruction: event.target.value })}
        />
      </label>
    </>
  );
}
