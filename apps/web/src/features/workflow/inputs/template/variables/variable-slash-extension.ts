import { Extension, type Editor } from '@tiptap/core';
import Suggestion, {
  exitSuggestion,
  SuggestionPluginKey,
  type SuggestionOptions,
} from '@tiptap/suggestion';
import type { VariableTokenMetadata, VariableTokenStorage } from './variable-token-extension';

export interface SlashSuggestionUpdate {
  range: { from: number; to: number };
  query: string;
  clientRect: (() => DOMRect | null) | null;
}

export interface SlashTriggerCallbacks {
  onOpenSlash: (payload: SlashSuggestionUpdate) => void;
  onUpdateSlash: (payload: SlashSuggestionUpdate) => void;
  onCloseSlash: () => void;
  onKeyDownSlash?: (event: KeyboardEvent) => boolean;
}

export interface VariableSlashStorage {
  callbacks: SlashTriggerCallbacks;
}

export function syncVariableEditorStorage(
  editor: { storage: unknown },
  metadata: VariableTokenMetadata,
  callbacks: SlashTriggerCallbacks,
) {
  const storage = editor.storage as {
    variableToken?: VariableTokenStorage;
    variableSlashSuggestion?: VariableSlashStorage;
  };
  if (storage.variableToken) {
    storage.variableToken.metadata = metadata;
  }
  if (storage.variableSlashSuggestion) {
    storage.variableSlashSuggestion.callbacks = callbacks;
  }
}

export function exitVariableSlashSuggestion(editor: Editor | null) {
  if (!editor || editor.isDestroyed) return;
  try {
    exitSuggestion(editor.view, SuggestionPluginKey);
  } catch {
    // ignore if view is not yet mounted
  }
}

export function resolveSuggestionClientRect(
  editor: Editor | null,
  range: { from: number; to: number } | null,
  suggestionClientRect?: (() => DOMRect | null) | null,
): DOMRect {
  if (suggestionClientRect) {
    const rect = suggestionClientRect();
    if (rect && (rect.width > 0 || rect.height > 0 || rect.top !== 0 || rect.left !== 0)) {
      return rect;
    }
  }
  if (!editor || editor.isDestroyed) {
    return new DOMRect(0, 0, 0, 0);
  }
  try {
    const docSize = editor.state.doc.content.size;
    const fromPos = range
      ? Math.max(0, Math.min(range.from, docSize))
      : Math.max(0, Math.min(editor.state.selection.from, docSize));
    const toPos = range ? Math.max(fromPos, Math.min(range.to, docSize)) : fromPos;
    const startCoords = editor.view.coordsAtPos(fromPos);
    const endCoords = toPos !== fromPos ? editor.view.coordsAtPos(toPos) : startCoords;
    const left = Math.min(startCoords.left, endCoords.left);
    const top = Math.min(startCoords.top, endCoords.top);
    const right = Math.max(startCoords.right, endCoords.right);
    const bottom = Math.max(startCoords.bottom, endCoords.bottom);
    if (left !== 0 || top !== 0 || right !== 0 || bottom !== 0) {
      return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
    }
  } catch {
    // fallback to editor DOM rect below
  }
  return editor.view.dom.getBoundingClientRect();
}

export const VariableSlashSuggestionExtension = Extension.create<
  Record<string, never>,
  VariableSlashStorage
>({
  name: 'variableSlashSuggestion',

  addStorage() {
    return {
      callbacks: {
        onOpenSlash: () => undefined,
        onUpdateSlash: () => undefined,
        onCloseSlash: () => undefined,
        onKeyDownSlash: undefined,
      },
    };
  },

  addProseMirrorPlugins() {
    const suggestionOptions: Omit<SuggestionOptions, 'editor'> = {
      char: '/',
      allowedPrefixes: null,
      startOfLine: false,
      render: () => ({
        onStart: (props) => {
          this.storage.callbacks.onOpenSlash({
            range: props.range,
            query: props.query,
            clientRect: props.clientRect ?? null,
          });
        },
        onUpdate: (props) => {
          this.storage.callbacks.onUpdateSlash({
            range: props.range,
            query: props.query,
            clientRect: props.clientRect ?? null,
          });
        },
        onKeyDown: (props) => {
          if (props.event.key === 'Escape') {
            this.storage.callbacks.onCloseSlash();
            return true;
          }
          return this.storage.callbacks.onKeyDownSlash?.(props.event) ?? false;
        },
        onExit: () => {
          this.storage.callbacks.onCloseSlash();
        },
      }),
    };

    return [
      Suggestion({
        editor: this.editor,
        ...suggestionOptions,
      }),
    ];
  },
});
