import type { RefObject } from 'react';
import type { Editor } from '@tiptap/react';
import { templateEditorDocumentToDraft } from '../document';
import { variableNameForPort } from '../binding';
import type { AvailableOutput, NodeOutputVariables } from '../types';
import type { TemplateEditorDraft } from './types';

export function insertTemplateVariable(
  editor: Editor,
  output: AvailableOutput,
  sourceMode: 'slash' | 'button',
  draftRef: RefObject<TemplateEditorDraft>,
  slashRange: { from: number; to: number } | null,
): boolean {
  const current = templateEditorDocumentToDraft(editor.getJSON(), draftRef.current.variables);
  const alias = variableNameForPort(output.portKey, current.variables, output);
  if (!alias) return false;

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

  const activeSlashRange = sourceMode === 'slash' ? slashRange : null;
  if (activeSlashRange) {
    const docSize = editor.state.doc.content.size;
    const from = Math.max(1, Math.min(activeSlashRange.from, docSize));
    const to = Math.max(from, Math.min(activeSlashRange.to, docSize));
    const textInRange = editor.state.doc.textBetween(from, to, '');
    if (textInRange.startsWith('/')) {
      editor.chain().focus().insertContentAt({ from, to }, tokenContent).run();
    } else {
      editor.chain().focus().insertContent(tokenContent).run();
    }
  } else {
    editor.chain().focus().insertContent(tokenContent).run();
  }

  return true;
}
