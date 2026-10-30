'use client';

import { CanvasPage } from '@/features/workflow/editor/canvas-page';
import { useProjectWorkspace } from '../workspace-context';

export function ProjectWorkflows() {
  const { project } = useProjectWorkspace();
  return <CanvasPage project={project} />;
}
