import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@dramaflow/contracts';
import { connectionError, createsCycle, toCanvas } from './graph-adapter';

const graph: WorkflowDefinition = {
  schemaVersion: 1,
  nodes: ['a', 'b', 'c', 'd'].map((id, index) => ({
    id,
    type: 'input',
    version: '1.0.0',
    title: id,
    position: { x: index * 200, y: 0 },
    config: {},
  })),
  controlEdges: [{ id: 'ab', source: 'a', target: 'b', sourcePort: 'out' }],
  bindings: [
    {
      nodeId: 'c',
      port: 'value',
      source: { kind: 'node', nodeId: 'b', port: 'value' },
      optional: false,
    },
  ],
};

describe('画布依赖边界', () => {
  it('执行边和数据绑定联合检测环', () => {
    expect(createsCycle(graph, 'c', 'a')).toBe(true);
    expect(createsCycle(graph, 'b', 'a')).toBe(true);
  });
  it('允许并行路径与汇合，拒绝自环', () => {
    expect(createsCycle(graph, 'a', 'c')).toBe(false);
    expect(createsCycle(graph, 'd', 'c')).toBe(false);
    expect(createsCycle(graph, 'a', 'a')).toBe(true);
  });
  it('保留条件端口及独立数据连线', () => {
    const { nodes, edges } = toCanvas(graph, [], 'b');
    expect(nodes.find((node) => node.id === 'b')?.selected).toBe(true);
    expect(edges.find((edge) => edge.id === 'control:ab')?.sourceHandle).toBe('control:out');
    expect(edges.find((edge) => edge.id === 'binding:c:value')?.targetHandle).toBe('data:value');
  });
  it('拒绝混合连接执行端口与数据端口', () => {
    expect(
      connectionError(
        { source: 'a', target: 'd', sourceHandle: 'control:out', targetHandle: 'data:value' },
        graph,
        [],
      ),
    ).toContain('执行端口');
  });
});
