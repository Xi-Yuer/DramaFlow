import type { Editor } from '@tiptap/react';

export function attachDomValueBridge(
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
