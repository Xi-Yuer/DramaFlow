import { describe, expect, it, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import {
  StringType,
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  createMergeNodeType,
  createIfNodeType,
  createTextGenerationNodeType,
  NodeRegistry,
  validateWorkflowDefinitionSemantics,
  validateWorkflowForPublish,
  DefaultWorkflowCompiler,
} from '../src/index.js';
import { analyzeIfTopology, analyzeSimpleIfExecution } from '../src/compiler/if/analysis.js';

function graph(): WorkflowDefinition {
  return {
    inputs: [],
    outputs: [],
    nodes: [
      {
        id: 'If',
        type: 'flow.if',
        typeVersion: 1,
        name: '条件',
        inputs: { value: { type: 'constant', value: 'hello' } },
        config: { condition: { in: ['hello', { var: 'value' }] } },
        ui: { position: { x: 0, y: 0 } },
      },
      ...['B', 'C', 'D', 'E', 'F', 'X'].map((id) => ({
        id,
        type: 'ai.text_generate',
        typeVersion: 1,
        name: id,
        inputs: { prompt: { type: 'constant' as const, value: id } },
        config: { modelConfigurationId: '00000000-0000-4000-8000-000000000001' },
        ui: { position: { x: 0, y: 0 } },
      })),
      {
        id: 'Merge',
        type: 'flow.merge',
        typeVersion: 1,
        name: '汇聚',
        inputs: {},
        config: { openerNodeId: 'If' },
        ui: { position: { x: 0, y: 0 } },
      },
    ],
    edges: [
      {
        id: 'true',
        kind: 'control',
        source: { nodeId: 'If', portKey: 'true' },
        target: { nodeId: 'B' },
      },
      {
        id: 'false',
        kind: 'control',
        source: { nodeId: 'If', portKey: 'false' },
        target: { nodeId: 'C' },
      },
      edge('B', 'Merge'),
      edge('C', 'Merge'),
      edge('Merge', 'D'),
      edge('D', 'E'),
      edge('X', 'E'),
    ],
  };
}
function edge(source: string, target: string): WorkflowDefinition['edges'][number] {
  return {
    id: `${source}-${target}`,
    kind: 'control',
    source: { nodeId: source },
    target: { nodeId: target },
  };
}
function registry() {
  return new NodeRegistry([
    createIfNodeType(),
    createMergeNodeType(),
    createTextGenerationNodeType(),
  ]);
}
function analyze(d = graph()) {
  const parsed = workflowDefinitionSchema.parse(d);
  validateWorkflowDefinitionSemantics(parsed, registry());
  return analyzeIfTopology(
    parsed,
    new Set(
      parsed.nodes.filter((n) => n.type === 'flow.if' && n.typeVersion === 1).map((n) => n.id),
    ),
  );
}
function rejects(mutate: (d: WorkflowDefinition) => void, code: string) {
  const d = graph();
  mutate(d);
  expect(() => analyze(d)).toThrow(expect.objectContaining({ code }));
}

describe('Merge 声明及静态 boundary（尚不可生产执行）', () => {
  it('精确 control 声明只包含 opener 引用，无 execute / 业务端口', () => {
    const entry = registry().get('flow.merge', 1);
    expect(entry.manifest).toMatchObject({
      executionKind: 'control',
      inputs: [],
      outputs: [],
      config: [{ key: 'openerNodeId', type: 'string', required: true }],
    });
    expect(entry.execute).toBeUndefined();
    expect(() => registry().getAction('flow.merge', 1)).toThrow();
    for (const config of [
      {},
      { openerNodeId: '' },
      { openerNodeId: ' If' },
      { openerNodeId: 'If', extra: true },
    ])
      expect(entry.configSchema.safeParse(config).success).toBe(false);
  });
  it('simple：Merge 不属于任一分支，后继串行 / 普通 ALL join 恢复 ordinary', () => {
    const d = graph();
    d.outputs = [{ name: 'result', type: StringType, source: { nodeId: 'E', outputKey: 'text' } }];
    const a = analyze(d);
    expect(a.mergeBoundaries).toEqual([
      { nodeId: 'Merge', openerNodeId: 'If', branchTerminals: { true: ['B'], false: ['C'] } },
    ]);
    expect(a.branchRegions.regions.map((r) => [...r.nodeIds])).toEqual([['B'], ['C']]);
    expect(a.branchRegions.ordinaryNodeIds).toEqual(
      expect.arrayContaining(['Merge', 'D', 'E', 'X']),
    );
    expect(a.branchRegions.convergenceCandidates).toEqual([]);
  });
  it('uneven：不等深分支在同一 boundary 停止', () => {
    const d = graph();
    d.edges = d.edges.filter((e) => e.source.nodeId !== 'B' || e.target.nodeId !== 'Merge');
    d.edges.push(edge('B', 'F'), edge('F', 'Merge'));
    expect(analyze(d).mergeBoundaries[0]?.branchTerminals).toEqual({ true: ['F'], false: ['C'] });
  });
  it.each([false, true])('parallel：全部 terminal / 分支内部 ALL join，joined=%s', (joined) => {
    const d = graph();
    d.edges = d.edges.filter((e) => e.target.nodeId === 'B' || e.target.nodeId === 'C');
    d.edges.push(edge('B', 'D'), edge('B', 'E'), edge('C', 'Merge'));
    if (joined) d.edges.push(edge('D', 'F'), edge('E', 'F'), edge('F', 'Merge'));
    else d.edges.push(edge('D', 'Merge'), edge('E', 'Merge'));
    expect(analyze(d).mergeBoundaries[0]?.branchTerminals.true).toEqual(
      joined ? ['F'] : ['D', 'E'],
    );
  });
  it('允许 pre-If 共同祖先数据与同分支 template 依赖；分析不修改 Definition', () => {
    const d = graph();
    d.nodes.find((n) => n.id === 'If')!.inputs.value = {
      type: 'template',
      value: '{{x}}',
      variables: { x: { type: 'node_output', nodeId: 'X', portKey: 'text' } },
    };
    d.nodes.find((n) => n.id === 'B')!.inputs.prompt = {
      type: 'template',
      value: '{{x}}',
      variables: { x: { type: 'node_output', nodeId: 'X', portKey: 'text' } },
    };
    const before = structuredClone(d);
    expect(analyze(d).mergeBoundaries).toHaveLength(1);
    expect(d).toEqual(before);
  });
  it.each(['data', 'template'])('同分支 %s successor 与去重沿用统一依赖', (kind) => {
    const d = graph();
    d.edges = d.edges.filter((e) => !(e.source.nodeId === 'B' && e.target.nodeId === 'Merge'));
    d.edges.push(edge('B', 'F'), edge('F', 'Merge'));
    const f = d.nodes.find((n) => n.id === 'F')!;
    if (kind === 'data') {
      f.inputs = {};
      d.edges.push({
        id: 'bf-data',
        kind: 'data',
        source: { nodeId: 'B', portKey: 'text' },
        target: { nodeId: 'F', portKey: 'prompt' },
      });
    } else
      f.inputs.prompt = {
        type: 'template',
        value: '{{b}}',
        variables: { b: { type: 'node_output', nodeId: 'B', portKey: 'text' } },
      };
    expect(analyze(d).mergeBoundaries[0]?.branchTerminals.true).toEqual(['F']);
  });
  it('不同 If 的 branch 不能被 Merge 配对混合', () =>
    rejects((d) => {
      d.edges = d.edges.filter((e) => !['Merge', 'D', 'X'].includes(e.source.nodeId));
      d.nodes.push({ ...d.nodes[0]!, id: 'If2' });
      d.edges.push(
        {
          id: 'if2-true',
          kind: 'control',
          source: { nodeId: 'If2', portKey: 'true' },
          target: { nodeId: 'F' },
        },
        {
          id: 'if2-false',
          kind: 'control',
          source: { nodeId: 'If2', portKey: 'false' },
          target: { nodeId: 'X' },
        },
        edge('F', 'Merge'),
      );
    }, 'MERGE_BRANCH_COVERAGE_INVALID'));
  it('conditional sources 在 Merge 前继续有效；单 branch source 仍拒绝', () => {
    const d = graph();
    d.outputs = [
      {
        name: 'result',
        type: StringType,
        sources: ['B', 'C'].map((nodeId) => ({ nodeId, outputKey: 'text' })),
      },
    ];
    expect(analyze(d).mergeBoundaries).toHaveLength(1);
    d.outputs = [{ name: 'result', type: StringType, source: { nodeId: 'B', outputKey: 'text' } }];
    expect(() => analyze(d)).toThrow(
      expect.objectContaining({ code: 'CONDITIONAL_WORKFLOW_OUTPUT_UNSUPPORTED' }),
    );
  });
  it('普通 Action 隐式 convergence 仍拒绝', () =>
    rejects((d) => {
      d.edges.push(edge('B', 'F'), edge('C', 'F'));
    }, 'IF_CONVERGENCE_UNSUPPORTED'));
  it.each(['missing', 'B', 'Merge'])('错误 opener %s 拒绝', (openerNodeId) =>
    rejects((d) => {
      d.nodes.find((n) => n.id === 'Merge')!.config = { openerNodeId };
    }, 'MERGE_OPENER_INVALID'),
  );
  it('同一 opener 不允许多个 Merge', () =>
    rejects((d) => {
      d.nodes.push({ ...d.nodes.find((n) => n.id === 'Merge')!, id: 'Merge2' });
    }, 'MERGE_OPENER_INVALID'));
  it('缺少 false 路径到 Merge 拒绝', () =>
    rejects((d) => {
      d.edges = d.edges.filter((e) => e.source.nodeId !== 'C');
    }, 'MERGE_BRANCH_COVERAGE_INVALID'));
  it('分支存在未接入 Merge 的并行 terminal 拒绝', () =>
    rejects((d) => {
      d.edges.push(edge('B', 'F'));
    }, 'MERGE_BRANCH_COVERAGE_INVALID'));
  it('Merge 不接收无条件额外上游', () =>
    rejects((d) => {
      d.edges.push(edge('X', 'Merge'));
    }, 'MERGE_BRANCH_COVERAGE_INVALID'));
  it.each(['control', 'data', 'template'])('Merge 后 %s 绕行拒绝', (kind) =>
    rejects((d) => {
      if (kind === 'control') d.edges.push(edge('B', 'D'));
      if (kind === 'data') {
        d.nodes.find((n) => n.id === 'D')!.inputs = {};
        d.edges.push({
          id: 'bypass',
          kind: 'data',
          source: { nodeId: 'B', portKey: 'text' },
          target: { nodeId: 'D', portKey: 'prompt' },
        });
      }
      if (kind === 'template')
        d.nodes.find((n) => n.id === 'D')!.inputs.prompt = {
          type: 'template',
          value: '{{b}}',
          variables: { b: { type: 'node_output', nodeId: 'B', portKey: 'text' } },
        };
    }, 'MERGE_BYPASS_UNSUPPORTED'),
  );
  it.each(['data', 'template'])('跨分支 %s 依赖仍拒绝', (kind) =>
    rejects((d) => {
      d.nodes.find((n) => n.id === 'B')!.inputs =
        kind === 'template'
          ? {
              prompt: {
                type: 'template',
                value: '{{c}}',
                variables: { c: { type: 'node_output', nodeId: 'C', portKey: 'text' } },
              },
            }
          : {};
      if (kind === 'data')
        d.edges.push({
          id: 'cross',
          kind: 'data',
          source: { nodeId: 'C', portKey: 'text' },
          target: { nodeId: 'B', portKey: 'prompt' },
        });
    }, 'IF_CONVERGENCE_UNSUPPORTED'),
  );
  it('Publish 与 execution analysis 即使静态合法也明确拒绝；无执行服务副作用', async () => {
    const d = graph();
    expect(analyze(d).mergeBoundaries).toHaveLength(1);
    expect(() => validateWorkflowForPublish(d, registry())).toThrow(
      expect.objectContaining({ code: 'MERGE_EXECUTION_UNSUPPORTED', nodeId: 'Merge' }),
    );
    expect(() => analyzeSimpleIfExecution(d, new Set(['If']))).toThrow(
      expect.objectContaining({ code: 'MERGE_EXECUTION_UNSUPPORTED' }),
    );
    const factory = vi.fn();
    const ifFactory = vi.fn();
    const compiler = new DefaultWorkflowCompiler(registry(), factory, new MemorySaver(), ifFactory);
    await expect(
      compiler.compile(d, {
        id: 'test',
        projectId: 'project',
        workflowId: 'workflow',
        workflowVersionId: 'version',
        invocationKey: 'invocation',
        threadId: 'thread',
        status: 'pending',
        inputs: {},
        createdAt: '2026-10-23T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'MERGE_EXECUTION_UNSUPPORTED' });
    expect(factory).not.toHaveBeenCalled();
    expect(ifFactory).not.toHaveBeenCalled();
  });
});
