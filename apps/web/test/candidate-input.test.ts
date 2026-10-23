import { describe, expect, it } from 'vitest';
import { workflowDraftDefinitionSchema } from '@dramaflow/contracts';
import {
  connectWorkflowNodes,
  toReactFlowEdges,
  toReactFlowNodes,
  fromReactFlowNode,
  fromReactFlowEdge,
  disconnectWorkflowEdge,
  reconnectWorkflowEdge,
} from '../src/features/workflow/canvas/react-flow-adapter';
import { removeWorkflowNodes } from '../src/features/workflow/outputs/workflow-outputs';
import { availableStringOutputs } from '../src/features/workflow/inputs/template-input';
import { candidateWorkflow, candidateConnection } from './fixtures/candidate-input';
import { ifCatalog, ifWorkflow } from './fixtures/workflow-if';

const candidateEdges = (workflow: ReturnType<typeof candidateWorkflow>) =>
  toReactFlowEdges(workflow).filter((edge) => edge.data?.projection === 'candidate-input');

describe('候选输入的 Canvas 适配', () => {
  it('hydrate 投影两条数据线，共用 target Handle，不修改 Contract 或生成真实 DataEdge', () => {
    const workflow = candidateWorkflow();
    const before = JSON.stringify(workflow);
    const edges = candidateEdges(workflow);
    expect(
      edges.map((edge) => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle]),
    ).toEqual([
      ['a', 'text', 'c', 'prompt'],
      ['b', 'text', 'c', 'prompt'],
    ]);
    expect(edges.every((edge) => edge.data?.kind === 'data' && !edge.reconnectable)).toBe(true);
    expect(toReactFlowNodes(workflow).map(fromReactFlowNode)).toEqual(workflow.nodes);
    expect(
      toReactFlowEdges(workflow)
        .filter((edge) => !edge.data?.projection)
        .map(fromReactFlowEdge),
    ).toEqual(workflow.edges);
    expect(() => fromReactFlowEdge(edges[0])).toThrow('不能导出');
    expect(JSON.stringify(workflow)).toBe(before);
    const reloaded = workflowDraftDefinitionSchema.parse(JSON.parse(before));
    expect(candidateEdges(reloaded)).toEqual(edges);
    expect(JSON.stringify(reloaded)).toBe(before);
  });
  it('第二条连接须明确选择，转换后只保存 binding 并移除原来的 DataEdge', () => {
    let workflow = ifWorkflow();
    workflow = connectWorkflowNodes(workflow, { ...candidateConnection, source: 'a' }, ifCatalog);
    const before = structuredClone(workflow);
    expect(() => connectWorkflowNodes(workflow, candidateConnection, ifCatalog)).toThrow(
      '确认替换',
    );
    const next = connectWorkflowNodes(workflow, candidateConnection, ifCatalog, {
      addCandidate: true,
    });
    expect(next.nodes[3]!.inputs.prompt).toEqual(candidateWorkflow().nodes[3]!.inputs.prompt);
    expect(next.edges).toEqual([]);
    expect(candidateEdges(next)).toHaveLength(2);
    expect(workflow).toEqual(before);
    const replaced = connectWorkflowNodes(workflow, candidateConnection, ifCatalog, {
      replaceBinding: true,
    });
    expect(replaced.edges).toHaveLength(1);
    expect(replaced.edges[0]!.source.nodeId).toBe('b');
    expect(replaced.nodes[3]!.inputs.prompt).toBeUndefined();
  });
  it('删去单条保留候选模式，删光移除输入；过期候选事件不删除普通连接', () => {
    const workflow = candidateWorkflow();
    const [first, second] = candidateEdges(workflow);
    const single = disconnectWorkflowEdge(workflow, first);
    expect(single.nodes[3]!.inputs.prompt).toEqual({
      type: 'candidate',
      sources: [{ type: 'node_output', nodeId: 'b', portKey: 'text' }],
    });
    expect(single.edges).toEqual(workflow.edges);
    expect(candidateEdges(single)).toHaveLength(1);
    const empty = disconnectWorkflowEdge(single, second);
    expect(empty.nodes[3]!.inputs.prompt).toBeUndefined();
    const regular = connectWorkflowNodes(empty, candidateConnection, ifCatalog);
    expect(disconnectWorkflowEdge(regular, second)).toEqual(regular);
  });
  it('删除 Source Node 同步清理候选，删除目标移除全部投影且保留不相关关系', () => {
    const workflow = candidateWorkflow();
    const single = removeWorkflowNodes(workflow, ['a']);
    expect(single.nodes.find((node) => node.id === 'c')!.inputs.prompt).toEqual({
      type: 'candidate',
      sources: [{ type: 'node_output', nodeId: 'b', portKey: 'text' }],
    });
    expect(candidateEdges(single)).toHaveLength(1);
    expect(
      removeWorkflowNodes(single, ['b']).nodes.find((node) => node.id === 'c')!.inputs.prompt,
    ).toBeUndefined();
    expect(candidateEdges(removeWorkflowNodes(workflow, ['c']))).toEqual([]);
    expect(workflow).toEqual(candidateWorkflow());
  });
  it('候选去重；第三个来源被阻止；删后可重新补齐；完整候选可明确替换', () => {
    const workflow = candidateWorkflow();
    workflow.nodes.push({ ...structuredClone(workflow.nodes[1]!), id: 'third' });
    expect(
      connectWorkflowNodes(workflow, candidateConnection, ifCatalog, { addCandidate: true }),
    ).toEqual(workflow);
    const connection = { ...candidateConnection, source: 'third' };
    expect(() =>
      connectWorkflowNodes(workflow, connection, ifCatalog, { addCandidate: true }),
    ).toThrow('最多支持两个来源');
    const single = disconnectWorkflowEdge(workflow, candidateEdges(workflow)[0]);
    expect(
      candidateEdges(connectWorkflowNodes(single, connection, ifCatalog, { addCandidate: true })),
    ).toHaveLength(2);
    const replaced = connectWorkflowNodes(workflow, connection, ifCatalog, {
      replaceBinding: true,
    });
    expect(candidateEdges(replaced)).toEqual([]);
    expect(replaced.edges.filter((edge) => edge.kind === 'data')).toHaveLength(1);
  });
  it.each([
    [{ source: 'c' }, '不能连接自身'],
    [{ source: 'missing' }, '来源节点不存在'],
    [{ sourceHandle: 'missing' }, '来源端口不存在'],
    [{ targetHandle: 'missing' }, '目标端口不存在'],
    [{ sourceHandle: 'video' }, '端口类型不兼容'],
  ])('添加候选仍校验端点、端口和类型 %s', (change, message) => {
    const workflow = candidateWorkflow();
    const single = disconnectWorkflowEdge(workflow, candidateEdges(workflow)[1]);
    expect(() =>
      connectWorkflowNodes(single, { ...candidateConnection, ...change }, ifCatalog, {
        addCandidate: true,
      }),
    ).toThrow(message);
    expect(workflow).toEqual(candidateWorkflow());
  });
  it('普通数据边重连到已有数据来源时也可明确加入候选，保留候选模式', () => {
    const workflow = ifWorkflow();
    const first = connectWorkflowNodes(
      workflow,
      { ...candidateConnection, source: 'a' },
      ifCatalog,
    );
    const second = connectWorkflowNodes(
      first,
      { ...candidateConnection, targetHandle: 'prompt', target: 'a' },
      ifCatalog,
    );
    const edge = toReactFlowEdges(second).find((edge) => edge.target === 'a')!;
    const next = reconnectWorkflowEdge(second, edge, candidateConnection, ifCatalog, {
      addCandidate: true,
    });
    expect(candidateEdges(next)).toHaveLength(2);
    expect(next.edges).toEqual([]);
  });
  it('Template 来源筛选沿候选依赖排除下游，不增加候选模板变量', () => {
    const workflow = candidateWorkflow();
    const outputs = availableStringOutputs(workflow, 'a', ifCatalog);
    expect(outputs.map((output) => output.nodeId)).toEqual(['b']);
    expect(availableStringOutputs(workflow, 'c', ifCatalog).map((output) => output.nodeId)).toEqual(
      ['a', 'b'],
    );
  });
});
