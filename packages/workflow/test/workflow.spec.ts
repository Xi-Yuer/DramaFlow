import { RunnableLambda } from '@langchain/core/runnables';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  emptyWorkflow,
  validateWorkflow,
  type NodeDefinition,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@dramaflow/contracts';
import {
  NodeRegistry,
  compileWorkflow,
  createFoundationRegistry,
  executorFromRunnable,
} from '@dramaflow/workflow';

const config = { notes: '' };
function node(id: string, type = 'text.echo', position = { x: 0, y: 0 }): WorkflowNode {
  return { id, type, version: 1, title: id, position, config: {} };
}
function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return { schemaVersion: 1, nodes: [], edges: [], bindings: [], ...overrides };
}
function echoDefinition(executable = true): NodeDefinition {
  return {
    type: 'text.echo',
    version: 1,
    title: '回声',
    description: '测试执行器',
    inputs: [{ id: 'text', label: '文本', kind: 'text', required: false }],
    outputs: [{ id: 'text', label: '文本', kind: 'text', required: true }],
    configSchema: {},
    defaultConfig: {},
    executable,
  };
}

describe('工作流草稿校验', () => {
  const catalog = [echoDefinition()];
  it('拒绝循环、重复连线和类型不匹配的数据绑定', () => {
    const cyclic = definition({
      nodes: [node('a'), node('b')],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ],
    });
    expect(validateWorkflow(cyclic, catalog).some((issue) => issue.code === 'cycle')).toBe(true);
    const duplicated = definition({
      nodes: [node('a'), node('b')],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'a', target: 'b' },
      ],
    });
    expect(
      validateWorkflow(duplicated, catalog).some((issue) => issue.code === 'duplicate_edge'),
    ).toBe(true);
    const mismatched = definition({
      nodes: [node('a'), node('b')],
      bindings: [
        {
          source: { nodeId: 'a', port: 'text' },
          target: { nodeId: 'b', port: 'text' },
        },
      ],
    });
    const numberCatalog: NodeDefinition[] = [
      {
        ...echoDefinition(),
        type: 'text.echo',
        inputs: [{ id: 'text', label: '数字', kind: 'number', required: false }],
      },
    ];
    expect(
      validateWorkflow(mismatched, numberCatalog).some((issue) => issue.code === 'port_type'),
    ).toBe(true);
  });
  it('基础流程节点可以保存为空画布，但不能编译执行', () => {
    const registry = createFoundationRegistry();
    expect(registry.catalog()).toHaveLength(1);
    expect(registry.catalog()[0]?.executable).toBe(false);
    expect(registry.validate(emptyWorkflow())).toEqual([]);
    expect(() => compileWorkflow(emptyWorkflow(), registry)).toThrow(/空画布/);
    expect(() =>
      compileWorkflow(
        definition({
          nodes: [
            {
              id: 'step',
              type: 'core.step',
              version: 1,
              title: '开场',
              position: { x: 0, y: 0 },
              config,
            },
          ],
        }),
        registry,
      ),
    ).toThrow(/执行能力/);
  });
});

describe('LangGraph 编译', () => {
  it('按执行边和数据绑定传递结果，并拒绝非 JSON 输出', async () => {
    const registry = new NodeRegistry();
    registry.register({
      definition: echoDefinition(),
      config: z.object({}).strict(),
      executor: async ({ inputs }) => ({ text: `echo:${String(inputs.text ?? '')}` }),
    });
    const graph = compileWorkflow(
      definition({
        nodes: [node('a', 'text.echo', { x: 10, y: 20 }), node('b', 'text.echo', { x: 80, y: 20 })],
        edges: [{ id: 'e1', source: 'a', target: 'b' }],
        bindings: [
          { source: { nodeId: 'a', port: 'text' }, target: { nodeId: 'b', port: 'text' } },
        ],
      }),
      registry,
    );
    const result = await graph.invoke({ results: {} });
    expect(result.results.a).toEqual({ text: 'echo:' });
    expect(result.results.b).toEqual({ text: 'echo:echo:' });
    const wrapped = executorFromRunnable(RunnableLambda.from(async () => ({ text: 'ok' })));
    await expect(wrapped({ node: node('a'), inputs: {} }, {})).resolves.toEqual({ text: 'ok' });
    const invalid = executorFromRunnable(
      RunnableLambda.from(async () => 'nope' as unknown as Record<string, never>),
    );
    await expect(invalid({ node: node('a'), inputs: {} }, {})).rejects.toThrow();
  });
});
