import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import {
  GenericWorkflowNode,
  WorkflowManifestProvider,
} from '../../../src/features/workflow/canvas/rendering/workflow-node';
import {
  toReactFlowNode,
  type WorkflowNode,
} from '../../../src/features/workflow/canvas/react-flow-adapter';
import { WorkflowNodeInspector } from '../../../src/features/workflow/inspector/workflow-node-inspector';
import { WorkflowInputContext } from '../../../src/features/workflow/inputs/workflow-input-context';
import { TemplateInputEditor } from '../../../src/features/workflow/inputs/template/template-input-editor';
import { candidateWorkflow } from '../../fixtures/candidate-input';
import { manifest } from '../../fixtures/workflow-output';

function fixture(type = 'ai.text_generate') {
  const definition = candidateWorkflow();
  for (const node of definition.nodes.slice(1)) node.type = type;
  definition.nodes[1]!.name = '分支 B';
  definition.nodes[2]!.name = '分支 C';
  const catalog = {
    ...manifest,
    type,
    outputs: manifest.outputs.map((port) =>
      port.key === 'text' ? { ...port, name: '生成文本' } : port,
    ),
  };
  const targetNode = definition.nodes[3]!;
  const target = toReactFlowNode(targetNode);
  const props: NodeProps<WorkflowNode> = {
    id: target.id,
    type: 'workflowNode',
    data: target.data,
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
  return { definition, catalog, props, targetNode };
}

describe('候选输入 Inspector', () => {
  it.each(['ai.text_generate', 'text.test'])(
    '在 %s 的目标输入显示来源与分支取值说明，不显示空文本或 JSON',
    (type) => {
      const { definition, catalog, props, targetNode } = fixture(type);
      const canvasHtml = renderToStaticMarkup(
        <ReactFlowProvider>
          <WorkflowManifestProvider manifests={[catalog]}>
            <GenericWorkflowNode {...props} />
          </WorkflowManifestProvider>
        </ReactFlowProvider>,
      );
      expect(canvasHtml).toContain('data-handleid="prompt"');
      expect(canvasHtml).not.toContain('textarea');
      expect(canvasHtml).not.toContain('插入变量');

      const inspectorHtml = renderToStaticMarkup(
        <WorkflowInputContext.Provider
          value={{ definition, manifests: [catalog], disabled: false, onReplaceInput: () => {} }}
        >
          <WorkflowNodeInspector
            node={targetNode}
            manifest={catalog}
            mode="design"
            onModeChange={() => {}}
            onClose={() => {}}
          />
        </WorkflowInputContext.Provider>,
      );
      expect(inspectorHtml).toContain('提示词候选输入');
      expect(inspectorHtml).toContain('分支 B · 生成文本');
      expect(inspectorHtml).toContain('分支 C · 生成文本');
      expect(inspectorHtml).toContain('使用实际执行分支产生的那个值');
      expect(inspectorHtml).not.toContain('textarea');
      expect(inspectorHtml).not.toContain('插入变量');
      expect(inspectorHtml).not.toContain('node_output');
      expect(inspectorHtml).not.toContain('"sources"');
    },
  );
  it('文本输入组件也识别已有候选，单候选提示补齐，名称安全显示', () => {
    const { definition, catalog, props } = fixture();
    definition.nodes[1]!.name = '<img src=x onerror=alert(1)>';
    const binding = props.data.inputs.prompt!;
    if (binding.type !== 'candidate') throw new Error('fixture');
    binding.sources.pop();
    const html = renderToStaticMarkup(
      <TemplateInputEditor
        portName="提示词"
        binding={binding}
        connected={false}
        outputs={[]}
        definition={definition}
        manifests={[catalog]}
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('候选来源不足，请补齐两个来源后发布');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('textarea');
    expect(html).not.toContain('插入变量');
  });
});
