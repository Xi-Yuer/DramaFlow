import { CanvasPage } from '@/features/workflow/editor/canvas-page';

export default async function ProjectCanvasPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CanvasPage projectId={id} />;
}
