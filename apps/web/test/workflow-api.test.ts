import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowApi } from '../src/features/workflow/workflow-api';
import {
  addWorkflowOutput,
  projectWorkflowEnd,
  appendWorkflowOutputCandidate,
  removeWorkflowOutputCandidate,
} from '../src/features/workflow/outputs/workflow-outputs';
import { definition, manifest } from './fixtures/workflow-output';
import { ApiError } from '../src/lib/http';
import { ifWorkflow, ifCatalog } from './fixtures/workflow-if';
import { candidateWorkflow } from './fixtures/candidate-input';
import { templateWorkflow } from './fixtures/template-input';
import {
  toReactFlowEdges,
  disconnectWorkflowEdge,
  connectWorkflowNodes,
} from '../src/features/workflow/canvas/react-flow-adapter';
import {
  conditionFromFields,
  conditionToFields,
  setIfCondition,
} from '../src/features/workflow/conditions/if-condition';

const draft = { inputs: [], nodes: [], edges: [], outputs: [] };
const workflow = {
  id: 'workflow-1',
  projectId: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
  name: '默认工作流',
  revision: 3,
  draft,
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
};
afterEach(() => vi.unstubAllGlobals());
function mockResponse(body: unknown, status = 200) {
  const fetch = vi.fn().mockResolvedValue(Response.json(body, { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('Workflow 编辑 HTTP 边界', () => {
  it('Template Save → reload → Save 保留正文与 alias，投影不进入真实 DataEdge', async () => {
    const draft = templateWorkflow();
    const binding = draft.nodes[2]!.inputs.prompt!;
    if (binding.type !== 'template') throw new Error('fixture');
    binding.value += ' {{again}}';
    binding.variables.again = { ...binding.variables.outline! };
    const before = structuredClone(draft);
    const edges = toReactFlowEdges(draft);
    expect(edges).toHaveLength(2);
    const save = mockResponse({ revision: 4 });
    await workflowApi.saveDraft(workflow.id, { expectedRevision: 3, definition: draft });
    const request = JSON.parse(save.mock.calls[0]![1].body as string);
    expect(request.definition).toEqual(before);
    expect(request.definition.edges).toEqual([]);
    mockResponse({ ...workflow, revision: 4, draft: request.definition });
    const loaded = (await workflowApi.get(workflow.projectId)).draft;
    expect(loaded).toEqual(before);
    expect(toReactFlowEdges(loaded)).toEqual(edges);
    const resave = mockResponse({ revision: 5 });
    await workflowApi.saveDraft(workflow.id, { expectedRevision: 4, definition: loaded });
    expect(JSON.parse(resave.mock.calls[0]![1].body as string).definition).toEqual(
      request.definition,
    );
    expect(draft).toEqual(before);
  });
  it('候选输入 Save/reload 保留完整与单候选 binding，投影不进入保存请求', async () => {
    const multiple = candidateWorkflow();
    const projections = toReactFlowEdges(multiple).filter((edge) => edge.data?.projection);
    for (const draft of [multiple, disconnectWorkflowEdge(multiple, projections[0])]) {
      const fetch = mockResponse({ revision: 4 });
      await workflowApi.saveDraft(workflow.id, { expectedRevision: 3, definition: draft });
      const request = JSON.parse(fetch.mock.calls[0]![1].body as string);
      expect(request.definition).toEqual(draft);
      expect(
        request.definition.edges.every((edge: { kind: string }) => edge.kind === 'control'),
      ).toBe(true);
      mockResponse({ ...workflow, revision: 4, draft: request.definition });
      const loaded = (await workflowApi.get(workflow.projectId)).draft;
      expect(loaded).toEqual(draft);
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(draft));
      expect(toReactFlowEdges(loaded)).toEqual(toReactFlowEdges(draft));
    }
  });
  it('多候选与候选不足的 Draft 都能 Save/reload，保留 sources 模式及输出类型', async () => {
    const multiple = appendWorkflowOutputCandidate(
      addWorkflowOutput(definition(), { nodeId: 'b', outputKey: 'text' }, [manifest]),
      'result',
      { nodeId: 'a', outputKey: 'text' },
      [manifest],
    );
    for (const draft of [
      multiple,
      removeWorkflowOutputCandidate(multiple, 'result', { nodeId: 'a', outputKey: 'text' }),
    ]) {
      const fetch = mockResponse({ revision: 4 });
      await workflowApi.saveDraft(workflow.id, { expectedRevision: 3, definition: draft });
      const request = JSON.parse(fetch.mock.calls[0]![1].body as string);
      expect(request.definition).toEqual(draft);
      mockResponse({ ...workflow, revision: 4, draft: request.definition });
      expect((await workflowApi.get(workflow.projectId)).draft).toEqual(draft);
      expect(projectWorkflowEnd(draft).edges).toHaveLength(draft.outputs[0]!.sources!.length);
    }
  });
  it('If 缺少条件、输入或分支仍可保存；完整定义保存/读取保留条件和 named port', async () => {
    const incomplete = ifWorkflow();
    let fetch = mockResponse({ revision: 4 });
    await workflowApi.saveDraft(workflow.id, { expectedRevision: 3, definition: incomplete });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string).definition).toEqual(incomplete);
    let complete = setIfCondition(incomplete, 'if', conditionFromFields('not_contains', ' 通过 '));
    complete = connectWorkflowNodes(
      complete,
      { source: 'a', sourceHandle: 'text', target: 'if', targetHandle: 'value' },
      ifCatalog,
    );
    for (const [port, target] of [
      ['true', 'b'],
      ['false', 'c'],
    ])
      complete = connectWorkflowNodes(
        complete,
        {
          source: 'if',
          sourceHandle: `control:source:${port}`,
          target,
          targetHandle: 'control:target',
        },
        ifCatalog,
      );
    fetch = mockResponse({ revision: 5 });
    await workflowApi.saveDraft(workflow.id, { expectedRevision: 4, definition: complete });
    const request = JSON.parse(fetch.mock.calls[0]![1].body as string);
    expect(request.definition).toEqual(complete);
    mockResponse({ ...workflow, revision: 5, draft: request.definition });
    const reloaded = await workflowApi.get(workflow.projectId);
    expect(reloaded.draft).toEqual(complete);
    expect(conditionToFields(reloaded.draft.nodes[0]!.config.condition)).toEqual({
      operator: 'not_contains',
      expected: ' 通过 ',
    });
  });
  it('GET 保留真实身份、草稿和独立 revision，并使用同源会话', async () => {
    const fetch = mockResponse(workflow);
    expect(await workflowApi.get(workflow.projectId)).toEqual(workflow);
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${workflow.projectId}/workflow`,
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });
  it('GET 404 传播给显式初始化 UI，不自动 POST', async () => {
    const fetch = mockResponse({ message: '工作流不存在' }, 404);
    await expect(workflowApi.get(workflow.projectId)).rejects.toMatchObject({ status: 404 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
  });
  it('初始化是独立 POST 操作', async () => {
    const fetch = mockResponse(workflow);
    await workflowApi.initialize(workflow.projectId);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });
  it('PUT 完整草稿与 expectedRevision，空配置草稿不执行发布校验', async () => {
    const fetch = mockResponse({ revision: 4 });
    const input = { expectedRevision: 3, definition: draft };
    expect(await workflowApi.saveDraft(workflow.id, input)).toEqual({ revision: 4 });
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/workflows/workflow-1/draft',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(input) }),
    );
  });
  it.each([409, 403, 404, 500])('失败保留 HTTP 状态且不重试（%s）', async (status) => {
    const fetch = mockResponse({ message: '保存失败' }, status);
    await expect(
      workflowApi.saveDraft(workflow.id, { expectedRevision: 3, definition: draft }),
    ).rejects.toMatchObject({ status, message: '保存失败' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('拒绝不符合契约的成功响应，不能误报已保存', async () => {
    mockResponse({ revision: 0 });
    await expect(
      workflowApi.saveDraft(workflow.id, { expectedRevision: 3, definition: draft }),
    ).rejects.toBeInstanceOf(ApiError);
  });
  it('网络失败不转为成功或空草稿', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('网络中断')));
    await expect(workflowApi.get(workflow.projectId)).rejects.toThrow('网络中断');
  });
  it('End output 保存后重新读取无损，boundary node / edge 不进入请求', async () => {
    const definitionWithOutput = addWorkflowOutput(
      definition(),
      { nodeId: 'b', outputKey: 'text' },
      [manifest],
    );
    const boundary = projectWorkflowEnd(definitionWithOutput);
    const fetch = mockResponse({ revision: 4 });
    await workflowApi.saveDraft(workflow.id, {
      expectedRevision: 3,
      definition: definitionWithOutput,
    });
    const request = JSON.parse(fetch.mock.calls[0]![1].body as string);
    expect(request.definition.outputs).toEqual(definitionWithOutput.outputs);
    expect(
      request.definition.nodes.some((node: { id: string }) => node.id === boundary.node.id),
    ).toBe(false);
    expect(request.definition.edges).toEqual([]);
    mockResponse({ ...workflow, revision: 4, draft: request.definition });
    const reloaded = await workflowApi.get(workflow.projectId);
    expect(reloaded.draft.outputs).toEqual(definitionWithOutput.outputs);
    expect(projectWorkflowEnd(reloaded.draft).edges).toHaveLength(1);
  });
});
