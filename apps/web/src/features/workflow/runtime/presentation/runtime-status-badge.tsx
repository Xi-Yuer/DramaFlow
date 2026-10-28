'use client';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { getRuntimeNodePresentation, type RuntimeVisualTone } from './runtime-presentation';
import type { RuntimeNodeStatus } from '../runtime-status';
import styles from './runtime-status.module.css';

const BADGE_CLASS_BY_TONE: Record<RuntimeVisualTone, string> = {
  idle: styles.badge_idle ?? '',
  pending: styles.badge_pending ?? '',
  running: styles.badge_running ?? '',
  waiting: styles.badge_waiting ?? '',
  completed: styles.badge_completed ?? '',
  failed: styles.badge_failed ?? '',
};

const NODE_CLASS_BY_TONE: Record<RuntimeVisualTone, string> = {
  idle: styles.node_idle ?? '',
  pending: styles.node_pending ?? '',
  running: styles.node_running ?? '',
  waiting: styles.node_waiting ?? '',
  completed: styles.node_completed ?? '',
  failed: styles.node_failed ?? '',
};

const SHADCN_BADGE_VARIANT: Record<RuntimeVisualTone, NonNullable<BadgeProps['variant']>> = {
  idle: 'secondary',
  pending: 'secondary',
  running: 'processing',
  waiting: 'warning',
  completed: 'success',
  failed: 'error',
};

export function runtimeNodeBorderClass(
  status: RuntimeNodeStatus,
  options?: { isHumanReview?: boolean },
): string {
  const presentation = getRuntimeNodePresentation(status, options);
  return NODE_CLASS_BY_TONE[presentation.tone];
}

export function RuntimeStatusBadge({
  status,
  isHumanReview = false,
  variant = 'canvas',
}: {
  status: RuntimeNodeStatus;
  isHumanReview?: boolean;
  variant?: 'canvas' | 'inspector';
}) {
  const presentation = getRuntimeNodePresentation(status, { isHumanReview });
  if (variant === 'inspector') {
    return (
      <Badge
        variant={SHADCN_BADGE_VARIANT[presentation.tone]}
        data-runtime-status={presentation.status}
      >
        {presentation.label}
      </Badge>
    );
  }
  return (
    <span
      className={`${styles.badge} ${BADGE_CLASS_BY_TONE[presentation.tone]}`}
      data-runtime-status={presentation.status}
      aria-label={`节点状态：${presentation.canvasLabel}`}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span>{presentation.canvasLabel}</span>
    </span>
  );
}
