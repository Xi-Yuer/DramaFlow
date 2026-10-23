import { Check, CircleAlert, Clock3, Hand, LoaderCircle } from 'lucide-react';
import { getRuntimeNodePresentation } from './runtime-presentation';
import type { RuntimeNodeStatus } from './runtime-status';
import styles from './runtime-status.module.css';

const STATUS_ICONS = {
  clock: Clock3,
  loader: LoaderCircle,
  review: Hand,
  check: Check,
  alert: CircleAlert,
};

export function RuntimeCanvasStatus({
  status,
  isHumanReview = false,
}: {
  status: RuntimeNodeStatus;
  isHumanReview?: boolean;
}) {
  const presentation = getRuntimeNodePresentation(status, { isHumanReview });
  if (presentation.canvas.display === 'hidden') return null;
  const Icon = STATUS_ICONS[presentation.canvas.icon];
  return (
    <span
      className={styles.indicator}
      data-tone={presentation.tone}
      aria-label={`节点状态：${presentation.canvasLabel}`}
      title={presentation.description}
    >
      <Icon size={15} aria-hidden="true" />
      {presentation.canvas.display === 'label' ? <span>{presentation.canvasLabel}</span> : null}
    </span>
  );
}
