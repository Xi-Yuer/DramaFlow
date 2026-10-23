'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { Handle, Position, type NodeProps, type NodeTypes } from '@xyflow/react';
import type { DataType, NodeTypeManifest } from '@dramaflow/contracts';
import { HumanReviewSettings } from '../node-catalog/human-review-settings';
import { NodeTypeIcon } from '../node-catalog/node-type-icon';
import { ModelSelector } from '../model-selection/model-selector';
import type { WorkflowNode } from './react-flow-adapter';
import { CandidateInputSummary } from '../inputs/candidate-input-summary';
import { TemplateInputEditor } from '../inputs/template-input-editor';
import { availableStringOutputs } from '../inputs/template-input';
import { WorkflowInputContext } from '../inputs/workflow-input-context';
import { IfConditionEditor } from '../conditions/if-condition-editor';
import { controlHandleId } from './workflow-handles';
import styles from './workflow-node.module.css';

const ManifestContext = createContext<readonly NodeTypeManifest[]>([]);

export function WorkflowManifestProvider({
  manifests,
  children,
}: {
  manifests: readonly NodeTypeManifest[];
  children: ReactNode;
}) {
  return <ManifestContext.Provider value={manifests}>{children}</ManifestContext.Provider>;
}

export function findNodeManifest(
  manifests: readonly NodeTypeManifest[],
  type: string,
  version: number,
) {
  return manifests.find((manifest) => manifest.type === type && manifest.version === version);
}

const dataTypeNames: Record<string, string> = {
  any: '任意',
  string: '文本',
  number: '数字',
  boolean: '布尔',
  null: '空值',
  'system.json': 'JSON',
  'media.image': '图片',
  'media.video': '视频',
  'media.audio': '音频',
  'media.file': '文件',
  'media.document': '文档',
};
function dataTypeName(type: DataType): string {
  if (type.kind === 'any') return dataTypeNames.any!;
  if (type.kind === 'array') return `(${dataTypeName(type.itemType)})[]`;
  if (type.kind === 'object') return '结构化对象';
  if (type.kind === 'union') return type.types.map(dataTypeName).join(' | ');
  return dataTypeNames[type.name] ?? type.name;
}

function configSummary(value: unknown) {
  if (value === undefined) return '未配置';
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '已配置';
}

export function GenericWorkflowNode({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<WorkflowNode>) {
  const manifests = useContext(ManifestContext);
  const inputActions = useContext(WorkflowInputContext);
  const manifest = findNodeManifest(manifests, data.nodeType, data.typeVersion);
  const isIf =
    data.nodeType === 'flow.if' && data.typeVersion === 1 && manifest?.executionKind === 'control';

  const isHumanReview =
    data.nodeType === 'flow.human_review' &&
    data.typeVersion === 1 &&
    manifest?.executionKind === 'interaction';

  const inputPorts =
    manifest?.inputs.filter(
      (port) =>
        data.inputs[port.key]?.type === 'candidate' ||
        (isHumanReview && port.key === 'content') ||
        (isIf
          ? port.key === 'value'
          : data.nodeType === 'ai.text_generate' &&
            (port.key === 'prompt' || port.key === 'system')),
    ) ?? [];

  return (
    <article
      className={`${styles.node}${selected ? ` ${styles.selected}` : ''}`}
      aria-label={`${data.name}${manifest ? '' : '：节点类型不可用'}`}
    >
      <header className={styles.header}>
        {manifest ? (
          <>
            <Handle
              className={`${styles.controlHandle} ${styles.controlInput}`}
              type="target"
              position={Position.Left}
              id={controlHandleId('target')}
              isConnectable={isConnectable}
              aria-label="控制输入"
              title="控制输入"
            />
            {!manifest.controlOutputs?.length ? (
              <Handle
                className={`${styles.controlHandle} ${styles.controlOutput}`}
                type="source"
                position={Position.Right}
                id={controlHandleId('source')}
                isConnectable={isConnectable}
                aria-label="控制输出"
                title="控制输出"
              />
            ) : null}
          </>
        ) : null}
        <span className={styles.icon} aria-hidden="true">
          <NodeTypeIcon metadata={manifest?.metadata} />
        </span>
        <div className={styles.title}>
          <strong>{data.name}</strong>
          <span>
            {manifest?.metadata.name ?? data.nodeType} · v{data.typeVersion}
          </span>
        </div>
      </header>
      {manifest ? (
        <>
          <div className={styles.ports}>
            <div>
              {manifest.inputs.map((port) => (
                <div className={styles.input} key={port.key}>
                  <Handle
                    className={styles.handle}
                    type="target"
                    position={Position.Left}
                    id={port.key}
                    isConnectable={isConnectable}
                    aria-label={`输入：${port.name}`}
                  />
                  <span>
                    {port.name}
                    {port.required ? <em aria-label="必填"> *</em> : null}
                  </span>
                  <small>{dataTypeName(port.dataType)}</small>
                </div>
              ))}
            </div>
            <div>
              {manifest.outputs.map((port) => (
                <div className={styles.output} key={port.key}>
                  <span>{port.name}</span>
                  <small>{dataTypeName(port.dataType)}</small>
                  <Handle
                    className={styles.handle}
                    type="source"
                    position={Position.Right}
                    id={port.key}
                    isConnectable={isConnectable}
                    aria-label={`输出：${port.name}`}
                  />
                </div>
              ))}
              {manifest.controlOutputs?.map((port) => (
                <div className={styles.output} key={`control:${port.key}`}>
                  <span>{port.key}</span>
                  <small>{port.name}</small>
                  <Handle
                    className={`${styles.controlHandle} ${styles.controlOutput}`}
                    type="source"
                    position={Position.Right}
                    id={controlHandleId('source', port.key)}
                    isConnectable={isConnectable}
                    aria-label={`控制输出：${port.key}`}
                    title={`${port.key} · ${port.name}`}
                  />
                </div>
              ))}
            </div>
          </div>
          {isHumanReview ? (
            <HumanReviewSettings
              nodeId={id}
              name={data.name}
              instruction={data.config.instruction}
            />
          ) : null}
          {inputActions && inputPorts.length > 0 ? (
            <div className={styles.inputs}>
              {inputPorts.map((port) => {
                const binding = data.inputs[port.key];
                return binding?.type === 'candidate' ? (
                  <CandidateInputSummary
                    key={port.key}
                    portName={port.name}
                    binding={binding}
                    definition={inputActions.definition}
                    manifests={inputActions.manifests}
                  />
                ) : (
                  <TemplateInputEditor
                    key={port.key}
                    portName={port.name}
                    rows={port.key === 'system' ? 2 : 4}
                    binding={data.inputs[port.key]}
                    connected={inputActions.definition.edges.some(
                      (edge) =>
                        edge.kind === 'data' &&
                        edge.target.nodeId === id &&
                        edge.target.portKey === port.key,
                    )}
                    outputs={availableStringOutputs(
                      inputActions.definition,
                      id,
                      inputActions.manifests,
                    )}
                    definition={inputActions.definition}
                    manifests={inputActions.manifests}
                    disabled={inputActions.disabled}
                    onChange={(binding) => inputActions.onReplaceInput(id, port.key, binding)}
                  />
                );
              })}
            </div>
          ) : null}
          {isIf ? <IfConditionEditor nodeId={id} condition={data.config.condition} /> : null}
          {!isIf && !isHumanReview && manifest.config.length ? (
            <dl className={styles.config}>
              {manifest.config.slice(0, 3).map((field) => (
                <div
                  key={field.key}
                  className={field.ui?.component === 'model-selector' ? styles.selector : undefined}
                >
                  <dt>{field.name}</dt>
                  <dd>
                    {field.ui?.component === 'model-selector' ? (
                      <ModelSelector
                        nodeId={id}
                        capabilityTypes={(manifest.capabilities ?? []).map((item) => item.type)}
                        value={data.config[field.key]}
                      />
                    ) : (
                      configSummary(data.config[field.key])
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      ) : (
        <p className={styles.unavailable} role="status">
          节点类型不可用，请安装匹配版本。
        </p>
      )}
    </article>
  );
}

// 渲染器数量不随业务类型增长，Runtime 类型由 manifest 决定。
export const workflowNodeTypes = { workflowNode: GenericWorkflowNode } satisfies NodeTypes;
