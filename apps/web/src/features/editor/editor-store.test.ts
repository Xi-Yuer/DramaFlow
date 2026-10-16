import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowDraft } from '@dramaflow/contracts';
import { isEditorDirty, useEditorStore } from './editor-store';

const draft: WorkflowDraft = {
  id: 'wf',
  workspaceId: 'team',
  name: '创作',
  description: '',
  revision: 2,
  publishedVersionId: null,
  updatedAt: '2026-10-16T00:00:00Z',
  definition: {
    schemaVersion: 1,
    nodes: [
      {
        id: 'a',
        type: 'input',
        version: '1.0.0',
        title: '输入',
        position: { x: 0, y: 0 },
        config: {},
      },
      {
        id: 'b',
        type: 'output',
        version: '1.0.0',
        title: '输出',
        position: { x: 200, y: 0 },
        config: {},
      },
    ],
    controlEdges: [{ id: 'ab', source: 'a', target: 'b', sourcePort: 'out' }],
    bindings: [
      {
        nodeId: 'b',
        port: 'result',
        source: { kind: 'node', nodeId: 'a', port: 'value' },
        optional: false,
      },
    ],
  },
};

beforeEach(() => useEditorStore.getState().load(structuredClone(draft)));
describe('编辑器的草稿隔离', () => {
  it('编辑后撤销恢复基线与dirty状态', () => {
    const store = useEditorStore.getState();
    store.updateNode('a', { title: '需求' });
    expect(isEditorDirty(useEditorStore.getState())).toBe(true);
    useEditorStore.getState().undo();
    expect(isEditorDirty(useEditorStore.getState())).toBe(false);
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().definition.nodes[0].title).toBe('需求');
  });
  it('删除节点同步清理执行边与引用绑定，并可完整撤销', () => {
    useEditorStore.getState().removeNode('a');
    expect(useEditorStore.getState().definition.controlEdges).toHaveLength(0);
    expect(useEditorStore.getState().definition.bindings).toHaveLength(0);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().definition).toEqual(draft.definition);
  });
  it('保存更新revision和基线，同时保留节点选择', () => {
    useEditorStore.getState().select('a');
    useEditorStore.getState().acceptSaved({ ...draft, revision: 3 });
    expect(useEditorStore.getState().selectedNodeId).toBe('a');
    expect(useEditorStore.getState().revision).toBe(3);
    expect(isEditorDirty(useEditorStore.getState())).toBe(false);
  });
});
