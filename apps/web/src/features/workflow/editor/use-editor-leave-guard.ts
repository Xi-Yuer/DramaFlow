'use client';
import { useCallback, useEffect, useRef } from 'react';
import { App } from 'antd';
import { editorLeavingUnsafe, type EditorLeaveState } from './editor-leave-safety';

export function useEditorLeaveGuard(state: EditorLeaveState) {
  const { modal } = App.useApp();
  const leavingUnsafe = editorLeavingUnsafe(state);
  const pending = useRef<{ destroy(): void } | null>(null);

  useEffect(() => {
    if (!leavingUnsafe) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [leavingUnsafe]);

  useEffect(() => () => pending.current?.destroy(), []);

  const requestLeave = useCallback(
    (action: () => void | Promise<void>) => {
      if (pending.current) return;
      if (!leavingUnsafe) {
        void action();
        return;
      }
      pending.current = modal.confirm({
        title: '确认离开工作流编辑器？',
        content: '未保存的修改或尚未确认的操作只保留在当前页面，离开可能丢失这些信息。',
        okText: '离开',
        cancelText: '继续编辑',
        onOk: () => {
          pending.current = null;
          return action();
        },
        onCancel: () => {
          pending.current = null;
        },
      });
    },
    [leavingUnsafe, modal],
  );

  return { leavingUnsafe, requestLeave };
}
