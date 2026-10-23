import { describe, it, expect } from 'vitest';
import { analyzeBranchRegions } from '../src/compiler/if/branch-regions.js';
describe('Branch Region 静态分析', () => {
  it('传播多层 membership，保留共同祖先、多个 terminal 与 ordinary 节点', () => {
    const analysis = analyzeBranchRegions(
      ['A', 'If', 'B', 'C', 'D', 'E', 'F', 'T', 'Outside'],
      [{ nodeId: 'If', true: 'B', false: 'C' }],
      [
        { targetNodeId: 'If', sourceNodeIds: ['A'] },
        { targetNodeId: 'B', sourceNodeIds: ['A'] },
        { targetNodeId: 'D', sourceNodeIds: ['B', 'A'] },
        { targetNodeId: 'F', sourceNodeIds: ['D'] },
        { targetNodeId: 'E', sourceNodeIds: ['C'] },
        { targetNodeId: 'T', sourceNodeIds: ['B'] },
      ],
    );
    expect([...analysis.regions[0]!.nodeIds]).toEqual(['B', 'D', 'T', 'F']);
    expect([...analysis.regions[1]!.nodeIds]).toEqual(['C', 'E']);
    expect([...analysis.regions[0]!.terminalNodeIds].sort()).toEqual(['F', 'T']);
    expect([...analysis.regions[0]!.guaranteedBefore]).toEqual(['A']);
    expect(analysis.ordinaryNodeIds).toEqual(['A', 'If', 'Outside']);
  });
  it('汇合节点及后继保留双分支证据，不能任选归属', () => {
    const a = analyzeBranchRegions(
      ['If', 'B', 'C', 'D', 'E'],
      [{ nodeId: 'If', true: 'B', false: 'C' }],
      [
        { targetNodeId: 'D', sourceNodeIds: ['B', 'C'] },
        { targetNodeId: 'E', sourceNodeIds: ['D'] },
      ],
    );
    expect(a.convergenceCandidates).toEqual([
      { nodeId: 'D', ifNodeId: 'If' },
      { nodeId: 'E', ifNodeId: 'If' },
    ]);
    expect(a.memberships.get('D')?.map((region) => region.branch)).toEqual(['true', 'false']);
  });
});
