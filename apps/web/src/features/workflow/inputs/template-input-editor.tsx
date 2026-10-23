'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import History from '@tiptap/extension-history';
import Placeholder from '@tiptap/extension-placeholder';
import type {
  NodeTypeManifest,
  StaticInputBinding,
  WorkflowDefinition,
} from '@dramaflow/contracts';
import { CandidateInputSummary } from './candidate-input-summary';
import {
  bindingToTemplateEditorDocument,
  describeNodeOutput,
  nodeOutputVariables,
  sourceLabel,
  templateEditorDocumentToDraft,
  textAndVariablesToEditorDocument,
  textFromBinding,
  variableNameForPort,
  type AvailableOutput,
  type NodeOutputVariables,
} from './template-input';
import { VariablePicker } from './variable-picker';
import {
  syncVariableEditorStorage,
  VariableSlashSuggestionExtension,
  VariableTokenExtension,
} from './variable-token-extension';
import styles from './template-input-editor.module.css';

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

function attachDomValueBridge(
  editor: Editor,
  getText: () => string,
  getDisabled: () => boolean,
  onStageExternalText: (value: string) => void,
  onCommitExternalText: () => void,
) {
  const dom = editor.view?.dom as
    (HTMLElement & { value?: string; disabled?: boolean }) | undefined;
  if (!dom) return;
  Object.defineProperty(dom, 'value', {
    configurable: true,
    get: () => getText(),
    set: (nextValue: unknown) => {
      if (getDisabled()) return;
      onStageExternalText(String(nextValue ?? ''));
    },
  });
  Object.defineProperty(dom, 'disabled', {
    configurable: true,
    get: () => getDisabled(),
  });
  dom.onchange = () => {
    if (getDisabled()) return;
    onCommitExternalText();
  };
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

  return (
    <EditableTemplateInput
      portName={portName}
      rows={rows}
      binding={binding}
      outputs={outputs}
      definition={definition}
      manifests={manifests}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

function EditableTemplateInput({
  portName,
  rows,
  binding,
  outputs,
  definition,
  manifests,
  disabled,
  onChange,
}: {
  portName: string;
  rows: number;
  binding: StaticInputBinding | undefined;
  outputs: readonly AvailableOutput[];
  definition: Pick<WorkflowDefinition, 'nodes'>;
  manifests: readonly NodeTypeManifest[];
  disabled: boolean;
  onChange: (binding: StaticInputBinding | null) => void;
}) {
  const bindingSignature = JSON.stringify(binding ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  if (disabled && pickerOpen) setPickerOpen(false);

  const slashRangeRef = useRef<{ from: number; to: number } | null>(null);
  const pickerOpenRef = useRef(false);

  const draftRef = useRef<{
    signature: string;
    text: string;
    variables: NodeOutputVariables;
  }>({
    signature: bindingSignature,
    text: textFromBinding(binding),
    variables: nodeOutputVariables(binding),
  });

  const onChangeRef = useRef(onChange);
  const bindingSignatureRef = useRef(bindingSignature);
  const disabledRef = useRef(disabled);

  const commitEditorState = useCallback((currentEditor: Editor) => {
    const json = currentEditor.getJSON();
    const { text, variables, draft } = templateEditorDocumentToDraft(
      json,
      draftRef.current.variables,
    );
    if (draft.status === 'invalid') {
      draftRef.current = { ...draftRef.current, text, variables };
      return;
    }
    const nextBinding = draft.status === 'clear' ? null : draft.binding;
    const nextSignature = JSON.stringify(nextBinding);
    draftRef.current = { signature: nextSignature, text, variables };
    if (nextSignature !== bindingSignatureRef.current) {
      bindingSignatureRef.current = nextSignature;
      onChangeRef.current(nextBinding);
    }
  }, []);

  const initialContent = useMemo(
    () => bindingToTemplateEditorDocument(binding),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const extensions = useMemo(
    () => [
      Document,
      Paragraph,
      Text,
      HardBreak,
      History,
      Placeholder.configure({
        placeholder: '输入文本，输入 / 或点击下方按钮插入上游变量',
      }),
      VariableTokenExtension,
      VariableSlashSuggestionExtension,
    ],
    [],
  );

  const editorProps = useMemo(
    () => ({
      attributes: {
        class: styles.prosemirror ?? '',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': `${portName}文本`,
        'aria-disabled': disabled ? 'true' : 'false',
        spellcheck: 'false',
      },
      handleKeyDown: (
        view: { state: { selection: { from: number; to: number } } },
        event: KeyboardEvent,
      ) => {
        if (disabledRef.current) return false;
        if (event.key === 'Escape' && pickerOpenRef.current) {
          slashRangeRef.current = null;
          setSlashQuery('');
          setPickerOpen(false);
          return true;
        }
        if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const { from, to } = view.state.selection;
          slashRangeRef.current = { from, to };
          setSlashQuery('');
          setPickerOpen(true);
        }
        return false;
      },
    }),
    [portName, disabled],
  );

  const editor = useEditor({
    immediatelyRender: typeof window !== 'undefined',
    editable: !disabled,
    content: initialContent,
    extensions,
    editorProps,
    onUpdate: ({ editor: updatedEditor }) => {
      commitEditorState(updatedEditor);
    },
  });

  useLayoutEffect(() => {
    pickerOpenRef.current = pickerOpen;
    onChangeRef.current = onChange;
    bindingSignatureRef.current = bindingSignature;
    disabledRef.current = disabled;
    if (!editor || editor.isDestroyed) return;
    syncVariableEditorStorage(
      editor,
      {
        definition,
        manifests,
        disabled,
        chipClassName: styles.chip ?? '',
        chipLabelClassName: styles.chipLabel ?? '',
        chipRemoveClassName: styles.chipRemove ?? '',
      },
      {
        onOpenSlash: (range, query) => {
          if (disabledRef.current) return;
          slashRangeRef.current = range;
          setSlashQuery(query);
          setPickerOpen(true);
        },
        onUpdateSlash: (range, query) => {
          if (disabledRef.current) return;
          slashRangeRef.current = range;
          setSlashQuery(query);
          setPickerOpen(true);
        },
        onCloseSlash: () => {
          slashRangeRef.current = null;
          setSlashQuery('');
        },
      },
    );
    attachDomValueBridge(
      editor,
      () => draftRef.current.text,
      () => disabledRef.current,
      (nextText) => {
        const doc = textAndVariablesToEditorDocument(nextText, draftRef.current.variables);
        editor.commands.setContent(doc, { emitUpdate: false });
        draftRef.current = { ...draftRef.current, text: nextText };
      },
      () => {
        commitEditorState(editor);
      },
    );
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (bindingSignature !== draftRef.current.signature) {
      draftRef.current = {
        signature: bindingSignature,
        text: textFromBinding(binding),
        variables: nodeOutputVariables(binding),
      };
      editor.commands.setContent(bindingToTemplateEditorDocument(binding), { emitUpdate: false });
    }
    editor.setEditable(!disabled, false);
    editor.view.dom.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    editor.view.dom.setAttribute('aria-label', `${portName}文本`);
    editor.view.dispatch(editor.state.tr.setMeta('refreshVariableMetadata', true));
    if (disabled) {
      slashRangeRef.current = null;
    }
  }, [editor, binding, bindingSignature, disabled, definition, manifests, portName]);

  function handleInsertVariable(output: AvailableOutput) {
    if (disabled || !editor || editor.isDestroyed) return;
    const current = templateEditorDocumentToDraft(editor.getJSON(), draftRef.current.variables);
    const alias = variableNameForPort(output.portKey, current.variables, output);
    if (!alias) return;

    const nextVariables: NodeOutputVariables = {
      ...current.variables,
      [alias]: {
        type: 'node_output',
        nodeId: output.nodeId,
        portKey: output.portKey,
      },
    };
    draftRef.current = {
      ...draftRef.current,
      variables: nextVariables,
    };

    const tokenContent = {
      type: 'variableToken',
      attrs: {
        alias,
        nodeId: output.nodeId,
        portKey: output.portKey,
      },
    };

    const slashRange = slashRangeRef.current;
    if (slashRange) {
      const docSize = editor.state.doc.content.size;
      const from = Math.max(1, Math.min(slashRange.from, docSize));
      const to = Math.max(from, Math.min(slashRange.to, docSize));
      const textInRange = editor.state.doc.textBetween(from, to, '');
      if (textInRange.startsWith('/')) {
        editor.chain().focus().insertContentAt({ from, to }, tokenContent).run();
      } else {
        editor.chain().focus().insertContent(tokenContent).run();
      }
    } else {
      editor.chain().focus().insertContent(tokenContent).run();
    }

    slashRangeRef.current = null;
    setSlashQuery('');
    setPickerOpen(false);
  }

  const staticDoc = bindingToTemplateEditorDocument(binding);
  const fallbackVariables = nodeOutputVariables(binding);
  const currentVariables = editor
    ? templateEditorDocumentToDraft(editor.getJSON(), fallbackVariables).variables
    : fallbackVariables;

  return (
    <div className={`nodrag nopan nowheel ${styles.editor}`}>
      <div className={styles.labelRow}>
        <span className={styles.label}>{portName}</span>
        <span className={styles.hint}>输入 / 插入变量</span>
      </div>
      <div
        className={`${styles.composer}${disabled ? ` ${styles.composerDisabled}` : ''}`}
        role="group"
        aria-label={portName}
        style={{ minHeight: `${rows * 1.65}em` }}
      >
        {editor ? (
          <EditorContent editor={editor} />
        ) : (
          <div
            className={styles.prosemirror}
            role="textbox"
            aria-multiline="true"
            aria-label={`${portName}文本`}
            aria-disabled={disabled ? 'true' : 'false'}
          >
            {staticDoc.content.map((paragraph, pIndex) => (
              <p key={pIndex}>
                {(paragraph.content ?? []).map((inline, iIndex) => {
                  if (inline.type === 'text') {
                    return <span key={iIndex}>{inline.text}</span>;
                  }
                  if (inline.type === 'variableToken') {
                    const described = describeNodeOutput(definition, manifests, {
                      nodeId: inline.attrs.nodeId,
                      portKey: inline.attrs.portKey,
                    });
                    const label = sourceLabel(described.nodeName, described.portName);
                    return (
                      <span
                        key={`${inline.attrs.alias}:${iIndex}`}
                        className={styles.chip}
                        data-alias={inline.attrs.alias}
                        data-variable-token={inline.attrs.alias}
                      >
                        <span className={styles.chipLabel}>{label}</span>
                        <button
                          type="button"
                          className={styles.chipRemove}
                          disabled={disabled}
                          aria-label={`删除变量 ${described.nodeName} ${described.portName}`}
                        >
                          ×
                        </button>
                      </span>
                    );
                  }
                  return null;
                })}
              </p>
            ))}
          </div>
        )}
      </div>
      <div className={styles.footer}>
        <VariablePicker
          portName={portName}
          open={pickerOpen && !disabled}
          onOpenChange={(next) => {
            if (!disabled) {
              setPickerOpen(next);
              if (!next) {
                slashRangeRef.current = null;
                setSlashQuery('');
              }
            }
          }}
          outputs={outputs}
          variables={currentVariables}
          disabled={disabled}
          slashQuery={slashQuery}
          onSelect={handleInsertVariable}
        />
      </div>
    </div>
  );
}
