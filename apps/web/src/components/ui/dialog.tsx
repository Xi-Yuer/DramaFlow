'use client';

import { Modal } from 'antd';

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
  return (
    <Modal
      open
      title={title}
      onCancel={onClose}
      footer={footer ?? null}
      width={wide ? 880 : 560}
      centered
    >
      {children}
    </Modal>
  );
}
