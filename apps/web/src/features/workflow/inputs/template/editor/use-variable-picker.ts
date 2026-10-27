import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Editor } from '@tiptap/react';
import {
  exitVariableSlashSuggestion,
  type SlashTriggerCallbacks,
} from '../variables/variable-slash-extension';

export function useVariablePicker(disabled: boolean, disabledRef: RefObject<boolean>) {
  const [buttonPickerOpen, setButtonPickerOpen] = useState(false);
  const [slashPickerOpen, setSlashPickerOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashRange, setSlashRange] = useState<{ from: number; to: number } | null>(null);

  if (disabled && buttonPickerOpen) setButtonPickerOpen(false);
  if (disabled && slashPickerOpen) setSlashPickerOpen(false);

  const slashRangeRef = useRef<{ from: number; to: number } | null>(null);
  const slashClientRectRef = useRef<(() => DOMRect | null) | null>(null);
  const slashPickerOpenRef = useRef(false);
  const slashCommandRef = useRef<HTMLDivElement | null>(null);

  const forwardSlashKeyToCommand = useCallback((event: KeyboardEvent): boolean => {
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Enter' ||
      event.key === 'Home' ||
      event.key === 'End'
    ) {
      const commandEl = slashCommandRef.current;
      if (commandEl) {
        event.preventDefault();
        commandEl.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: event.key,
            bubbles: true,
            cancelable: true,
          }),
        );
        return true;
      }
    }
    return false;
  }, []);

  const handleKeyDown = useCallback(
    (view: { state: { selection: { from: number; to: number } } }, event: KeyboardEvent) => {
      if (disabledRef.current) return false;
      if (slashPickerOpenRef.current) {
        if (event.key === 'Escape') {
          slashRangeRef.current = null;
          slashClientRectRef.current = null;
          setSlashRange(null);
          setSlashQuery('');
          setSlashPickerOpen(false);
          return true;
        }
        if (forwardSlashKeyToCommand(event)) {
          return true;
        }
      }
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const { from, to } = view.state.selection;
        slashRangeRef.current = { from, to };
        setSlashRange({ from, to });
        setSlashQuery('');
        setButtonPickerOpen(false);
        setSlashPickerOpen(true);
      }
      return false;
    },
    [disabledRef, forwardSlashKeyToCommand],
  );
  const reset = useCallback(() => {
    slashRangeRef.current = null;
    slashClientRectRef.current = null;
    setSlashRange(null);
    setSlashQuery('');
    setSlashPickerOpen(false);
  }, []);

  const close = useCallback(
    (editor: Editor | null) => {
      reset();
      exitVariableSlashSuggestion(editor);
    },
    [reset],
  );

  useLayoutEffect(() => {
    slashPickerOpenRef.current = slashPickerOpen;
  });

  const callbacks: SlashTriggerCallbacks = {
    onOpenSlash: ({ range, query, clientRect }) => {
      if (disabledRef.current) return;
      slashRangeRef.current = range;
      slashClientRectRef.current = clientRect;
      setSlashRange(range);
      setSlashQuery(query);
      setButtonPickerOpen(false);
      setSlashPickerOpen(true);
    },
    onUpdateSlash: ({ range, query, clientRect }) => {
      if (disabledRef.current) return;
      slashRangeRef.current = range;
      slashClientRectRef.current = clientRect;
      setSlashRange(range);
      setSlashQuery(query);
      setButtonPickerOpen(false);
      setSlashPickerOpen(true);
    },
    onCloseSlash: () => {
      slashRangeRef.current = null;
      slashClientRectRef.current = null;
      setSlashRange(null);
      setSlashQuery('');
      setSlashPickerOpen(false);
    },
    onKeyDownSlash: (event) => forwardSlashKeyToCommand(event),
  };

  return {
    buttonPickerOpen,
    setButtonPickerOpen,
    slashPickerOpen,
    slashQuery,
    slashRange,
    slashRangeRef,
    slashClientRectRef,
    slashCommandRef,
    handleKeyDown,
    callbacks,
    reset,
    close,
  };
}
