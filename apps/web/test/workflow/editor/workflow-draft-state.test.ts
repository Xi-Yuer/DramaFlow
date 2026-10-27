import { describe, expect, it } from 'vitest';
import type { WorkflowResponse } from '@dramaflow/contracts';
import {
  createWorkflowDraftState,
  workflowDraftReducer as reduce,
  workflowDraftSignature as signature,
} from '../../../src/features/workflow/editor/draft/workflow-draft-state';

const workflow: WorkflowResponse = {
  id: 'workflow-1',
  projectId: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
  name: '默认工作流',
  revision: 7,
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
  draft: { inputs: [], nodes: [], edges: [], outputs: [] },
};
const edited = {
  ...workflow.draft,
  nodes: [
    {
      id: 'a',
      type: 'ai.text_generate',
      typeVersion: 1,
      name: '文本',
      inputs: {},
      config: {},
      ui: { position: { x: 100, y: 200 } },
    },
  ],
};

describe('真实 Workflow 草稿状态', () => {
  it('从服务器身份、修订和完整草稿建立保存基线，不引入 Project revision', () => {
    const state = createWorkflowDraftState({ ...workflow, draft: edited });
    expect(state.definition).toEqual(edited);
    expect(state.revision).toBe(7);
    expect(signature(state.definition)).toBe(state.savedSignature);
    expect(state.workflowId).toBe(workflow.id);
  });
  it('保存确认只更新提交快照的基线，保留请求期间产生的新修改', () => {
    let state = reduce(createWorkflowDraftState(workflow), { type: 'edit', definition: edited });
    state = reduce(state, { type: 'save-started' });
    const newer = structuredClone(edited);
    newer.nodes[0].ui.position.x = 300;
    state = reduce(state, { type: 'edit', definition: newer });
    state = reduce(state, { type: 'save-succeeded', revision: 8, snapshot: edited });
    expect(state.revision).toBe(8);
    expect(state.definition).toEqual(newer);
    expect(signature(state.definition)).not.toBe(state.savedSignature);
    expect(state.savedSignature).toBe(signature(edited));
    state = reduce(state, { type: 'save-succeeded', revision: 9, snapshot: newer });
    expect(signature(state.definition)).toBe(state.savedSignature);
  });
  it.each([true, false])('409 或网络失败不推进修订或覆盖本地内容（conflict=%s）', (conflict) => {
    const original = createWorkflowDraftState(workflow);
    let state = reduce(original, { type: 'edit', definition: edited });
    state = reduce(state, { type: 'save-failed', conflict, message: '未确认' });
    expect(state.definition).toEqual(edited);
    expect(state.revision).toBe(original.revision);
    expect(state.savedSignature).toBe(original.savedSignature);
    expect(state.conflict).toBe(conflict);
    expect(state.error).toBe('未确认');
  });
  it('重新读取失败保留冲突和修改，只有成功读取才替换本地草稿', () => {
    let state = reduce(createWorkflowDraftState(workflow), { type: 'edit', definition: edited });
    state = reduce(state, { type: 'save-failed', conflict: true, message: '冲突' });
    state = reduce(state, { type: 'reload-started' });
    state = reduce(state, { type: 'reload-failed', message: '网络中断' });
    expect(state.conflict).toBe(true);
    expect(state.definition).toEqual(edited);
    const server = { ...workflow, revision: 12 };
    state = reduce(state, { type: 'reload-succeeded', workflow: server });
    expect(state).toEqual(createWorkflowDraftState(server));
  });
});
