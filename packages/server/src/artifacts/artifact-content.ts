import { createHash } from 'node:crypto';
import type { DataType } from '@dramaflow/contracts';
import { z } from 'zod';

const mediaTypes = new Set([
  'media.file',
  'media.image',
  'media.video',
  'media.audio',
  'media.document',
]);
const binarySchema = z
  .object({
    bytes: z.instanceof(Uint8Array),
    mimeType: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\s/]+\/[^\s;]+(?:;[^\r\n]*)?$/),
  })
  .strict();

export function prepareArtifactContent(value: unknown, type: DataType) {
  const binary = binarySchema.safeParse(value);
  if (!binary.success && type.kind === 'named' && mediaTypes.has(type.name))
    throw new Error('媒体输出必须提供 BinaryContent（bytes / mimeType），不能将临时 URL 当作内容');
  const contentKind = binary.success ? ('blob' as const) : ('json' as const);
  // 不调用业务 Schema；仅接受可持久化 JSON，拒绝隐式 toJSON、undefined 和二进制嵌套。
  const bytes = binary.success
    ? Uint8Array.from(binary.data.bytes)
    : new TextEncoder().encode(JSON.stringify(z.json().parse(value)));
  return {
    contentKind,
    bytes,
    mimeType: binary.success ? binary.data.mimeType : 'application/json',
    size: bytes.byteLength,
    checksum: createHash('sha256').update(bytes).digest('hex'),
  };
}
