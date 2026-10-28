import type { RuntimeNodeStatus } from '../runtime-status';

export type RuntimeVisualTone = 'idle' | 'pending' | 'running' | 'waiting' | 'completed' | 'failed';

export interface RuntimeStatusPresentation {
  status: RuntimeNodeStatus;
  label: string;
  canvasLabel: string;
  description: string;
  tone: RuntimeVisualTone;
  tagColor: 'default' | 'processing' | 'warning' | 'success' | 'error';
  badgeStatus: 'default' | 'processing' | 'warning' | 'success' | 'error';
  canvas: {
    icon: 'clock' | 'loader' | 'review' | 'check' | 'alert';
    display: 'hidden' | 'icon' | 'label';
  };
}

const BASE_PRESENTATION: Record<RuntimeNodeStatus, RuntimeStatusPresentation> = {
  idle: {
    status: 'idle',
    label: '尚未执行',
    canvasLabel: '尚未执行',
    description: '当前没有运行记录，或该节点尚未开始执行。',
    tone: 'idle',
    tagColor: 'default',
    badgeStatus: 'default',
    canvas: { icon: 'clock', display: 'hidden' },
  },
  pending: {
    status: 'pending',
    label: '等待执行',
    canvasLabel: '等待执行',
    description: '工作流正在排队或执行上游节点，当前节点等待执行。',
    tone: 'pending',
    tagColor: 'default',
    badgeStatus: 'default',
    canvas: { icon: 'clock', display: 'icon' },
  },
  running: {
    status: 'running',
    label: '正在执行',
    canvasLabel: '正在执行',
    description: '当前节点正在执行中。',
    tone: 'running',
    tagColor: 'processing',
    badgeStatus: 'processing',
    canvas: { icon: 'loader', display: 'label' },
  },
  waiting: {
    status: 'waiting',
    label: '等待人工操作',
    canvasLabel: '等待人工操作',
    description: '工作流在此节点暂停，等待人工处理后继续执行。',
    tone: 'waiting',
    tagColor: 'warning',
    badgeStatus: 'warning',
    canvas: { icon: 'review', display: 'label' },
  },
  completed: {
    status: 'completed',
    label: '执行完成',
    canvasLabel: '执行完成',
    description: '当前节点已执行完成。',
    tone: 'completed',
    tagColor: 'success',
    badgeStatus: 'success',
    canvas: { icon: 'check', display: 'icon' },
  },
  failed: {
    status: 'failed',
    label: '执行失败',
    canvasLabel: '执行失败',
    description: '当前节点执行失败，请查看错误详情。',
    tone: 'failed',
    tagColor: 'error',
    badgeStatus: 'error',
    canvas: { icon: 'alert', display: 'label' },
  },
};

const HUMAN_REVIEW_WAITING_PRESENTATION: RuntimeStatusPresentation = {
  ...BASE_PRESENTATION.waiting,
  label: '等待人工审核',
  canvasLabel: '等待人工审核',
  description: '工作流当前在此人工审批节点暂停，请审核内容并提交通过或拒绝决策。',
};

export function getRuntimeNodePresentation(
  status: RuntimeNodeStatus,
  options?: { isHumanReview?: boolean },
): RuntimeStatusPresentation {
  if (status === 'waiting' && options?.isHumanReview) {
    return HUMAN_REVIEW_WAITING_PRESENTATION;
  }
  return BASE_PRESENTATION[status];
}
