import {
  ImageType,
  JsonType,
  NumberType,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { NodeRegistry } from '@dramaflow/workflow';
import { z } from 'zod';

export const largeText = 'artifact-content-only-in-rustfs:'.repeat(12000);
export const imageBytes = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3,
]);

// 只在测试 Registry 注册，不加入生产目录；下游输入是业务对象与可访问媒体资源。
export function registerArtifactNodes(registry: NodeRegistry) {
  registry.register({
    manifest: {
      type: 'test.artifact_produce',
      version: 1,
      executionKind: 'action',
      metadata: { name: '产物测试', category: 'data' },
      inputs: [],
      config: [],
      outputs: [
        {
          key: 'payload',
          name: '大 JSON',
          dataType: JsonType,
          storagePolicy: 'reference',
        },
        { key: 'image', name: '图片', dataType: ImageType },
      ],
    },
    inputSchema: z.object({}).strict(),
    configSchema: z.object({}).strict(),
    outputSchema: z.object({
      payload: z.object({ text: z.string() }),
      image: z.object({
        bytes: z.instanceof(Uint8Array),
        mimeType: z.string(),
      }),
    }),
    async execute() {
      return {
        payload: { text: largeText },
        image: { bytes: imageBytes, mimeType: 'image/png' },
      };
    },
  });
  registry.register({
    manifest: {
      type: 'test.artifact_consume',
      version: 1,
      executionKind: 'action',
      metadata: { name: '解析测试', category: 'data' },
      config: [],
      inputs: [
        { key: 'payload', name: '内容', dataType: JsonType },
        { key: 'image', name: '图片', dataType: ImageType },
      ],
      outputs: [{ key: 'length', name: '长度', dataType: NumberType }],
    },
    inputSchema: z.object({
      payload: z.object({ text: z.string() }),
      image: z.object({
        id: z.string(),
        mediaType: z.literal('image'),
        mimeType: z.literal('image/png'),
        access: z.object({ url: z.url() }),
      }),
    }),
    configSchema: z.object({}).strict(),
    outputSchema: z.object({ length: z.number() }),
    async execute(input: unknown) {
      const data = z
        .object({
          payload: z.object({ text: z.string() }),
          image: z.object({ access: z.object({ url: z.url() }) }),
        })
        .parse(input);
      if (data.payload.text !== largeText)
        throw new Error('大 JSON 内容不一致');
      const response = await fetch(data.image.access.url);
      if (
        !response.ok ||
        !Buffer.from(await response.arrayBuffer()).equals(
          Buffer.from(imageBytes),
        )
      )
        throw new Error('临时访问 URL 无法读取实际二进制');
      return { length: data.payload.text.length };
    },
  });
}

export function artifactDefinition(): WorkflowDefinition {
  return {
    inputs: [],
    nodes: [
      {
        id: 'A',
        type: 'test.artifact_produce',
        typeVersion: 1,
        name: '产物',
        inputs: {},
        config: {},
        ui: { position: { x: 0, y: 0 } },
      },
      {
        id: 'B',
        type: 'test.artifact_consume',
        typeVersion: 1,
        name: '下游',
        inputs: {},
        config: {},
        ui: { position: { x: 0, y: 0 } },
      },
    ],
    edges: [
      {
        id: 'json',
        kind: 'data',
        source: { nodeId: 'A', portKey: 'payload' },
        target: { nodeId: 'B', portKey: 'payload' },
      },
      {
        id: 'image',
        kind: 'data',
        source: { nodeId: 'A', portKey: 'image' },
        target: { nodeId: 'B', portKey: 'image' },
      },
    ],
    outputs: [
      {
        name: 'length',
        type: NumberType,
        source: { nodeId: 'B', outputKey: 'length' },
      },
    ],
  };
}
