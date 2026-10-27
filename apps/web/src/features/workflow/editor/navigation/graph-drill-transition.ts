// 短生命周期的视图过渡。不进入 Definition、Location 或 Runtime。
// React Flow 只有单图 viewport 动画。跨图缩放的插值交给 Motion，这里只保留锚点与姿态。
export const DRILL_MOTION_MS = 280;

export interface DrillRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrillAnchor {
  rect: DrillRect;
  stageWidth: number;
  stageHeight: number;
}

export type DrillDirection = 'enter' | 'exit';

export interface DrillTransition {
  direction: DrillDirection;
  fromKey: string;
  toKey: string;
  anchor: DrillAnchor;
  phase: 'running';
}

export interface DrillPose {
  x: number;
  y: number;
  scale: number;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function captureDrillAnchor(
  nodeElement: Element | null,
  stageElement: Element | null,
): DrillAnchor | null {
  if (!(nodeElement instanceof HTMLElement) || !(stageElement instanceof HTMLElement)) return null;
  const stage = stageElement.getBoundingClientRect();
  const node = nodeElement.getBoundingClientRect();
  if (stage.width < 8 || stage.height < 8 || node.width < 8 || node.height < 8) return null;
  return {
    rect: {
      x: node.left - stage.left,
      y: node.top - stage.top,
      width: node.width,
      height: node.height,
    },
    stageWidth: stage.width,
    stageHeight: stage.height,
  };
}

export function anchorUsable(
  anchor: DrillAnchor | null,
  stageWidth: number,
  stageHeight: number,
): anchor is DrillAnchor {
  if (!anchor) return false;
  const { rect } = anchor;
  if (rect.width < 8 || rect.height < 8 || anchor.stageWidth < 8 || anchor.stageHeight < 8)
    return false;
  if (
    Math.abs(anchor.stageWidth - stageWidth) > 48 ||
    Math.abs(anchor.stageHeight - stageHeight) > 48
  )
    return false;
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  return centerX >= 0 && centerY >= 0 && centerX <= stageWidth && centerY <= stageHeight;
}

export function drillPose(anchor: DrillAnchor): DrillPose | null {
  if (!anchorUsable(anchor, anchor.stageWidth, anchor.stageHeight)) return null;
  const scale = Math.min(
    anchor.rect.width / anchor.stageWidth,
    anchor.rect.height / anchor.stageHeight,
  );
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const fitted = Math.min(Math.max(scale, 0.04), 0.92);
  return {
    x: anchor.rect.x + anchor.rect.width / 2 - anchor.stageWidth / 2,
    y: anchor.rect.y + anchor.rect.height / 2 - anchor.stageHeight / 2,
    scale: fitted,
  };
}

export interface DrillRequest {
  busy: boolean;
  reducedMotion: boolean;
  anchor: DrillAnchor | null;
  stageWidth: number;
  stageHeight: number;
  direction: DrillDirection;
  fromKey: string;
  toKey: string;
}

export interface DrillDecision {
  navigate: boolean;
  transition: DrillTransition | null;
}

// enter 先切换再放大；exit 先收缩，动画结束后再切换。锚点不可用时立即导航。
export function decideDrill(request: DrillRequest): DrillDecision {
  if (request.busy || request.fromKey === request.toKey)
    return { navigate: false, transition: null };
  const usable = anchorUsable(request.anchor, request.stageWidth, request.stageHeight);
  if (request.reducedMotion || !usable || !request.anchor)
    return { navigate: true, transition: null };
  return {
    navigate: request.direction === 'enter',
    transition: {
      direction: request.direction,
      fromKey: request.fromKey,
      toKey: request.toKey,
      anchor: request.anchor,
      phase: 'running',
    },
  };
}

export function completeDrill(transition: DrillTransition | null): boolean {
  return transition?.direction === 'exit';
}
