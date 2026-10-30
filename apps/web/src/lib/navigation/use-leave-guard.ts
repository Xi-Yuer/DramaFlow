'use client';

import { useCallback, useEffect, useRef } from 'react';
import { App } from 'antd';

export type RequestLeave = (action: () => void | Promise<void>) => void;

export function useLeaveGuard(
  leavingUnsafe: boolean,
  title = '确认离开工作流编辑器？',
  content = '未保存的修改或尚未确认的操作只保留在当前页面，离开可能丢失这些信息。',
) {
  const { modal } = App.useApp();
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

  const requestLeave = useCallback<RequestLeave>(
    (action) => {
      if (pending.current) return;
      if (!leavingUnsafe) {
        void action();
        return;
      }
      pending.current = modal.confirm({
        title,
        content,
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
    [leavingUnsafe, modal, title, content],
  );

  return { leavingUnsafe, requestLeave };
}
