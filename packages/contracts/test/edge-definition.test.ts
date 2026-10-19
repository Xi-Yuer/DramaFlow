import { describe, expect, it } from 'vitest';
import {
  controlEdgeDefinitionSchema,
  workflowEdgeSchema,
  type ControlEdgeDefinition,
} from '../src/index.js';

describe('ControlEdge 协议', () => {
  const edge: ControlEdgeDefinition = {
    id: 'control-1',
    kind: 'control',
    source: { nodeId: 'a' },
    target: { nodeId: 'b' },
  };

  it('两端端口键分别可选，序列化后保留显式字段', () => {
    for (const value of [
      edge,
      { ...edge, source: { nodeId: 'a', portKey: 'next' } },
      { ...edge, target: { nodeId: 'b', portKey: 'enter' } },
      {
        ...edge,
        source: { nodeId: 'a', portKey: 'next' },
        target: { nodeId: 'b', portKey: 'enter' },
      },
    ]) {
      expect(controlEdgeDefinitionSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
      expect(workflowEdgeSchema.parse(value)).toEqual(value);
    }
    expect(controlEdgeDefinitionSchema.parse(edge).source).not.toHaveProperty('portKey');
    expect(controlEdgeDefinitionSchema.parse(edge).target).not.toHaveProperty('portKey');
  });

  it('端点与边只接受严格协议，端口键沿用共享命名规则', () => {
    for (const value of [
      { ...edge, id: '' },
      { ...edge, kind: 'data' },
      { ...edge, source: { nodeId: '' } },
      { ...edge, target: { nodeId: '' } },
      { ...edge, source: { nodeId: 'a', portKey: '' } },
      { ...edge, source: { nodeId: 'a', portKey: 'bad.key' } },
      { ...edge, target: { nodeId: 'b', portKey: 'constructor' } },
      { ...edge, target: { nodeId: 'b', portKey: null } },
      { ...edge, target: { nodeId: 'b', portKey: 'enter', inputKey: 'enter' } },
      { ...edge, selected: true },
      { ...edge, condition: 'state.route' },
      { id: 'legacy', sourceNodeId: 'a', targetNodeId: 'b' },
    ])
      expect(controlEdgeDefinitionSchema.safeParse(value).success).toBe(false);
  });
});
