import { ProjectWorkflowCanvas } from '@/features/workflow/management/project-workflow-canvas';
export default async function WorkflowCanvasPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  return <ProjectWorkflowCanvas workflowId={workflowId} />;
}
