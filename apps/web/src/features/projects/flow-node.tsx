'use client';
import { createContext, useContext } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeDefinition } from '@dramaflow/contracts';
import type { CanvasNode } from './graph';

export const CatalogContext = createContext<ReadonlyMap<string, NodeDefinition>>(new Map());

const capabilityLabel = { text: '大模型', image: '图片模型', video: '视频模型' } as const;
const kindLabel = {
  json: 'JSON',
  text: '文本',
  number: '数字',
  boolean: '布尔',
  asset: '素材',
  image: '图片',
  video: '视频',
  file: '文件',
} as const;

export function FlowNode({ data }: NodeProps<CanvasNode>) {
  const definition = useContext(CatalogContext).get(`${data.nodeType}@${data.version}`);
  const preview =
    typeof data.config.instruction === 'string'
      ? data.config.instruction
      : typeof data.config.body === 'string'
        ? data.config.body
        : typeof data.config.summary === 'string'
          ? data.config.summary
          : typeof data.config.caption === 'string'
            ? data.config.caption
            : typeof data.config.text === 'string'
              ? data.config.text
              : typeof data.config.notes === 'string'
                ? data.config.notes
                : '';
  const kicker = !definition
    ? '未安装'
    : definition.pluginCapability
      ? capabilityLabel[definition.pluginCapability]
      : definition.type === 'core.step'
        ? '编排'
        : '内容';
  const inputs = definition?.inputs ?? [];
  const outputs = definition?.outputs ?? [];
  const typed = inputs.length + outputs.length > 0;
  return (
    <article className="flow-node" aria-label={data.title}>
      {typed ? null : (
        <Handle id="__exec_in" type="target" position={Position.Left} aria-label="执行输入" />
      )}
      {inputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          className={`port-${port.kind}`}
          role="button"
          type="target"
          position={Position.Left}
          style={{ top: `${((index + 1) / (inputs.length + 1)) * 100}%` }}
          title={`${port.label} · ${kindLabel[port.kind]}`}
          aria-label={`${port.label} ${kindLabel[port.kind]}`}
        />
      ))}
      <span className="flow-kicker">{kicker}</span>
      <h3>{data.title}</h3>
      {inputs.length + outputs.length > 0 ? (
        <p className="flow-ports">
          {inputs.map((port) => port.label).join(' · ')}
          {inputs.length && outputs.length ? ' → ' : ''}
          {outputs.map((port) => port.label).join(' · ')}
        </p>
      ) : null}
      {preview.trim() ? <p className="flow-note">{preview.trim()}</p> : null}
      {typed ? null : (
        <Handle id="__exec_out" type="source" position={Position.Right} aria-label="执行输出" />
      )}
      {outputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          className={`port-${port.kind}`}
          role="button"
          type="source"
          position={Position.Right}
          style={{ top: `${((index + 1) / (outputs.length + 1)) * 100}%` }}
          title={`${port.label} · ${kindLabel[port.kind]}`}
          aria-label={`${port.label} ${kindLabel[port.kind]}`}
        />
      ))}
    </article>
  );
}

export const canvasNodeTypes = { canvas: FlowNode };
