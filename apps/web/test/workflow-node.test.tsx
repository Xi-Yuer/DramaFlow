import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { nodeTypeManifestSchema, type NodeTypeManifest } from '@dramaflow/contracts';
import {
  findNodeManifest,
  GenericWorkflowNode,
  WorkflowManifestProvider,
} from '../src/features/workflow/canvas/workflow-node';
import { WorkflowInputContext } from '../src/features/workflow/inputs/workflow-input-context';
import {
  toReactFlowNode,
  type WorkflowNode,
} from '../src/features/workflow/canvas/react-flow-adapter';
import { controlHandleId } from '../src/features/workflow/canvas/workflow-handles';

const manifest = nodeTypeManifestSchema.parse({
  type: 'video.image_to_video',
  version: 1,
  executionKind: 'action',
  metadata: { name: '图生视频', category: 'video' },
  inputs: [
    {
      key: 'image',
      name: '首帧图片',
      dataType: { kind: 'named', name: 'media.image' },
      required: true,
    },
    { key: 'prompt', name: '视频提示词', dataType: { kind: 'primitive', name: 'string' } },
  ],
  outputs: [{ key: 'video', name: '成片', dataType: { kind: 'named', name: 'media.video' } }],
  config: [
    {
      key: 'resolution',
      name: '分辨率',
      type: 'select',
      options: [{ label: '1080P', value: '1080p' }],
      defaultValue: '1080p',
    },
  ],
});

function props(): NodeProps<WorkflowNode> {
  const node = toReactFlowNode({
    id: 'video',
    type: 'video.image_to_video',
    typeVersion: 1,
    name: '生成第一镜',
    inputs: {},
    config: {},
    ui: { position: { x: 0, y: 0 } },
  });
  return {
    id: node.id,
    type: 'workflowNode',
    data: node.data,
    selected: false,
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    draggable: true,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
}

function render(manifests: readonly NodeTypeManifest[], node = props()) {
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <WorkflowManifestProvider manifests={manifests}>
        <GenericWorkflowNode {...node} />
      </WorkflowManifestProvider>
    </ReactFlowProvider>,
  );
}

describe('通用 WorkflowNode', () => {
  it('直接按照 JSON Manifest 自动渲染输入输出 Handle，ID 使用稳定 port key', () => {
    const html = render([manifest]);
    expect(html).toContain('生成第一镜');
    expect(html).toContain('图生视频');
    expect(html).toContain('data-handleid="image"');
    expect(html).toContain('data-handleid="prompt"');
    expect(html).toContain('data-handleid="video"');
    expect(html).toContain('aria-label="输入：首帧图片"');
    expect(html).toContain('aria-label="输出：成片"');
    expect(html).toContain('分辨率');
    expect(html).toContain('未配置');
    expect(html).not.toContain('1080p');
    expect(html).not.toContain('<button');
  });

  it('标题控制出入口与数据端口分区，分别使用独立 Handle ID 和可访问名称', () => {
    const html = render([manifest]);
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(header).toContain(`data-handleid="${controlHandleId('target')}"`);
    expect(header).toContain(`data-handleid="${controlHandleId('source')}"`);
    expect(header).toContain('aria-label="控制输入"');
    expect(header).toContain('aria-label="控制输出"');
    expect(header).not.toContain('data-handleid="image"');
    expect(html.match(/data-handleid=/g)).toHaveLength(5);
  });

  it('合法的数据端口名 control 不与控制 Handle 冲突', () => {
    const catalog = {
      ...manifest,
      inputs: [
        {
          key: 'control',
          name: '控制数据',
          dataType: { kind: 'primitive', name: 'string' },
        },
      ],
      outputs: [
        {
          key: 'control',
          name: '控制数据',
          dataType: { kind: 'primitive', name: 'string' },
        },
      ],
    } satisfies NodeTypeManifest;
    const html = render([catalog]);
    expect(html.match(/data-handleid="control"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="输入：控制数据"');
    expect(html).toContain('aria-label="输出：控制数据"');
    expect(html).toContain(`data-handleid="${controlHandleId('target')}"`);
    expect(html).toContain(`data-handleid="${controlHandleId('source')}"`);
  });

  it('缺少精确类型版本时明确显示不可用，不回退最新版本或开放端口', () => {
    const html = render([{ ...manifest, version: 2 }]);
    expect(html).toContain('节点类型不可用，请安装匹配版本');
    expect(html).not.toContain('data-handleid');
    expect(findNodeManifest([manifest], manifest.type, 2)).toBeUndefined();
    expect(findNodeManifest([], manifest.type, 1)).toBeUndefined();
  });

  it('同类型多版本精确查找；未列入 manifest 的配置不展示', () => {
    const node = props();
    node.data.config = { resolution: '1080p', unrelated: '不应显示的字段' };
    expect(findNodeManifest([{ ...manifest, version: 2 }, manifest], manifest.type, 1)).toBe(
      manifest,
    );
    const html = render([manifest], node);
    expect(html).toContain('1080p');
    expect(html).not.toContain('不应显示的字段');
  });

  it('只在文本节点提供变量编辑，其他节点不出现插入按钮', () => {
    const html = render([manifest], props());
    expect(html).not.toContain('插入变量');
    const text = nodeTypeManifestSchema.parse({
      ...manifest,
      type: 'ai.text_generate',
      metadata: { name: '文本生成', category: 'ai' },
      inputs: [
        {
          key: 'prompt',
          name: '提示词',
          dataType: { kind: 'primitive', name: 'string' },
          required: true,
        },
        { key: 'system', name: '系统提示词', dataType: { kind: 'primitive', name: 'string' } },
      ],
      outputs: [{ key: 'text', name: '生成文本', dataType: { kind: 'primitive', name: 'string' } }],
      config: [],
    });
    const node = toReactFlowNode({
      id: 'script',
      type: 'ai.text_generate',
      typeVersion: 1,
      name: '剧本',
      inputs: {
        prompt: {
          type: 'template',
          value: '请根据 {{text}} 生成剧本',
          variables: { text: { type: 'node_output', nodeId: 'outline', portKey: 'text' } },
        },
      },
      config: {},
      ui: { position: { x: 0, y: 0 } },
    });
    const markup = renderToStaticMarkup(
      <ReactFlowProvider>
        <WorkflowInputContext.Provider
          value={{
            disabled: false,
            definition: {
              inputs: [],
              nodes: [
                {
                  id: 'outline',
                  type: 'ai.text_generate',
                  typeVersion: 1,
                  name: '故事大纲',
                  inputs: {},
                  config: {},
                  ui: { position: { x: 0, y: 0 } },
                },
                {
                  id: 'script',
                  type: 'ai.text_generate',
                  typeVersion: 1,
                  name: '剧本',
                  inputs: node.data.inputs,
                  config: {},
                  ui: { position: { x: 0, y: 0 } },
                },
              ],
              edges: [],
              outputs: [],
            },
            manifests: [text],
            onReplaceInput: () => undefined,
          }}
        >
          <WorkflowManifestProvider manifests={[text]}>
            <GenericWorkflowNode {...props()} id="script" data={node.data} />
          </WorkflowManifestProvider>
        </WorkflowInputContext.Provider>
      </ReactFlowProvider>,
    );
    expect(markup).toContain('请根据');
    expect(markup).toContain('生成剧本');
    expect(markup).toContain('故事大纲 · 生成文本');
    expect(markup).toContain('data-alias="text"');
    expect(markup).not.toContain('{{text}}');
    expect(markup).toContain('aria-label="向提示词插入变量"');
    expect(markup).toContain('aria-label="向系统提示词插入变量"');
  });

  it('类型缺失时安全显示名称，不把名称当 HTML 或注入脚本', () => {
    const node = props();
    node.data.name = '<script>alert(1)</script>';
    const html = render([], node);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('节点类型不可用');
  });
});
