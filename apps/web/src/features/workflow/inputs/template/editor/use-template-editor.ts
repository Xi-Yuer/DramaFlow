import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useEditor, type Editor } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import History from '@tiptap/extension-history';
import Placeholder from '@tiptap/extension-placeholder';
import {
  bindingToTemplateEditorDocument,
  templateEditorDocumentToDraft,
  textAndVariablesToEditorDocument,
} from '../document';
import { nodeOutputVariables, textFromBinding } from '../binding';
import type { AvailableOutput } from '../types';
import { VariableTokenExtension } from '../variables/variable-token-extension';
import {
  exitVariableSlashSuggestion,
  syncVariableEditorStorage,
  VariableSlashSuggestionExtension,
} from '../variables/variable-slash-extension';
import { attachDomValueBridge } from './dom-value-bridge';
import { insertTemplateVariable } from './insert-template-variable';
import { useVariablePicker } from './use-variable-picker';
import type { TemplateInputProps, TemplateEditorDraft } from './types';
import styles from './template-input-editor.module.css';

export function useTemplateEditor({
  portName,
  binding,
  definition,
  manifests,
  disabled,
  onChange,
}: TemplateInputProps) {
  const bindingSignature = JSON.stringify(binding ?? null);
  const draftRef = useRef<TemplateEditorDraft>({
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

  const picker = useVariablePicker(disabled, disabledRef);
  const { handleKeyDown, callbacks, close, slashRangeRef, slashClientRectRef } = picker;

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
      handleKeyDown,
    }),
    [portName, disabled, handleKeyDown],
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

  const closeSlashPicker = useCallback(() => close(editor), [close, editor]);

  useLayoutEffect(() => {
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
      callbacks,
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
      slashClientRectRef.current = null;
    }
  }, [
    editor,
    binding,
    bindingSignature,
    disabled,
    definition,
    manifests,
    portName,
    slashRangeRef,
    slashClientRectRef,
  ]);

  function handleInsertVariable(output: AvailableOutput, sourceMode: 'slash' | 'button') {
    if (disabled || !editor || editor.isDestroyed) return;
    if (!insertTemplateVariable(editor, output, sourceMode, draftRef, picker.slashRangeRef.current))
      return;
    picker.reset();
    picker.setButtonPickerOpen(false);
    exitVariableSlashSuggestion(editor);
  }

  const fallbackVariables = nodeOutputVariables(binding);
  const currentVariables = editor
    ? templateEditorDocumentToDraft(editor.getJSON(), fallbackVariables).variables
    : fallbackVariables;

  return { editor, picker, closeSlashPicker, handleInsertVariable, currentVariables };
}
