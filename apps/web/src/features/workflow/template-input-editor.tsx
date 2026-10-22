'use client';

import { useId, useRef, useState } from 'react';
import { Button, Popover } from 'antd';
import { Braces } from 'lucide-react';
import type {
  NodeTypeManifest,
  StaticInputBinding,
  WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  describeNodeOutput,
  draftBinding,
  insertVariable,
  nodeOutputVariables,
  removeVariable,
  textFromBinding,
  variableNameForPort,
  type AvailableOutput,
} from './template-input';
import styles from './template-input-editor.module.css';

function draftFrom(binding: StaticInputBinding | undefined) {
  return {
    signature: JSON.stringify(binding ?? null),
    text: textFromBinding(binding),
    variables: nodeOutputVariables(binding),
  };
}

function readOnlyReason(binding: StaticInputBinding | undefined, connected: boolean) {
  if (connected) return '该输入由连线提供';
  if (binding?.type === 'workflow_input') return '该输入来自工作流输入';
  if (binding?.type === 'asset') return '该输入来自资产';
  if (
    binding?.type === 'template' &&
    Object.values(binding.variables).some((source) => source.type !== 'node_output')
  )
    return '该模板包含当前不能编辑的变量';
  return null;
}

export function TemplateInputEditor({
  portName,
  rows = 4,
  binding,
  connected,
  outputs,
  definition,
  manifests,
  disabled,
  onChange,
}: {
  portName: string;
  rows?: number;
  binding: StaticInputBinding | undefined;
  connected: boolean;
  outputs: readonly AvailableOutput[];
  definition: Pick<WorkflowDefinition, 'nodes'>;
  manifests: readonly NodeTypeManifest[];
  disabled: boolean;
  onChange: (binding: StaticInputBinding | null) => void;
}) {
  const fieldId = useId();
  const highlight = useRef<HTMLPreElement>(null);
  const bindingSignature = JSON.stringify(binding ?? null);
  const [draft, setDraft] = useState(() => draftFrom(binding));
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  if (!focused && draft.signature !== bindingSignature) setDraft(draftFrom(binding));
  if (disabled && open) setOpen(false);

  const reason = readOnlyReason(binding, connected);
  if (reason) {
    return (
      <div className={`nodrag nopan nowheel ${styles.editor}`}>
        <span className={styles.label}>{portName}</span>
        <p className={styles.locked} role="status">
          {reason}
        </p>
      </div>
    );
  }

  const names = new Set(Object.keys(draft.variables));
  const groups = new Map<string, AvailableOutput[]>();
  for (const output of outputs) {
    const group = groups.get(output.nodeId) ?? [];
    group.push(output);
    groups.set(output.nodeId, group);
  }

  function remember(target: HTMLTextAreaElement) {
    setSelection({ start: target.selectionStart ?? 0, end: target.selectionEnd ?? 0 });
  }

  function apply(text: string, variables: ReturnType<typeof nodeOutputVariables>) {
    const result = draftBinding(text, variables);
    if (result.status === 'invalid') {
      setDraft((current) => ({ ...current, text, variables }));
      return;
    }
    const next = result.status === 'clear' ? null : result.binding;
    const signature = JSON.stringify(next);
    const nextVariables = next?.type === 'template' ? nodeOutputVariables(next) : {};
    setDraft({ signature, text, variables: nextVariables });
    if (signature !== bindingSignature) onChange(next);
  }

  function insert(output: AvailableOutput) {
    const name = variableNameForPort(output.portKey, draft.variables, output);
    if (!name) return null;
    const inserted = insertVariable(draft.text, selection.start, selection.end, name);
    apply(inserted.text, {
      ...draft.variables,
      [name]: { type: 'node_output', nodeId: output.nodeId, portKey: output.portKey },
    });
    setSelection({ start: inserted.cursor, end: inserted.cursor });
    setOpen(false);
    return inserted.cursor;
  }

  return (
    <div className={`nodrag nopan nowheel ${styles.editor}`}>
      <label className={styles.label} htmlFor={fieldId}>
        {portName}
      </label>
      <div className={styles.shell}>
        <pre ref={highlight} className={styles.highlight} aria-hidden="true">
          {draft.text.split(/(\{\{[A-Za-z][A-Za-z0-9_]*\}\})/g).map((part, index) => {
            const name = /^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/.exec(part)?.[1];
            if (name && names.has(name))
              return (
                <mark key={index} className={styles.token}>
                  {part}
                </mark>
              );
            return <span key={index}>{part}</span>;
          })}
          {'\u200b'}
        </pre>
        <textarea
          id={fieldId}
          className={styles.field}
          rows={rows}
          value={draft.text}
          disabled={disabled}
          placeholder="输入文本，或插入上游输出"
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (draftBinding(draft.text, draft.variables).status === 'invalid')
              setDraft(draftFrom(binding));
          }}
          onSelect={(event) => remember(event.currentTarget)}
          onKeyUp={(event) => remember(event.currentTarget)}
          onClick={(event) => remember(event.currentTarget)}
          onScroll={(event) => {
            if (!highlight.current) return;
            highlight.current.scrollTop = event.currentTarget.scrollTop;
            highlight.current.scrollLeft = event.currentTarget.scrollLeft;
          }}
          onChange={(event) => {
            remember(event.currentTarget);
            apply(event.currentTarget.value, draft.variables);
          }}
        />
      </div>
      {Object.keys(draft.variables).length > 0 ? (
        <div className={styles.chips}>
          {Object.entries(draft.variables).map(([name, source]) => {
            const described = describeNodeOutput(definition, manifests, source);
            return (
              <span key={name} className={styles.chip}>
                <span>
                  {described.nodeName} / {described.portName}
                </span>
                <code>{`{{${name}}}`}</code>
                <button
                  type="button"
                  aria-label={`删除变量 ${described.nodeName} ${described.portName}`}
                  disabled={disabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const variables = { ...draft.variables };
                    delete variables[name];
                    apply(removeVariable(draft.text, name), variables);
                  }}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      <Popover
        key={open ? 'open' : 'closed'}
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="bottomLeft"
        destroyOnHidden
        getPopupContainer={() => document.body}
        content={
          <div className={styles.menu} role="listbox" aria-label={`${portName}的可用上游输出`}>
            {groups.size === 0 ? (
              <p className={styles.empty}>没有可引用的上游文本输出</p>
            ) : (
              [...groups.values()].map((group) => (
                <section
                  key={group[0]?.nodeId}
                  className={styles.group}
                  aria-label={group[0]?.nodeName}
                >
                  <h3>{group[0]?.nodeName}</h3>
                  {group.map((output) => {
                    const name = variableNameForPort(output.portKey, draft.variables, output);
                    return (
                      <button
                        key={`${output.nodeId}:${output.portKey}`}
                        type="button"
                        className={styles.option}
                        role="option"
                        aria-label={`${output.nodeName} ${output.portName}`}
                        aria-selected={false}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          const cursor = insert(output);
                          if (cursor === null) return;
                          const element = document.getElementById(fieldId);
                          if (!(element instanceof HTMLTextAreaElement)) return;
                          element.focus();
                          element.setSelectionRange(cursor, cursor);
                        }}
                      >
                        <span>{output.portName}</span>
                        <code>{name ? `{{${name}}}` : '无法命名'}</code>
                      </button>
                    );
                  })}
                </section>
              ))
            )}
          </div>
        }
      >
        <Button
          size="small"
          autoInsertSpace={false}
          disabled={disabled}
          aria-label={`向${portName}插入变量`}
          icon={<Braces size={14} />}
          onMouseDown={(event) => event.preventDefault()}
        >
          插入变量
        </Button>
      </Popover>
    </div>
  );
}
