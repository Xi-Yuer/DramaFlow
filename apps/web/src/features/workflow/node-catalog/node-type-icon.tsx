import {
  ArrowLeftFromLine,
  ArrowRightToLine,
  AudioLines,
  Box,
  BrainCircuit,
  Database,
  GitBranch,
  Image as ImageIcon,
  Video,
} from 'lucide-react';
import type { NodeMetadata } from '@dramaflow/contracts';

const nodeIcons = {
  input: <ArrowLeftFromLine size={16} />,
  ai: <BrainCircuit size={16} />,
  image: <ImageIcon size={16} />,
  video: <Video size={16} />,
  audio: <AudioLines size={16} />,
  flow: <GitBranch size={16} />,
  data: <Database size={16} />,
  output: <ArrowRightToLine size={16} />,
};
const metadataIcons = new Map([
  ['text', nodeIcons.ai],
  ['brain', nodeIcons.ai],
  ...Object.entries(nodeIcons),
]);

export function NodeTypeIcon({
  metadata,
}: {
  metadata?: Pick<NodeMetadata, 'icon'> & Partial<Pick<NodeMetadata, 'category'>>;
}) {
  return metadata ? (
    (metadataIcons.get(metadata.icon ?? '') ??
      (metadata.category ? nodeIcons[metadata.category] : <Box size={16} />))
  ) : (
    <Box size={16} />
  );
}
