'use client';

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  bindingSourceSchema,
  jsonValueSchema,
  type BindingSource,
  type InputBinding,
  type NodeDefinition,
  type WorkflowNode,
} from '@dramaflow/contracts';
import { useEditorStore } from './editor-store';
import { JsonEditor } from '@/components/ui/json-editor';
import { Button } from '@/components/ui/button';
import { createsCycle } from './graph-adapter';
import { resolveNodeDefinition } from './node-ports';

export function BindingEditor({
  node,
  definition,
  catalog,
  readOnly,
}: {
  node: WorkflowNode;
  definition?: NodeDefinition;
  catalog: NodeDefinition[];
  readOnly: boolean;
}) {
  const workflow = useEditorStore((state) => state.definition);
  const setBinding = useEditorStore((state) => state.setBinding);
  const removeBinding = useEditorStore((state) => state.removeBinding);
  const [customPort, setCustomPort] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bindings = workflow.bindings.filter((binding) => binding.nodeId === node.id);
  const ports = [
    ...(definition?.inputs ?? []),
    ...bindings
      .filter((binding) => !definition?.inputs.some((port) => port.name === binding.port))
      .map((binding) => ({
        name: binding.port,
        label: binding.port,
        dataType: 'any' as const,
        required: false,
      })),
  ];
  function apply(port: string, source: BindingSource, optional = false) {
    if (source.kind === 'node' && createsCycle(workflow, source.nodeId, node.id)) {
      setError('此绑定会使依赖形成循环，无法应用。');
      return;
    }
    setError(null);
    setBinding({ nodeId: node.id, port, source: bindingSourceSchema.parse(source), optional });
  }
  function sourceOptions() {
    return workflow.nodes
      .filter((upstream) => upstream.id !== node.id)
      .flatMap((upstream) =>
        (resolveNodeDefinition(upstream, catalog, workflow)?.outputs ?? []).map((port) => ({
          id: `${upstream.id}:${port.name}`,
          nodeId: upstream.id,
          port: port.name,
          label: `${upstream.title} → ${port.label}`,
        })),
      );
  }
  return (
    <div>
      {ports.map((port) => {
        const binding = bindings.find((item) => item.port === port.name);
        return (
          <BindingRow
            key={`${node.id}:${port.name}`}
            port={port.name}
            label={port.label}
            required={port.required}
            binding={binding}
            options={sourceOptions()}
            onChange={(source, optional) => apply(port.name, source, optional)}
            onRemove={() => removeBinding(node.id, port.name)}
            readOnly={readOnly}
          />
        );
      })}
      {(node.type === 'output' || node.type === 'merge') && (
        <div className="inline-form" style={{ margin: '12px 0' }}>
          <input
            aria-label="自定义输入名称"
            value={customPort}
            onChange={(event) => setCustomPort(event.target.value)}
            placeholder="自定义输入名称"
            disabled={readOnly}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="添加输入"
            disabled={
              readOnly ||
              !customPort.trim() ||
              ports.some((port) => port.name === customPort.trim())
            }
            onClick={() => {
              apply(customPort.trim(), { kind: 'literal', value: null });
              setCustomPort('');
            }}
          >
            <Plus />
          </Button>
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function BindingRow({
  port,
  label,
  required,
  binding,
  options,
  onChange,
  onRemove,
  readOnly,
}: {
  port: string;
  label: string;
  required?: boolean;
  binding?: InputBinding;
  options: { id: string; nodeId: string; port: string; label: string }[];
  onChange: (source: BindingSource, optional: boolean) => void;
  onRemove: () => void;
  readOnly: boolean;
}) {
  const kind = binding?.source.kind ?? '';
  const source = binding?.source;
  return (
    <div className="binding-row">
      <div className="binding-title">
        <span>
          {label}{' '}
          <span className="muted">
            {port}
            {required ? ' *' : ''}
          </span>
        </span>
        {binding && (
          <button
            type="button"
            aria-label={`移除 ${label} 绑定`}
            onClick={onRemove}
            disabled={readOnly}
            style={{ background: 'transparent', color: '#759085' }}
          >
            <X size={12} />
          </button>
        )}
      </div>
      <select
        aria-label={`${label} 数据来源`}
        value={kind}
        disabled={readOnly}
        onChange={(event) => {
          if (event.target.value === 'literal') onChange({ kind: 'literal', value: '' }, false);
          if (event.target.value === 'input') onChange({ kind: 'input', path: 'value' }, false);
          if (event.target.value === 'node' && options[0])
            onChange({ kind: 'node', nodeId: options[0].nodeId, port: options[0].port }, false);
        }}
      >
        <option value="" disabled>
          选择数据来源
        </option>
        <option value="node" disabled={!options.length}>
          上游节点输出
        </option>
        <option value="input">工作流运行输入</option>
        <option value="literal">固定值</option>
      </select>
      {source?.kind === 'node' && (
        <>
          <select
            style={{ marginTop: 8 }}
            value={`${source.nodeId}:${source.port}`}
            disabled={readOnly}
            aria-label={`${label} 上游端口`}
            onChange={(event) => {
              const selected = options.find((option) => option.id === event.target.value);
              if (selected)
                onChange(
                  { kind: 'node', nodeId: selected.nodeId, port: selected.port },
                  binding?.optional ?? false,
                );
            }}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            style={{ marginTop: 8, fontSize: 10 }}
            disabled={readOnly}
            aria-label={`${label} 数据路径`}
            placeholder="可选路径，例如 scenes.0.prompt"
            value={source.path ?? ''}
            onChange={(event) =>
              onChange(
                { ...source, path: event.target.value || undefined },
                binding?.optional ?? false,
              )
            }
          />
        </>
      )}
      {source?.kind === 'input' && (
        <input
          style={{ marginTop: 8, fontSize: 10 }}
          aria-label={`${label} 运行输入路径`}
          placeholder="输入路径，如 brief"
          disabled={readOnly}
          value={source.path}
          onChange={(event) => {
            if (event.target.value)
              onChange({ kind: 'input', path: event.target.value }, binding?.optional ?? false);
          }}
        />
      )}
      {source?.kind === 'literal' && (
        <div style={{ marginTop: 8 }}>
          <JsonEditor
            label="JSON 值"
            value={source.value}
            onChange={(value) =>
              onChange(
                { kind: 'literal', value: jsonValueSchema.parse(value) },
                binding?.optional ?? false,
              )
            }
            disabled={readOnly}
          />
        </div>
      )}
      {binding && (
        <label className="check-field" style={{ margin: '8px 0 2px', fontSize: 10 }}>
          <input
            type="checkbox"
            checked={binding.optional}
            disabled={readOnly}
            onChange={(event) => onChange(binding.source, event.target.checked)}
          />
          允许上游被跳过时缺省
        </label>
      )}
    </div>
  );
}
