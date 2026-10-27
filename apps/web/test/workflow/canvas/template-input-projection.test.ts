import { describe, expect, it } from 'vitest';
import { workflowDraftDefinitionSchema, type WorkflowDefinition } from '@dramaflow/contracts';
import {
  toReactFlowEdges,
  fromReactFlowEdge,
  disconnectWorkflowEdge,
} from '../../../src/features/workflow/canvas/react-flow-adapter';
import { removeWorkflowNodes } from '../../../src/features/workflow/outputs/workflow-outputs';
import {
  draftBinding,
  removeVariable,
  nodeOutputVariables,
  replaceNodeInput,
} from '../../../src/features/workflow/inputs/template/binding';
import { templateWorkflow } from '../../fixtures/template-input';

function prompt(workflow: WorkflowDefinition) {
  const binding = workflow.nodes.find((node) => node.id === 'c')!.inputs.prompt!;
  if (binding.type !== 'template') throw new Error('fixture');
  return binding;
}
function removeAlias(workflow: WorkflowDefinition, name: string) {
  const binding = prompt(workflow);
  const variables = nodeOutputVariables(binding);
  delete variables[name];
  const result = draftBinding(removeVariable(binding.value, name), variables);
  if (result.status === 'invalid') throw new Error('fixture');
  return replaceNodeInput(
    workflow,
    'c',
    'prompt',
    result.status === 'clear' ? null : result.binding,
  );
}

describe('Template node_output dependency 投影', () => {
  it('已有 Template hydrate 为数据线，同一输入接收多个来源且 Definition 不变', () => {
    const workflow = templateWorkflow();
    const snapshot = structuredClone(workflow);
    const edges = toReactFlowEdges(workflow);
    expect(
      edges.map((edge) => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle]),
    ).toEqual([
      ['a', 'text', 'c', 'prompt'],
      ['b', 'text', 'c', 'prompt'],
    ]);
    expect(
      edges.every(
        (edge) => edge.data?.kind === 'data' && edge.data.projection === 'template-input',
      ),
    ).toBe(true);
    expect(edges.every((edge) => edge.reconnectable === false && edge.deletable === false)).toBe(
      true,
    );
    expect(() => fromReactFlowEdge(edges[0])).toThrow('不能导出');
    expect(disconnectWorkflowEdge(workflow, edges[0])).toEqual(workflow);
    expect(workflow).toEqual(snapshot);
    expect(
      toReactFlowEdges(workflowDraftDefinitionSchema.parse(JSON.parse(JSON.stringify(workflow)))),
    ).toEqual(edges);
    expect(workflow.edges).toEqual([]);
  });
  it('同一 source 的多个 alias 视觉去重，删除一个 alias 保留依赖，删去最后引用才消失', () => {
    const workflow = templateWorkflow();
    const binding = prompt(workflow);
    binding.variables.characters = { ...binding.variables.outline! };
    const edges = toReactFlowEdges(workflow);
    expect(edges).toHaveLength(1);
    expect(Object.keys(prompt(workflow).variables)).toEqual(['outline', 'characters']);
    const single = removeAlias(workflow, 'outline');
    expect(toReactFlowEdges(single)).toEqual(edges);
    expect(Object.keys(prompt(single).variables)).toEqual(['characters']);
    const last = removeAlias(single, 'characters');
    expect(toReactFlowEdges(last)).toEqual([]);
    expect(last.nodes[2]!.inputs.prompt).toEqual({ type: 'constant', value: '根据   继续' });
    expect(last.edges).toEqual([]);
  });
  it('不同端口及不同 input 的依赖分别显示，三类关系保持明确身份', () => {
    const workflow = templateWorkflow();
    prompt(workflow).variables.characters = { type: 'node_output', nodeId: 'a', portKey: 'other' };
    workflow.nodes[2]!.inputs.system = {
      type: 'candidate',
      sources: [
        { type: 'node_output', nodeId: 'a', portKey: 'text' },
        { type: 'node_output', nodeId: 'b', portKey: 'text' },
      ],
    };
    workflow.edges.push({
      id: 'real',
      kind: 'data',
      source: { nodeId: 'a', portKey: 'text' },
      target: { nodeId: 'b', portKey: 'prompt' },
    });
    const edges = toReactFlowEdges(workflow);
    expect(edges).toHaveLength(5);
    expect(edges.filter((edge) => edge.data?.projection === 'template-input')).toHaveLength(2);
    expect(edges.filter((edge) => edge.data?.projection === 'candidate-input')).toHaveLength(2);
    expect(edges.filter((edge) => !edge.data?.projection).map(fromReactFlowEdge)).toEqual(
      workflow.edges,
    );
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(5);
  });
  it('Workflow input / Asset / 常量不产生跨节点投影，混合模板只投影 node_output', () => {
    const workflow = templateWorkflow();
    workflow.inputs = [
      { name: 'topic', type: { kind: 'primitive', name: 'string' }, required: false },
    ];
    prompt(workflow).variables.characters = { type: 'workflow_input', key: 'topic' };
    workflow.nodes[0]!.inputs.prompt = { type: 'workflow_input', key: 'topic' };
    workflow.nodes[1]!.inputs.prompt = { type: 'asset', assetId: 'asset', versionId: 'version' };
    workflow.nodes[1]!.inputs.system = {
      type: 'constant',
      value: { type: 'node_output', nodeId: 'a', portKey: 'text' },
    };
    expect(toReactFlowEdges(workflow).map((edge) => edge.source)).toEqual(['a']);
  });
  it('投影 ID 不与真实边碰撞，alias 改名不改变依赖身份', () => {
    const workflow = templateWorkflow();
    const originalId = toReactFlowEdges(workflow)[0]!.id;
    const binding = prompt(workflow);
    binding.value = binding.value.replace('{{outline}}', '{{renamed}}');
    binding.variables.renamed = binding.variables.outline!;
    delete binding.variables.outline;
    expect(toReactFlowEdges(workflow).find((edge) => edge.source === 'a')!.id).toBe(originalId);
    workflow.edges.push({
      id: originalId,
      kind: 'control',
      source: { nodeId: 'a' },
      target: { nodeId: 'c' },
    });
    const edges = toReactFlowEdges(workflow);
    expect(new Set(edges.map((edge) => edge.id)).size).toBe(3);
    expect(edges.find((edge) => edge.data?.projection && edge.source === 'a')!.id).not.toBe(
      originalId,
    );
  });
  it('删除来源节点清理全部相关 alias/token，保留其他来源和文字，投影同步消失', () => {
    const workflow = templateWorkflow();
    prompt(workflow).value += ' {{again}}';
    prompt(workflow).variables.again = { ...prompt(workflow).variables.outline! };
    const remaining = removeWorkflowNodes(workflow, ['a']);
    expect(prompt(remaining)).toEqual({
      type: 'template',
      value: '根据  {{characters}} 继续 ',
      variables: { characters: { type: 'node_output', nodeId: 'b', portKey: 'text' } },
    });
    expect(toReactFlowEdges(remaining).map((edge) => edge.source)).toEqual(['b']);
    expect(
      removeWorkflowNodes(remaining, ['b']).nodes.find((node) => node.id === 'c')!.inputs.prompt,
    ).toEqual({ type: 'constant', value: '根据   继续 ' });
    expect(toReactFlowEdges(removeWorkflowNodes(workflow, ['c']))).toEqual([]);
  });
  it('删去唯一来源且无剩余文字时移除 input，保留混合模板中的 workflow_input', () => {
    const workflow = templateWorkflow();
    workflow.inputs = [
      { name: 'topic', type: { kind: 'primitive', name: 'string' }, required: false },
    ];
    workflow.nodes[2]!.inputs.system = {
      type: 'template',
      value: '{{only}}{{only}}',
      variables: { only: { type: 'node_output', nodeId: 'a', portKey: 'text' } },
    };
    prompt(workflow).variables.characters = { type: 'workflow_input', key: 'topic' };
    const remaining = removeWorkflowNodes(workflow, ['a']);
    expect(remaining.nodes.find((node) => node.id === 'c')!.inputs.system).toBeUndefined();
    expect(prompt(remaining)).toEqual({
      type: 'template',
      value: '根据  {{characters}} 继续',
      variables: { characters: { type: 'workflow_input', key: 'topic' } },
    });
    expect(toReactFlowEdges(remaining)).toEqual([]);
    expect(workflowDraftDefinitionSchema.parse(remaining)).toEqual(remaining);
  });
});
