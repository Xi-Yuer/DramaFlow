'use client';
import { WorkflowCollection } from '@/features/workflow/management/workflow-collection';
import { useProjectWorkspace } from '../workspace-context';
export function ProjectWorkflows() {
  const { project } = useProjectWorkspace();
  return <WorkflowCollection projectId={project.id} />;
}
