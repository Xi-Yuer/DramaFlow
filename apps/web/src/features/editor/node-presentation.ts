import {
  ArrowDownToLine,
  ArrowRightLeft,
  Boxes,
  Braces,
  GitBranch,
  Image,
  ListChecks,
  MessagesSquare,
  Sparkles,
  Video,
} from 'lucide-react';
import type { NodeType } from '@dramaflow/contracts';

export const nodePresentation = {
  input: { icon: Braces, color: '#b6e48c', tag: 'INPUT' },
  text: { icon: Sparkles, color: '#a8c5f0', tag: 'TEXT GENERATION' },
  image: { icon: Image, color: '#d2b5e6', tag: 'IMAGE GENERATION' },
  video: { icon: Video, color: '#e3b18b', tag: 'VIDEO GENERATION' },
  review: { icon: ListChecks, color: '#e0c477', tag: 'HUMAN REVIEW' },
  condition: { icon: GitBranch, color: '#8dc5bd', tag: 'CONDITION' },
  merge: { icon: ArrowRightLeft, color: '#96b7bd', tag: 'MERGE' },
  batch: { icon: Boxes, color: '#d5bb83', tag: 'BATCH' },
  output: { icon: ArrowDownToLine, color: '#b6e48c', tag: 'OUTPUT' },
} satisfies Record<NodeType, { icon: typeof MessagesSquare; color: string; tag: string }>;

export function controlPorts(type: NodeType): string[] {
  return type === 'condition'
    ? ['true', 'false']
    : type === 'review'
      ? ['out', 'approve', 'reject']
      : ['out'];
}
