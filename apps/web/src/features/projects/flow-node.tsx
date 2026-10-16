'use client';
import { createContext, useContext } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeDefinition } from '@dramaflow/contracts';
import type { CanvasNode } from './graph';

export const CatalogContext = createContext<ReadonlyMap<string, NodeDefinition>>(new Map());

export function FlowNode({ data }: NodeProps<CanvasNode>) {
  const definition = useContext(CatalogContext).get(`${data.nodeType}@${data.version}`);
  const notes = typeof data.config.notes === 'string' ? data.config.notes.trim() : '';
  const kicker = !definition ? '未安装' : definition.executable ? definition.title : '编排';
  return (
    <article className="flow-node" aria-label={data.title}>
      <Handle type="target" position={Position.Left} aria-label="执行输入" />
      <span className="flow-kicker">{kicker}</span>
      <h3>{data.title}</h3>
      {notes ? <p className="flow-note">{notes}</p> : null}
      <Handle type="source" position={Position.Right} aria-label="执行输出" />
    </article>
  );
}

export const canvasNodeTypes = { canvas: FlowNode };
