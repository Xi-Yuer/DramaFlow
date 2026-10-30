import { Tag } from 'antd';
import type { VideoStatus } from '@dramaflow/contracts';

export const videoStatusLabels: Record<VideoStatus, string> = {
  draft: '草稿',
  active: '进行中',
  completed: '已完成',
};
const colors: Record<VideoStatus, string> = {
  draft: 'default',
  active: 'cyan',
  completed: 'green',
};

export function VideoStatusTag({ status }: { status: VideoStatus }) {
  return <Tag color={colors[status]}>{videoStatusLabels[status]}</Tag>;
}
