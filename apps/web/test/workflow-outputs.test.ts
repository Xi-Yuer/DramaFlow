import { describe, expect, it } from 'vitest';
import { workflowDefinitionSchema } from '@dramaflow/contracts';
import {
  addWorkflowOutput,
  setWorkflowOutput,
  removeWorkflowOutput,
  projectWorkflowEnd,
  removeWorkflowNodes,
} from '../src/features/workflow/outputs/workflow-outputs';
import {
  toReactFlowNodes,
  toReactFlowEdges,
  connectWorkflowNodes,
} from '../src/features/workflow/canvas/react-flow-adapter';

import { manifest, definition } from './fixtures/workflow-output';
const source = { nodeId: 'b', outputKey: 'text' };

describe('Workflow outputs 与 End UI 投影', () => {
  it('空 outputs 仍有 End，投影不进入可保存的 Definition', () => {
    const workflow = definition();
    const end = projectWorkflowEnd(workflow);
    expect(end.node.type).toBe('workflowEnd');
    expect(end.edges).toEqual([]);
    expect(toReactFlowNodes(workflow)).toHaveLength(2);
    expect(workflowDefinitionSchema.parse(workflow)).toEqual(workflow);
    expect(workflow.nodes.some((node) => node.id === end.node.id)).toBe(false);
  });
  it('拖线创建 result，类型来自实际端口，不写 domain edges；保存再加载恢复', () => {
    const workflow = addWorkflowOutput(definition(), source, [manifest]);
    expect(workflow.outputs).toEqual([
      { name: 'result', source, type: manifest.outputs[0]!.dataType },
    ]);
    expect(workflow.edges).toEqual([]);
    const restored = workflowDefinitionSchema.parse(JSON.parse(JSON.stringify(workflow)));
    const end = projectWorkflowEnd(restored);
    expect(end.node.data.outputs).toEqual(workflow.outputs);
    expect(end.edges[0]).toMatchObject({
      source: 'b',
      sourceHandle: 'text',
      target: end.node.id,
      label: 'result',
    });
    expect(toReactFlowEdges(restored)).toEqual([]);
  });
  it('多输出自动生成唯一名称，修改名称和来源后更新类型', () => {
    const first = addWorkflowOutput(definition(), source, [manifest]);
    const second = addWorkflowOutput(first, source, [manifest]);
    expect(second.outputs.map((output) => output.name)).toEqual(['result', 'result_2']);
    const changed = setWorkflowOutput(
      second,
      { name: 'video', source: { nodeId: 'a', outputKey: 'video' } },
      [manifest],
      'result_2',
    );
    expect(changed.outputs[1]?.type).toEqual({ kind: 'named', name: 'media.video' });
    expect(projectWorkflowEnd(changed).edges).toHaveLength(2);
    expect(first.outputs).toHaveLength(1);
  });
  it.each(['', 'bad name', 'constructor', '1result', 'result'])(
    '名称 %j 无效或重复时不写入',
    (name) => {
      const workflow = addWorkflowOutput(definition(), source, [manifest]);
      expect(() => setWorkflowOutput(workflow, { name, source }, [manifest])).toThrow();
      expect(workflow.outputs).toHaveLength(1);
    },
  );
  it('删除 output 仅删除它对应的声明；节点删除同步清理引用及普通边', () => {
    let workflow = addWorkflowOutput(definition(), source, [manifest]);
    workflow = addWorkflowOutput(workflow, { nodeId: 'a', outputKey: 'text' }, [manifest]);
    workflow = connectWorkflowNodes(
      workflow,
      { source: 'a', sourceHandle: 'text', target: 'b', targetHandle: 'prompt' },
      [manifest],
    );
    expect(removeWorkflowOutput(workflow, 'result').outputs.map((output) => output.name)).toEqual([
      'result_2',
    ]);
    const removed = removeWorkflowNodes(workflow, ['b']);
    expect(removed.outputs.map((output) => output.name)).toEqual(['result_2']);
    expect(removed.nodes.map((node) => node.id)).toEqual(['a']);
    expect(removed.edges).toEqual([]);
    expect(() => workflowDefinitionSchema.parse(removed)).not.toThrow();
  });
  it('目录不可用或来源无效不猜测类型；精确匹配版本', () => {
    for (const manifests of [[], [{ ...manifest, version: 2 }]]) {
      expect(() => addWorkflowOutput(definition(), source, manifests)).toThrow();
    }
    expect(() =>
      addWorkflowOutput(definition(), { nodeId: 'missing', outputKey: 'text' }, [manifest]),
    ).toThrow();
    expect(() =>
      addWorkflowOutput(definition(), { nodeId: 'a', outputKey: 'missing' }, [manifest]),
    ).toThrow();
  });
  it('UI node/edge 标识不与领域标识冲突', () => {
    const workflow = addWorkflowOutput(definition(), source, [manifest]);
    const previous = projectWorkflowEnd(workflow);
    workflow.nodes.push({ ...workflow.nodes[0]!, id: previous.node.id });
    workflow.edges.push({
      id: previous.edges[0]!.id,
      kind: 'control',
      source: { nodeId: 'a' },
      target: { nodeId: 'b' },
    });
    const end = projectWorkflowEnd(workflow);
    expect(workflow.nodes.some((node) => node.id === end.node.id)).toBe(false);
    expect(workflow.edges.some((edge) => edge.id === end.edges[0]?.id)).toBe(false);
  });
});
