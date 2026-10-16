'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertCircle } from 'lucide-react';
import { nodePresentation, controlPorts } from './node-presentation';
import type { WorkflowCanvasNode } from './graph-adapter';
import { cn } from '@/lib/utils';

export function WorkflowNodeView({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { node, definition, result } = data;
  const presentation = nodePresentation[node.type];
  const Icon = presentation.icon;
  const hasModel = typeof node.config.model === 'object' && node.config.model !== null;
  const outputs = definition?.outputs ?? [];
  const inputs = definition?.inputs ?? [];
  return (
    <div
      className={cn('flow-node', selected && 'selected')}
      style={{ '--node-color': presentation.color } as React.CSSProperties}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="control:in"
        style={{ top: 27 }}
        title="执行输入"
      />
      {controlPorts(node.type).map((port, index, ports) => (
        <Handle
          key={port}
          type="source"
          position={Position.Right}
          id={`control:${port}`}
          style={{ top: 21 + index * (ports.length > 1 ? 14 : 0) }}
          title={`执行输出 ${port}`}
        />
      ))}
      <div className="flow-node-header">
        <span className="node-icon">
          <Icon size={15} />
        </span>
        <span className="flow-node-title">{node.title}</span>
        <span className="node-version">{node.version}</span>
      </div>
      <div className="flow-node-body">
        {definition?.capability && !hasModel ? (
          <span className="plugin-note">
            <AlertCircle size={11} /> 请选择模型插件与连接
          </span>
        ) : typeof node.config.prompt === 'string' ? (
          <span>{node.config.prompt.slice(0, 62) || '填写该节点的生成需求'}</span>
        ) : (
          <span>{definition?.description ?? '节点版本暂不可用'}</span>
        )}
        <div
          className="node-port-grid"
          style={{
            minHeight: Math.max(inputs.length, outputs.length) * 19 + 8,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
            marginTop: 10,
          }}
        >
          <div>
            {inputs.map((port) => (
              <div key={port.name} style={{ height: 19, color: '#77918e' }}>
                {port.label}
                <Handle
                  type="target"
                  position={Position.Left}
                  id={`data:${port.name}`}
                  className="data-handle"
                  style={{ top: 104 + inputs.findIndex((item) => item.name === port.name) * 19 }}
                  title={`数据输入 ${port.label}`}
                />
              </div>
            ))}
          </div>
          <div style={{ textAlign: 'right' }}>
            {outputs.map((port, index) => (
              <div key={port.name} style={{ height: 19, color: '#77918e' }}>
                {port.label}
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`data:${port.name}`}
                  className="data-handle"
                  style={{ top: 104 + index * 19 }}
                  title={`数据输出 ${port.label}`}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flow-node-footer">
        <span>{presentation.tag}</span>
        {result && (
          <span className={cn('badge', result.status)} style={{ marginLeft: 'auto' }}>
            {
              {
                running: '运行中',
                waiting: '等待确认',
                succeeded: '已完成',
                skipped: '已跳过',
                failed: '失败',
                blocked: '已阻断',
              }[result.status]
            }
          </span>
        )}
      </div>
    </div>
  );
}
