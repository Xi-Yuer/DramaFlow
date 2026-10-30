import { VideoDetail } from '@/features/videos/detail/video-detail';

export default async function VideoPage({
  params,
  searchParams,
}: {
  params: Promise<{ videoId: string }>;
  searchParams?: Promise<{ workflowId?: string | string[] }>;
}) {
  const { videoId } = await params;
  const selected = (await searchParams)?.workflowId;
  return (
    <VideoDetail
      videoId={videoId}
      selectedWorkflowId={typeof selected === 'string' ? selected : undefined}
    />
  );
}
