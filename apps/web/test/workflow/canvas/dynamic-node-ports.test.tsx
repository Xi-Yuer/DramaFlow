import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import {
  AnyType,
  NumberType,
  StringType,
  nodeDefinitionSchema,
  nodeTypeManifestSchema,
  workflowDraftDefinitionSchema,
  type DataType,
  type NodeDefinition,
  type NodeTypeManifest,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  GenericWorkflowNode,
  WorkflowManifestProvider,
} from '../../../src/features/workflow/canvas/rendering/workflow-node';
import {
  applyWorkflowNodePositions,
  connectWorkflowNodes,
  fromReactFlowNode,
  toReactFlowNode,
  type WorkflowNode,
} from '../../../src/features/workflow/canvas/react-flow-adapter';
import {
  availableStringOutputs,
  describeNodeOutput,
} from '../../../src/features/workflow/inputs/template/sources';
import { WorkflowInputContext } from '../../../src/features/workflow/inputs/workflow-input-context';
import { WorkflowNodeInspector } from '../../../src/features/workflow/inspector/workflow-node-inspector';
import { resolveWorkflowNodePorts } from '../../../src/features/workflow/ports/resolve-workflow-node-ports';
import {
  projectWorkflowEnd,
  setWorkflowOutput,
} from '../../../src/features/workflow/outputs/workflow-outputs';
import { WorkflowRuntimeProvider } from '../../../src/features/workflow/runtime/runtime-status';

const array = (itemType: DataType): DataType => ({ kind: 'array', itemType });

const iterationManifest = nodeTypeManifestSchema.parse({
  type: 'flow.iteration',
  version: 1,
  executionKind: 'composite',
  portDerivation: 'iteration',
  metadata: { name: '逐项处理', category: 'flow' },
  inputs: [{ key: 'items', name: '集合', dataType: array(AnyType), required: true }],
  outputs: [],
  config: [],
});

const textManifest = nodeTypeManifestSchema.parse({
  type: 'ai.text_generate',
  version: 1,
  executionKind: 'action',
  metadata: { name: '文本生成', category: 'ai' },
  inputs: [
    { key: 'prompt', name: '提示词', dataType: StringType, required: true },
    { key: 'system', name: '系统提示词', dataType: StringType },
  ],
  outputs: [{ key: 'text', name: '生成文本', dataType: StringType }],
  config: [],
});

const formatManifest = nodeTypeManifestSchema.parse({
  type: 'test.format_text',
  version: 1,
  executionKind: 'action',
  metadata: { name: '文本格式化', category: 'data' },
  inputs: [
    { key: 'text', name: '文本', dataType: StringType, required: true },
    { key: 'index', name: '序号', dataType: NumberType, required: true },
  ],
  outputs: [{ key: 'text', name: '文本', dataType: StringType }],
  config: [],
});

const ifManifest = nodeTypeManifestSchema.parse({
  type: 'flow.if',
  version: 1,
  executionKind: 'control',
  metadata: { name: '条件分支', category: 'flow' },
  inputs: [{ key: 'value', name: '输入值', dataType: StringType, required: true }],
  outputs: [],
  controlOutputs: [
    { key: 'true', name: '条件成立' },
    { key: 'false', name: '条件不成立' },
  ],
  config: [],
});

const reviewManifest = nodeTypeManifestSchema.parse({
  type: 'flow.human_review',
  version: 1,
  executionKind: 'interaction',
  metadata: { name: '人工审批', category: 'flow' },
  inputs: [{ key: 'content', name: '待审核内容', dataType: StringType, required: true }],
  outputs: [
    { key: 'content', name: '审核内容', dataType: StringType },
    { key: 'action', name: '审批决策', dataType: StringType },
    { key: 'feedback', name: '修改意见', dataType: StringType },
  ],
  config: [],
});

const listManifest = nodeTypeManifestSchema.parse({
  type: 'test.list',
  version: 1,
  executionKind: 'action',
  metadata: { name: '收集', category: 'data' },
  inputs: [{ key: 'values', name: '文本列表', dataType: array(StringType), required: true }],
  outputs: [],
  config: [],
});

const stringManifest = nodeTypeManifestSchema.parse({
  type: 'test.string',
  version: 1,
  executionKind: 'action',
  metadata: { name: '单文本', category: 'data' },
  inputs: [{ key: 'prompt', name: '提示词', dataType: StringType, required: true }],
  outputs: [{ key: 'text', name: '文本', dataType: StringType }],
  config: [],
});

function iterationNode(output: { name: string; type: DataType }): NodeDefinition {
  return nodeDefinitionSchema.parse({
    id: 'iterate',
    type: 'flow.iteration',
    typeVersion: 1,
    name: '逐项',
    inputs: {},
    config: {},
    ui: { position: { x: 12, y: 24 } },
    composite: {
      kind: 'iteration',
      itemType: StringType,
      invariantInputs: [{ name: 'style', type: StringType, required: false }],
      bodyInputMapping: [],
      body: {
        inputs: [],
        nodes: [
          {
            id: 'format',
            type: 'test.format_text',
            typeVersion: 1,
            name: '格式化',
            inputs: {},
            config: {},
            ui: { position: { x: 0, y: 0 } },
          },
        ],
        edges: [],
        outputs: [{ ...output, source: { nodeId: 'format', outputKey: 'text' } }],
      },
    },
  });
}

function plainNode(id: string, manifest: NodeTypeManifest, name = id): NodeDefinition {
  return {
    id,
    type: manifest.type,
    typeVersion: manifest.version,
    name,
    inputs: {},
    config: {},
    ui: { position: { x: 0, y: 0 } },
  };
}

function workflow(nodes: NodeDefinition[]): WorkflowDefinition {
  return workflowDraftDefinitionSchema.parse({
    inputs: [],
    nodes,
    edges: [],
    outputs: [],
  });
}

function card(node: NodeDefinition, manifests: readonly NodeTypeManifest[]) {
  const flow = toReactFlowNode(node);
  const props: NodeProps<WorkflowNode> = {
    id: flow.id,
    type: 'workflowNode',
    data: flow.data,
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
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <WorkflowManifestProvider manifests={manifests}>
        <GenericWorkflowNode {...props} />
      </WorkflowManifestProvider>
    </ReactFlowProvider>,
  );
}

describe('动态节点端口', () => {
  it('普通静态 Action、条件与人工审核的端口与 Manifest 相同', () => {
    for (const manifest of [textManifest, formatManifest, ifManifest, reviewManifest]) {
      const ports = resolveWorkflowNodePorts(plainNode('node', manifest), manifest);
      expect(ports.inputs).toBe(manifest.inputs);
      expect(ports.outputs).toBe(manifest.outputs);
    }
  });

  it('body 的单个文本输出在父节点上成为数组，数组输出成为嵌套数组', () => {
    const text = resolveWorkflowNodePorts(
      iterationNode({ name: 'text', type: StringType }),
      iterationManifest,
    );
    expect(text.outputs).toEqual([{ key: 'text', name: 'text', dataType: array(StringType) }]);
    const chunks = resolveWorkflowNodePorts(
      iterationNode({ name: 'chunks', type: array(StringType) }),
      iterationManifest,
    );
    expect(chunks.outputs).toEqual([
      { key: 'chunks', name: 'chunks', dataType: array(array(StringType)) },
    ]);
  });

  it('节点卡片按实例端口渲染动态 Handle，嵌套数组不展平', () => {
    const text = card(iterationNode({ name: 'text', type: StringType }), [iterationManifest]);
    expect(text).toContain('data-handleid="text"');
    expect(text).toContain('aria-label="输出：text"');
    expect(text).toContain('(文本)[]');
    expect(text).toContain('data-handleid="style"');

    const nested = card(iterationNode({ name: 'chunks', type: array(StringType) }), [
      iterationManifest,
    ]);
    expect(nested).toContain('data-handleid="chunks"');
    expect(nested).toContain('((文本)[])[]');
    expect(nested).not.toContain('data-handleid="text"');
  });

  it('动态 string[] 可以连到 string[]，不能连到 string', () => {
    const source = iterationNode({ name: 'text', type: StringType });
    const manifests = [iterationManifest, listManifest, stringManifest];
    const connected = connectWorkflowNodes(
      workflow([source, plainNode('collect', listManifest)]),
      { source: 'iterate', sourceHandle: 'text', target: 'collect', targetHandle: 'values' },
      manifests,
    );
    expect(connected.edges).toEqual([
      expect.objectContaining({
        kind: 'data',
        source: { nodeId: 'iterate', portKey: 'text' },
        target: { nodeId: 'collect', portKey: 'values' },
      }),
    ]);
    expect(() =>
      connectWorkflowNodes(
        workflow([source, plainNode('caption', stringManifest)]),
        { source: 'iterate', sourceHandle: 'text', target: 'caption', targetHandle: 'prompt' },
        manifests,
      ),
    ).toThrow('端口类型不兼容');
  });

  it('候选来源校验使用动态输出，模板筛选仍按原类型排除数组', () => {
    const source = iterationNode({ name: 'text', type: StringType });
    const manifests = [iterationManifest, listManifest, stringManifest];
    const draft = workflow([
      source,
      plainNode('caption', stringManifest, '旁白'),
      plainNode('collect', listManifest),
    ]);
    const candidate = connectWorkflowNodes(
      draft,
      { source: 'iterate', sourceHandle: 'text', target: 'collect', targetHandle: 'values' },
      manifests,
      { addCandidate: true },
    );
    expect(candidate.nodes.find((node) => node.id === 'collect')?.inputs.values).toEqual({
      type: 'candidate',
      sources: [{ type: 'node_output', nodeId: 'iterate', portKey: 'text' }],
    });
    expect(describeNodeOutput(draft, manifests, { nodeId: 'iterate', portKey: 'text' })).toEqual({
      nodeName: '逐项',
      portName: 'text',
    });
    expect(availableStringOutputs(draft, 'collect', manifests)).toEqual([
      { nodeId: 'caption', nodeName: '旁白', portKey: 'text', portName: '文本' },
    ]);
  });

  it('工作流输出可以选择 Iteration 的动态数组端口', () => {
    const source = iterationNode({ name: 'text', type: StringType });
    const manifests = [iterationManifest];
    const next = setWorkflowOutput(
      workflow([source]),
      { name: 'result', source: { nodeId: 'iterate', outputKey: 'text' } },
      manifests,
    );
    expect(next.outputs).toEqual([
      {
        name: 'result',
        type: array(StringType),
        source: { nodeId: 'iterate', outputKey: 'text' },
      },
    ]);
    const end = projectWorkflowEnd(next);
    expect(end.edges).toEqual([
      expect.objectContaining({
        source: 'iterate',
        sourceHandle: 'text',
        targetHandle: 'workflow-output',
        label: 'result',
      }),
    ]);
  });

  it('React Flow 投影往返和位置更新都保留 composite', () => {
    const source = iterationNode({ name: 'text', type: StringType });
    const roundTrip = fromReactFlowNode(toReactFlowNode(source));
    expect(roundTrip.composite).toEqual(source.composite);
    const moved = applyWorkflowNodePositions(workflow([source]), [
      { id: 'iterate', type: 'position', position: { x: 8, y: 9 } },
    ]);
    expect(moved.nodes[0]?.composite).toEqual(source.composite);
    expect(moved.nodes[0]?.ui.position).toEqual({ x: 8, y: 9 });
  });

  it('Inspector 看到动态输入，运行输出名称来自实例端口', () => {
    const source = iterationNode({ name: 'text', type: StringType });
    const definition = workflow([source]);
    const design = renderToStaticMarkup(
      <WorkflowInputContext.Provider
        value={{
          disabled: false,
          definition,
          manifests: [iterationManifest],
          onReplaceInput: () => undefined,
        }}
      >
        <WorkflowNodeInspector
          node={source}
          manifest={iterationManifest}
          mode="design"
          onModeChange={() => undefined}
          onClose={() => undefined}
        />
      </WorkflowInputContext.Provider>,
    );
    expect(design).toContain('集合');
    expect(design).toContain('style');

    const runtime = renderToStaticMarkup(
      <WorkflowRuntimeProvider
        workflow={definition}
        nodeRuns={[
          {
            id: 'run-1',
            workflowRunId: 'workflow-run',
            nodeId: 'iterate',
            occurrenceId: 'occurrence-1',
            scopeKey: 'root',
            attempt: 1,
            status: 'completed',
            outputs: {
              text: { storage: 'inline', type: array(StringType), value: ['A-0'] },
            },
            startedAt: '2026-10-24T00:00:00.000Z',
            completedAt: '2026-10-24T00:00:01.000Z',
          },
        ]}
      >
        <WorkflowNodeInspector
          node={source}
          manifest={iterationManifest}
          mode="runtime"
          onModeChange={() => undefined}
          onClose={() => undefined}
        />
      </WorkflowRuntimeProvider>,
    );
    expect(runtime).toContain('aria-label="输出 text"');
    expect(runtime).toContain('A-0');
    expect(runtime).not.toContain('尚未产生节点输出');
  });
});
