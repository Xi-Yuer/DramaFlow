import { describe, expect, it } from 'vitest';
import { ImageType, JsonType, StringType } from '@dramaflow/contracts';
import { prepareArtifactContent } from '../src/artifacts/artifact-content.js';

describe('Artifact 内容边界', () => {
  it('结构化 JSON / 大文本无损持久化，不使用业务类型或大小猜测编码', () => {
    for (const value of [null, [1, '文本'], { script: '长文'.repeat(20000) }, 'long text']) {
      const content = prepareArtifactContent(
        value,
        typeof value === 'string' ? StringType : JsonType,
      );
      expect(content).toMatchObject({ contentKind: 'json', mimeType: 'application/json' });
      expect(JSON.parse(new TextDecoder().decode(content.bytes))).toEqual(value);
    }
  });
  it('媒体显式提供 BinaryContent，复制字节避免上传前被原输出改写', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const content = prepareArtifactContent({ bytes, mimeType: 'image/png' }, ImageType);
    bytes[0] = 9;
    expect(content).toMatchObject({ contentKind: 'blob', size: 3, mimeType: 'image/png' });
    expect([...content.bytes]).toEqual([1, 2, 3]);
  });
  it('拒绝媒体 URL 描述、非法 MIME 和非 JSON 对象，不隐式下载或调用 toJSON', () => {
    for (const value of [
      { access: { url: 'https://example.invalid/image' } },
      { bytes: new Uint8Array([1]), mimeType: 'image/png\r\ninjected: true' },
    ])
      expect(() => prepareArtifactContent(value, ImageType)).toThrow();
    for (const value of [
      undefined,
      new Date(),
      new Uint8Array([1]),
      { nested: new Uint8Array([1]) },
      {
        toJSON() {
          throw new Error('不应调用');
        },
      },
    ])
      expect(() => prepareArtifactContent(value, JsonType)).toThrow();
  });
});
