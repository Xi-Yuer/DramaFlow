'use client';
import { useContext, useState } from 'react';
import {
  isIterationNodeManifest,
  type NodeDefinition,
  type NodeTypeManifest,
} from '@dramaflow/contracts';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { ModelSelector } from '../../model-selection/model-selector';
import { WorkflowNodeSettingsActions } from '../../node-catalog/human-review-settings';
import { resolveWorkflowNodePorts } from '../../ports/resolve-workflow-node-ports';
import { IterationInspector } from '../../iteration/iteration-inspector';
import { HumanReviewInspector } from './human-review-inspector';
import { IfInspector } from './if-inspector';
import { NodeInputBindingField } from './node-input-binding-field';
import { TextGenerateInspector } from './text-generate-inspector';
import styles from '../workflow-node-inspector.module.css';

function configValueSummary(value: unknown) {
  if (value === undefined) return '未配置';
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '已配置';
}

function GenericNodeInspector({
  node,
  manifest,
}: {
  node: NodeDefinition;
  manifest: NodeTypeManifest;
}) {
  const capabilityTypes = (manifest.capabilities ?? []).map((item) => item.type);
  const inputs = resolveWorkflowNodePorts(node, manifest).inputs;
  return (
    <div className={styles.sections}>
      {inputs.length > 0 ? (
        <section className={styles.section} aria-label="输入绑定">
          {inputs.map((port) => (
            <NodeInputBindingField
              key={port.key}
              nodeId={node.id}
              port={port}
              binding={node.inputs[port.key]}
              rows={3}
            />
          ))}
        </section>
      ) : null}

      {manifest.config.length > 0 ? (
        <section className={styles.section} aria-label="节点参数">
          <span className={styles.fieldLabel}>节点参数</span>
          <dl className={styles.configList}>
            {manifest.config.map((field) => (
              <div key={field.key} className={styles.configRow}>
                <dt>{field.name}</dt>
                <dd>
                  {field.ui?.component === 'model-selector' ? (
                    <ModelSelector
                      nodeId={node.id}
                      capabilityTypes={capabilityTypes}
                      value={node.config[field.key]}
                    />
                  ) : (
                    configValueSummary(node.config[field.key])
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}

export function NodeNameSection({ node }: { node: NodeDefinition }) {
  const settingsActions = useContext(WorkflowNodeSettingsActions);
  const disabled = !settingsActions || settingsActions.disabled;
  const [draftName, setDraftName] = useState<{ nodeId: string; value: string } | null>(null);
  const currentValue = draftName?.nodeId === node.id ? draftName.value : node.name;

  function commitName() {
    if (draftName?.nodeId !== node.id) return;
    const trimmed = draftName.value.trim();
    if (!disabled && trimmed && trimmed !== node.name) {
      settingsActions?.onRename(node.id, trimmed);
    }
    setDraftName(null);
  }

  return (
    <section className={styles.section} aria-label="节点基本信息">
      <label className={styles.field}>
        <span className={styles.fieldLabel}>节点名称</span>
        <Input
          aria-label="节点名称"
          value={currentValue}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            setDraftName({ nodeId: node.id, value });
            const trimmed = value.trim();
            if (!disabled && trimmed && trimmed !== node.name) {
              settingsActions?.onRename(node.id, trimmed);
            }
          }}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitName();
            }
          }}
        />
      </label>
    </section>
  );
}

export function NodeDesignInspectorBody({
  node,
  manifest,
  onUpdateNode,
}: {
  node: NodeDefinition;
  manifest: NodeTypeManifest | undefined;
  onUpdateNode?: (node: NodeDefinition) => void;
}) {
  if (!manifest) {
    return (
      <Alert variant="warning">
        <AlertTitle>节点类型不可用，请安装匹配版本。</AlertTitle>
      </Alert>
    );
  }

  if (node.type === 'ai.text_generate' && node.typeVersion === 1) {
    return <TextGenerateInspector node={node} manifest={manifest} />;
  }

  if (node.type === 'flow.if' && node.typeVersion === 1 && manifest.executionKind === 'control') {
    return <IfInspector node={node} manifest={manifest} />;
  }

  if (
    node.type === 'flow.human_review' &&
    node.typeVersion === 1 &&
    manifest.executionKind === 'interaction'
  ) {
    return <HumanReviewInspector node={node} manifest={manifest} />;
  }

  if (
    onUpdateNode &&
    node.type === manifest.type &&
    node.typeVersion === manifest.version &&
    isIterationNodeManifest(manifest)
  ) {
    return <IterationInspector node={node} manifest={manifest} onUpdateNode={onUpdateNode} />;
  }

  return <GenericNodeInspector node={node} manifest={manifest} />;
}
