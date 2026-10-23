import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import {
  GenericWorkflowNode,
  WorkflowManifestProvider,
} from '../src/features/workflow/canvas/workflow-node';
import {
  toReactFlowNode,
  type WorkflowNode,
} from '../src/features/workflow/canvas/react-flow-adapter';
import { WorkflowInputContext } from '../src/features/workflow/inputs/workflow-input-context';
import { TemplateInputEditor } from '../src/features/workflow/inputs/template-input-editor';
import { candidateWorkflow } from './fixtures/candidate-input';
import { manifest } from './fixtures/workflow-output';

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
  const target = toReactFlowNode(definition.nodes[3]);
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
  return { definition, catalog, props };
}

describe('候选输入 Inspector', () => {
  it.each(['ai.text_generate', 'text.test'])(
    '在 %s 的目标输入显示来源与分支取值说明，不显示空文本或 JSON',
    (type) => {
      const { definition, catalog, props } = fixture(type);
      const html = renderToStaticMarkup(
        <ReactFlowProvider>
          <WorkflowInputContext.Provider
            value={{ definition, manifests: [catalog], disabled: false, onReplaceInput: () => {} }}
          >
            <WorkflowManifestProvider manifests={[catalog]}>
              <GenericWorkflowNode {...props} />
            </WorkflowManifestProvider>
          </WorkflowInputContext.Provider>
        </ReactFlowProvider>,
      );
      expect(html).toContain('提示词候选输入');
      expect(html).toContain('分支 B · 生成文本');
      expect(html).toContain('分支 C · 生成文本');
      expect(html).toContain('使用实际执行分支产生的那个值');
      expect(html).toContain('data-handleid="prompt"');
      expect(html).not.toContain('textarea');
      expect(html).not.toContain('插入变量');
      expect(html).not.toContain('node_output');
      expect(html).not.toContain('"sources"');
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
