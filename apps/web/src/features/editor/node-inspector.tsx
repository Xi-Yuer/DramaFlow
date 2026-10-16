'use client';

import { Braces, Cable, Settings2, Trash2, Workflow } from 'lucide-react';
import {
  jsonObjectSchema,
  type NodeDefinition,
  type PluginConnection,
  type PluginInstallation,
} from '@dramaflow/contracts';
import { useEditorStore } from './editor-store';
import { nodePresentation } from './node-presentation';
import { BindingEditor } from './binding-editor';
import { ModelSelector, readModel } from '@/features/plugins/model-selector';
import { Button } from '@/components/ui/button';
import { EmptyState, FormField } from '@/components/ui/form-field';
import { SchemaForm, toFormSchema } from '@/components/ui/schema-form';

export function NodeInspector({
  catalog,
  plugins,
  connections,
  readOnly,
}: {
  catalog: NodeDefinition[];
  plugins: PluginInstallation[];
  connections: PluginConnection[];
  readOnly: boolean;
}) {
  const state = useEditorStore();
  const node = state.definition.nodes.find((entry) => entry.id === state.selectedNodeId);
  const definition = catalog.find(
    (entry) => entry.type === node?.type && entry.version === node.version,
  );
  if (!node)
    return (
      <div className="panel-scroll">
        <EmptyState icon={<Workflow />} title="选择一个节点">
          在画布中选择节点，配置它的输入、生成要求和输出。
          <br />
          所有修改先保存在草稿中。
        </EmptyState>
        <div className="inspector-section">
          <h3>
            <Settings2 size={13} />
            工作流设置
          </h3>
          <FormField label="名称">
            <input
              value={state.name}
              onChange={(event) => state.rename(event.target.value)}
              disabled={readOnly}
              maxLength={120}
            />
          </FormField>
          <FormField label="描述">
            <textarea
              value={state.description}
              onChange={(event) => state.setDescription(event.target.value)}
              disabled={readOnly}
              maxLength={2000}
              rows={4}
            />
          </FormField>
        </div>
      </div>
    );
  const { icon: Icon, color, tag } = nodePresentation[node.type];
  const formSchema = toFormSchema(definition?.configSchema);
  const capability =
    node.type === 'batch'
      ? node.config.capability === 'image.generate'
        ? 'image.generate'
        : 'text.generate'
      : definition?.capability;
  const model = readModel(node.config.model);
  const plugin = plugins.find(
    (entry) => entry.pluginId === model?.pluginId && entry.pluginVersion === model?.pluginVersion,
  );
  const {
    model: unusedModel,
    parameters: unusedParameters,
    ...fields
  } = formSchema.properties ?? {};
  void unusedModel;
  void unusedParameters;
  function setConfig(config: Record<string, unknown>) {
    if (node) state.updateNode(node.id, { config: jsonObjectSchema.parse(config) });
  }
  return (
    <>
      <div className="panel-scroll">
        <div className="inspector-node-heading">
          <span className="node-icon" style={{ '--node-color': color } as React.CSSProperties}>
            <Icon size={16} />
          </span>
          <div>
            <h3>{node.title}</h3>
            <small>
              {tag} · {node.version}
            </small>
          </div>
        </div>
        <div className="inspector-section" style={{ paddingTop: 0 }}>
          <FormField label="节点名称">
            <input
              value={node.title}
              onChange={(event) => state.updateNode(node.id, { title: event.target.value })}
              disabled={readOnly}
              maxLength={200}
            />
          </FormField>
        </div>
        {capability && (
          <div className="inspector-section">
            <h3>
              <Settings2 size={13} />
              模型能力
            </h3>
            <ModelSelector
              capability={capability}
              value={model}
              plugins={plugins}
              connections={connections}
              disabled={readOnly}
              onChange={(selection) => setConfig({ ...node.config, model: selection })}
            />
          </div>
        )}
        <div className="inspector-section">
          <h3>
            <Braces size={13} />
            节点参数
          </h3>
          {capability && (
            <p className="field-hint" style={{ marginBottom: 15 }}>
              需求可固定填写或绑定 prompt 输入。上游资料请绑定 context 端口；不支持模板插值。
            </p>
          )}
          <SchemaForm
            schema={{ ...formSchema, properties: fields }}
            value={node.config}
            onChange={setConfig}
            disabled={readOnly}
          />
          {capability && plugin?.manifest.parametersSchema[capability] && (
            <>
              <h3>插件参数</h3>
              <SchemaForm
                schema={toFormSchema(plugin.manifest.parametersSchema[capability])}
                value={
                  typeof node.config.parameters === 'object' &&
                  node.config.parameters !== null &&
                  !Array.isArray(node.config.parameters)
                    ? node.config.parameters
                    : {}
                }
                onChange={(parameters) => setConfig({ ...node.config, parameters })}
                disabled={readOnly}
              />
            </>
          )}
        </div>
        <div className="inspector-section">
          <h3>
            <Cable size={13} />
            输入绑定
          </h3>
          <p className="field-hint" style={{ marginBottom: 12 }}>
            执行线控制激活；绑定决定实际传入的数据。上游输出不自动进入提示词。
          </p>
          <BindingEditor
            key={node.id}
            node={node}
            definition={definition}
            catalog={catalog}
            readOnly={readOnly}
          />
        </div>
      </div>
      <div className="panel-actions">
        <span className="field-hint" style={{ fontFamily: 'var(--font-mono)', fontSize: 9 }}>
          {node.id}
        </span>
        <Button
          variant="ghost"
          size="icon"
          disabled={readOnly}
          title="删除节点"
          aria-label="删除节点"
          onClick={() => state.removeNode(node.id)}
        >
          <Trash2 size={14} />
        </Button>
      </div>
    </>
  );
}
