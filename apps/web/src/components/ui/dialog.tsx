'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';

export function Dialog({
  title,
  children,
  footer,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={cn('native-dialog', wide && 'wide')}
      onCancel={onClose}
      aria-label={title}
    >
      <div className="dialog-header">
        <h2>{title}</h2>
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="关闭对话框">
          <X />
        </Button>
      </div>
      <div className="dialog-content">{children}</div>
      {footer && <div className="dialog-footer">{footer}</div>}
    </dialog>
  );
}
