'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { Handle, Position, type NodeProps, type NodeTypes } from '@xyflow/react';
import {
  ArrowLeftFromLine,
  ArrowRightToLine,
  AudioLines,
  Box,
  BrainCircuit,
  Database,
  GitBranch,
  Image as ImageIcon,
  Video,
} from 'lucide-react';
import type { DataType, NodeTypeManifest } from '@dramaflow/contracts';
import type { WorkflowNode } from './react-flow-adapter';
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

const nodeIcons = {
  input: <ArrowLeftFromLine size={16} />,
  ai: <BrainCircuit size={16} />,
  image: <ImageIcon size={16} />,
  video: <Video size={16} />,
  audio: <AudioLines size={16} />,
  flow: <GitBranch size={16} />,
  data: <Database size={16} />,
  output: <ArrowRightToLine size={16} />,
};

const metadataIcons = new Map([
  ['text', nodeIcons.ai],
  ['brain', nodeIcons.ai],
  ...Object.entries(nodeIcons),
]);

const dataTypeNames = {
  any: '任意',
  string: '文本',
  number: '数字',
  boolean: '布尔',
  json: 'JSON',
  image: '图片',
  video: '视频',
  audio: '音频',
  file: '文件',
};

function dataTypeName(dataType: DataType): string {
  if (dataType.kind === 'array') return `${dataTypeName(dataType.item)}[]`;
  if (dataType.kind === 'domain') return dataType.name;
  return dataTypeNames[dataType.kind];
}

function configSummary(value: unknown) {
  if (value === undefined) return '未配置';
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '已配置';
}

export function GenericWorkflowNode({ data, selected, isConnectable }: NodeProps<WorkflowNode>) {
  const manifests = useContext(ManifestContext);
  const manifest = findNodeManifest(manifests, data.nodeType, data.typeVersion);
  const icon = manifest ? (
    (metadataIcons.get(manifest.metadata.icon ?? '') ?? nodeIcons[manifest.metadata.category])
  ) : (
    <Box size={16} />
  );

  return (
    <article
      className={`${styles.node}${selected ? ` ${styles.selected}` : ''}`}
      aria-label={`${data.name}${manifest ? '' : '：节点类型不可用'}`}
    >
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          {icon}
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
            </div>
          </div>
          {manifest.config.length ? (
            <dl className={styles.config}>
              {manifest.config.slice(0, 3).map((field) => (
                <div key={field.key}>
                  <dt>{field.name}</dt>
                  <dd>{configSummary(data.config[field.key])}</dd>
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
