'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { Handle, Position, type NodeProps, type NodeTypes } from '@xyflow/react';
import type { DataType, NodeTypeManifest } from '@dramaflow/contracts';
import { conditionToFields, ifConditionOperators } from '../conditions/if-condition';
import { NodeTypeIcon } from '../node-catalog/node-type-icon';
import { resolveWorkflowNodePorts } from '../ports/resolve-workflow-node-ports';
import { canvasNodeDefinition } from './react-flow-adapter';
import { useWorkflowNodeRuntime } from '../runtime/runtime-status';
import { runtimeNodeBorderClass } from '../runtime/runtime-status-badge';
import { RuntimeCanvasStatus } from '../runtime/runtime-canvas-status';
import type { WorkflowNode } from './react-flow-adapter';
import { controlHandleId } from './workflow-handles';
import styles from './workflow-node.module.css';

const ManifestContext = createContext<readonly NodeTypeManifest[]>([]);

export interface WorkflowNodeSelectionActions {
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

export const WorkflowNodeSelectionContext = createContext<WorkflowNodeSelectionActions | null>(
  null,
);

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

function configSummary(value: unknown, isModelSelector = false) {
  if (isModelSelector) {
    return typeof value === 'string' && value.length > 0 ? '已配置' : '未配置';
  }
  if (value === undefined) return '未配置';
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '已配置';
}

function ifConditionSummary(condition: unknown): string {
  const fields = conditionToFields(condition);
  if (condition !== undefined && !fields) {
    return '当前编辑器暂不支持该条件表达式';
  }
  if (!fields) {
    return '尚未配置条件';
  }
  const operatorLabel = ifConditionOperators.find((item) => item.value === fields.operator)?.label;
  return `value ${operatorLabel} ${JSON.stringify(fields.expected)}`;
}

export function summarizeReviewContent(content: string, maxLength = 28): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return '“暂无待审内容”';
  if (normalized.length <= maxLength) return `“${normalized}”`;
  return `“${normalized.slice(0, maxLength)}……”`;
}

export function GenericWorkflowNode({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<WorkflowNode>) {
  const manifests = useContext(ManifestContext);
  const selection = useContext(WorkflowNodeSelectionContext);
  const runtime = useWorkflowNodeRuntime(id);
  const manifest = findNodeManifest(manifests, data.nodeType, data.typeVersion);
  const ports = manifest
    ? resolveWorkflowNodePorts(canvasNodeDefinition(id, data), manifest)
    : { inputs: [], outputs: [] };
  const isIf =
    data.nodeType === 'flow.if' && data.typeVersion === 1 && manifest?.executionKind === 'control';
  const isHumanReview =
    data.nodeType === 'flow.human_review' &&
    data.typeVersion === 1 &&
    manifest?.executionKind === 'interaction';
  const isSelected = selected || selection?.selectedNodeId === id;
  const borderClass = runtimeNodeBorderClass(runtime.status, {
    isHumanReview: isHumanReview || runtime.isWaitingHumanReview,
  });
  const instructionSummary =
    isHumanReview && typeof data.config.instruction === 'string' && data.config.instruction.trim()
      ? data.config.instruction.trim()
      : null;
  const waitingReview = isHumanReview && runtime.isWaitingHumanReview ? runtime.review : null;

  return (
    <article
      className={`${styles.node} ${borderClass}${isSelected ? ` ${styles.selected}` : ''}`}
      data-node-id={id}
      data-runtime-status={runtime.status}
      aria-label={`${data.name}${manifest ? '' : '：节点类型不可用'}`}
      onClick={() => selection?.onSelectNode(id)}
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
        <RuntimeCanvasStatus
          status={runtime.status}
          isHumanReview={isHumanReview || runtime.isWaitingHumanReview}
        />
      </header>
      {manifest ? (
        <>
          <div className={styles.ports}>
            <div>
              {ports.inputs.map((port) => (
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
              {ports.outputs.map((port) => (
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
          {waitingReview ? (
            <div
              className={styles.reviewCallout}
              data-testid="human-review-waiting-callout"
              aria-label="待审核摘要"
            >
              <span className={styles.reviewHeading}>等待你的审核</span>
              <p className={styles.reviewExcerpt} title={waitingReview.item.content}>
                {summarizeReviewContent(waitingReview.item.content)}
              </p>
              <span className={styles.reviewCta}>查看并审核 →</span>
            </div>
          ) : instructionSummary ? (
            <div className={styles.summaryRow}>
              <p className={styles.summaryText} title={instructionSummary}>
                {instructionSummary}
              </p>
            </div>
          ) : null}
          {isIf ? (
            <div className={styles.summaryRow}>
              <p className={styles.summaryText} title={ifConditionSummary(data.config.condition)}>
                {ifConditionSummary(data.config.condition)}
              </p>
            </div>
          ) : null}
          {!isIf && !isHumanReview && manifest.config.length ? (
            <dl className={styles.config}>
              {manifest.config.slice(0, 3).map((field) => (
                <div key={field.key}>
                  <dt>{field.name}</dt>
                  <dd>
                    {configSummary(
                      data.config[field.key],
                      field.ui?.component === 'model-selector',
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
