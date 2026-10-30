import type { WorkflowResponse } from '@dramaflow/contracts';

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, value));
}

export function clampViewport(
  viewport: WorkflowResponse['viewport'],
): WorkflowResponse['viewport'] {
  return {
    x: clamp(viewport.x, -1_000_000, 1_000_000),
    y: clamp(viewport.y, -1_000_000, 1_000_000),
    zoom: clamp(viewport.zoom, 0.1, 3),
  };
}

export function draftSignature(name: string, viewport: WorkflowResponse['viewport']) {
  const view = clampViewport(viewport);
  return JSON.stringify({
    name: name.trim(),
    viewport: {
      x: Number(view.x.toFixed(2)),
      y: Number(view.y.toFixed(2)),
      zoom: Number(view.zoom.toFixed(3)),
    },
  });
}
