import { ProjectWorkspace } from '@/features/projects/workspace/project-workspace';

export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id } = await params;
  return <ProjectWorkspace projectId={id}>{children}</ProjectWorkspace>;
}
