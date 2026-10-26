import { describe, expect, it } from 'vitest';
import {
  connectWorkflowNodes,
  disconnectWorkflowEdge,
  reconnectWorkflowEdge,
  toReactFlowEdges,
} from '../src/features/workflow/canvas/react-flow-adapter';
import { controlHandleId } from '../src/features/workflow/canvas/adapter/workflow-handles';
import { ifCatalog, ifWorkflow } from './fixtures/workflow-if';

const route = (port: string | undefined, target = 'b') => ({
  source: 'if',
  sourceHandle: controlHandleId('source', port),
  target,
  targetHandle: controlHandleId('target'),
});
describe('If named control 与 DataEdge', () => {
  it('string DataEdge → value，规则不写来源；两个控制出口保存真实 portKey', () => {
    let workflow = connectWorkflowNodes(
      ifWorkflow(),
      { source: 'a', sourceHandle: 'text', target: 'if', targetHandle: 'value' },
      ifCatalog,
    );
    workflow = connectWorkflowNodes(workflow, route('true'), ifCatalog);
    workflow = connectWorkflowNodes(workflow, route('false', 'c'), ifCatalog);
    expect(workflow.edges.map((e) => e.source)).toEqual([
      { nodeId: 'a', portKey: 'text' },
      { nodeId: 'if', portKey: 'true' },
      { nodeId: 'if', portKey: 'false' },
    ]);
    expect(workflow.nodes[0]!.config).toEqual({});
    expect(workflow.nodes[0]!.inputs).toEqual({});
    expect(toReactFlowEdges(workflow)[1]!.sourceHandle).toBe('control:source:true');
  });
  it.each([undefined, 'maybe'])('不接受 If 的控制出口 %s', (port) =>
    expect(() => connectWorkflowNodes(ifWorkflow(), route(port), ifCatalog)).toThrow(),
  );
  it('非 string DataEdge 不进入 value；命名 target 不被当作合法控制入口', () => {
    expect(() =>
      connectWorkflowNodes(
        ifWorkflow(),
        { source: 'a', sourceHandle: 'video', target: 'if', targetHandle: 'value' },
        ifCatalog,
      ),
    ).toThrow('类型不兼容');
    expect(() =>
      connectWorkflowNodes(
        ifWorkflow(),
        { ...route('true'), targetHandle: controlHandleId('target', 'true') },
        ifCatalog,
      ),
    ).toThrow('命名控制端口尚未声明');
  });
  it('不接受同目标或一个出口重复连线；失败保持原定义；删除后可重新连接', () => {
    const workflow = connectWorkflowNodes(ifWorkflow(), route('true'), ifCatalog);
    const snapshot = structuredClone(workflow);
    expect(() => connectWorkflowNodes(workflow, route('false'), ifCatalog)).toThrow('同一');
    expect(() => connectWorkflowNodes(workflow, route('true', 'c'), ifCatalog)).toThrow('已连接');
    expect(workflow).toEqual(snapshot);
    const edge = toReactFlowEdges(workflow)[0]!;
    const moved = reconnectWorkflowEdge(workflow, edge, route('false', 'c'), ifCatalog);
    expect(moved.edges[0]).toMatchObject({
      id: edge.id,
      source: { nodeId: 'if', portKey: 'false' },
      target: { nodeId: 'c' },
    });
    expect(disconnectWorkflowEdge(moved, edge)).toEqual(moved);
    expect(
      connectWorkflowNodes(disconnectWorkflowEdge(workflow, edge), route('false'), ifCatalog).edges,
    ).toHaveLength(1);
  });
});
