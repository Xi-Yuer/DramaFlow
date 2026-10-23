'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, Popover } from 'antd';
import { Braces } from 'lucide-react';
import type {
  NodeTypeManifest,
  StaticInputBinding,
  WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  describeNodeOutput,
  displayTemplateSegments,
  draftBinding,
  nodeOutputVariables,
  removeVariable,
  sourceLabel,
  templateFromSegments,
  textFromBinding,
  variableNameForPort,
  type AvailableOutput,
  type TemplateSegment,
} from './template-input';
import styles from './template-input-editor.module.css';
import { CandidateInputSummary } from './candidate-input-summary';

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
  const root = useRef<HTMLDivElement>(null);
  const runs = useRef(new Map<number, HTMLTextAreaElement>());
  const appliedFocus = useRef<{ index: number; offset: number } | null>(null);
  const bindingSignature = JSON.stringify(binding ?? null);
  const [draft, setDraft] = useState(() => draftFrom(binding));
  const [caret, setCaret] = useState({ index: 0, start: 0, end: 0 });
  const [pendingFocus, setPendingFocus] = useState<{ index: number; offset: number } | null>(null);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  if (!focused && draft.signature !== bindingSignature) setDraft(draftFrom(binding));
  if (disabled && open) setOpen(false);

  useLayoutEffect(() => {
    if (!pendingFocus || appliedFocus.current === pendingFocus) return;
    appliedFocus.current = pendingFocus;
    const element = runs.current.get(pendingFocus.index);
    if (!element) return;
    element.focus();
    const offset = Math.min(pendingFocus.offset, element.value.length);
    element.setSelectionRange(offset, offset);
  }, [pendingFocus]);

  if (binding?.type === 'candidate') {
    return (
      <CandidateInputSummary
        portName={portName}
        binding={binding}
        definition={definition}
        manifests={manifests}
      />
    );
  }
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
  const segments = displayTemplateSegments(draft.text, names);
  const groups = new Map<string, AvailableOutput[]>();
  for (const output of outputs) {
    const group = groups.get(output.nodeId) ?? [];
    group.push(output);
    groups.set(output.nodeId, group);
  }
  const showPlaceholder = draft.text.length === 0;

  function focusAt(index: number, offset: number) {
    setPendingFocus({ index, offset });
    setCaret({ index, start: offset, end: offset });
    setFocused(true);
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

  function replaceSegments(
    next: TemplateSegment[],
    variables: ReturnType<typeof nodeOutputVariables>,
  ) {
    apply(templateFromSegments(next), variables);
  }

  function updateSegment(index: number, value: string, start: number, end: number) {
    setCaret({ index, start, end });
    replaceSegments(
      segments.map((segment, segmentIndex) =>
        segmentIndex === index && segment.kind === 'text' ? { kind: 'text', text: value } : segment,
      ),
      draft.variables,
    );
  }

  function deleteSource(name: string, segmentIndex: number) {
    const before = segments[segmentIndex - 1];
    const variables = { ...draft.variables };
    delete variables[name];
    focusAt(Math.max(0, segmentIndex - 1), before?.kind === 'text' ? before.text.length : 0);
    apply(removeVariable(draft.text, name), variables);
  }

  function selectionInField() {
    const active = document.activeElement;
    if (!(active instanceof HTMLTextAreaElement) || active.dataset.field !== fieldId) return null;
    const index = Number(active.dataset.segment);
    if (!Number.isInteger(index)) return null;
    return {
      index,
      start: active.selectionStart ?? 0,
      end: active.selectionEnd ?? 0,
    };
  }

  function insert(output: AvailableOutput) {
    const name = variableNameForPort(output.portKey, draft.variables, output);
    if (!name) return;
    const place = selectionInField() ?? caret;
    const index = Math.min(place.index, Math.max(0, segments.length - 1));
    const segment = segments[index];
    if (!segment || segment.kind !== 'text') return;
    const start = Math.min(place.start, segment.text.length);
    const end = Math.min(Math.max(place.end, start), segment.text.length);
    focusAt(index + 2, 0);
    setCaret({ index: index + 2, start: 0, end: 0 });
    replaceSegments(
      [
        ...segments.slice(0, index),
        { kind: 'text', text: segment.text.slice(0, start) },
        { kind: 'variable', name },
        { kind: 'text', text: segment.text.slice(end) },
        ...segments.slice(index + 1),
      ],
      {
        ...draft.variables,
        [name]: { type: 'node_output', nodeId: output.nodeId, portKey: output.portKey },
      },
    );
    setOpen(false);
  }

  return (
    <div ref={root} className={`nodrag nopan nowheel ${styles.editor}`}>
      <span className={styles.label}>{portName}</span>
      <div
        className={styles.composer}
        role="group"
        aria-label={portName}
        style={{ minHeight: `${rows * 1.6}em` }}
      >
        {segments.map((segment, index) => {
          if (segment.kind === 'variable') {
            const source = draft.variables[segment.name];
            const described = source
              ? describeNodeOutput(definition, manifests, source)
              : { nodeName: segment.name, portName: segment.name };
            const label = sourceLabel(described.nodeName, described.portName);
            return (
              <span
                key={`${segment.name}:${index}`}
                className={styles.chip}
                data-alias={segment.name}
              >
                <span>{label}</span>
                <button
                  type="button"
                  aria-label={`删除变量 ${described.nodeName} ${described.portName}`}
                  disabled={disabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => deleteSource(segment.name, index)}
                >
                  ×
                </button>
              </span>
            );
          }
          return (
            <span key={`text:${index}`} className={styles.run}>
              <span className={styles.mirror} aria-hidden="true">
                {segment.text || (showPlaceholder ? '输入文本，或插入上游输出' : '\u00a0')}
              </span>
              <textarea
                ref={(element) => {
                  if (element) runs.current.set(index, element);
                  else runs.current.delete(index);
                }}
                data-field={fieldId}
                data-segment={index}
                rows={1}
                value={segment.text}
                disabled={disabled}
                spellCheck={false}
                aria-label={`${portName}文本`}
                placeholder={showPlaceholder ? '输入文本，或插入上游输出' : undefined}
                onFocus={() => {
                  setFocused(true);
                  setCaret((current) => ({ ...current, index }));
                }}
                onBlur={(event) => {
                  const next = event.relatedTarget;
                  if (next instanceof Node && root.current?.contains(next)) return;
                  setFocused(false);
                  if (draftBinding(draft.text, draft.variables).status === 'invalid')
                    setDraft(draftFrom(binding));
                }}
                onSelect={(event) =>
                  setCaret({
                    index,
                    start: event.currentTarget.selectionStart ?? 0,
                    end: event.currentTarget.selectionEnd ?? 0,
                  })
                }
                onKeyDown={(event) => {
                  const element = event.currentTarget;
                  if (element.selectionStart !== element.selectionEnd) return;
                  if (event.key === 'Backspace' && element.selectionStart === 0) {
                    const previous = segments[index - 1];
                    if (previous?.kind !== 'variable') return;
                    event.preventDefault();
                    deleteSource(previous.name, index - 1);
                  }
                  if (event.key === 'Delete' && element.selectionStart === element.value.length) {
                    const next = segments[index + 1];
                    if (next?.kind !== 'variable') return;
                    event.preventDefault();
                    deleteSource(next.name, index + 1);
                  }
                }}
                onChange={(event) =>
                  updateSegment(
                    index,
                    event.currentTarget.value,
                    event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                    event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
                  )
                }
              />
            </span>
          );
        })}
      </div>
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
                  {group.map((output) => (
                    <button
                      key={`${output.nodeId}:${output.portKey}`}
                      type="button"
                      className={styles.option}
                      role="option"
                      aria-label={`${output.nodeName} ${output.portName}`}
                      aria-selected={false}
                      disabled={
                        variableNameForPort(output.portKey, draft.variables, output) === null
                      }
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insert(output)}
                    >
                      {output.portName}
                    </button>
                  ))}
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
