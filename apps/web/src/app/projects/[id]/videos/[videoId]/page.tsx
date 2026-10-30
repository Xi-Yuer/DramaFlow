import { VideoDetail } from '@/features/videos/detail/video-detail';

export default async function VideoPage({ params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  return <VideoDetail videoId={videoId} />;
}
