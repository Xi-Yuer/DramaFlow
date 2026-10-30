'use client';
import { CanvasPage } from '../editor/canvas-page';
import { useProjectWorkspace } from '@/features/projects/workspace/workspace-context';
export function ProjectWorkflowCanvas({ workflowId }: { workflowId: string }) {
  const { project } = useProjectWorkspace();
  return <CanvasPage project={project} workflowId={workflowId} />;
}
