import { describe, expect, it } from 'vitest';
import {
  executionTreeEntrySchema,
  executionTreeExecutionSchema,
  executionTreeQuerySchema,
  executionTreeResponseSchema,
} from '../src/index.js';

const execution = {
  type: 'child_execution',
  id: 'stable-execution',
  kind: 'subgraph_call',
  parent: { type: 'node_run', id: 'owner-attempt' },
  status: 'running',
  createdAt: '2026-10-26T00:00:00.000Z',
  startedAt: '2026-10-26T00:00:00.000Z',
};
describe('通用 Execution Tree JSON Contract', () => {
  it('任意结构种类可没有 index / metadata，identity 与显示信息分开', () => {
    expect(executionTreeExecutionSchema.parse(execution)).toEqual(execution);
    const item = { ...execution, kind: 'iteration_item', metadata: { index: 2 } };
    expect(executionTreeExecutionSchema.parse(item).id).toBe(execution.id);
    expect(executionTreeExecutionSchema.parse({ ...item, metadata: { index: 5 } }).id).toBe(
      execution.id,
    );
  });
  it('NodeRun 保留 occurrence / attempt，父节点为 root 或 execution', () => {
    const node = {
      type: 'node_run',
      id: 'nr',
      nodeId: 'same-local-name',
      occurrenceId: 'occurrence',
      attempt: 2,
      status: 'completed',
      startedAt: execution.startedAt,
      completedAt: execution.startedAt,
      parent: { type: 'child_execution', id: execution.id },
    };
    expect(executionTreeEntrySchema.parse(node)).toEqual(node);
    expect(
      executionTreeEntrySchema.parse({ ...node, parent: { type: 'workflow_run', id: 'run' } }),
    ).toBeDefined();
    expect(
      executionTreeEntrySchema.safeParse({ ...node, parent: { type: 'node_run', id: 'other' } })
        .success,
    ).toBe(false);
  });
  it('严格拒绝持久化细节、原生引擎数据和 payload 混入摘要', () => {
    for (const key of [
      'iterationItemRunId',
      'iterationNodeRunId',
      'childExecutionId',
      'parentNodeRunId',
      'scopeKey',
      'threadId',
      'checkpointNs',
      'taskId',
      'command',
      'inputs',
      'outputs',
    ])
      expect(
        executionTreeExecutionSchema.safeParse({ ...execution, [key]: 'private' }).success,
      ).toBe(false);
    expect(
      executionTreeExecutionSchema.safeParse({ ...execution, metadata: { payload: { large: [] } } })
        .success,
    ).toBe(false);
    expect(
      executionTreeExecutionSchema.safeParse({ ...execution, metadata: { text: 'a'.repeat(201) } })
        .success,
    ).toBe(false);
    expect(
      executionTreeExecutionSchema.safeParse({
        ...execution,
        metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, i])),
      }).success,
    ).toBe(false);
    expect(
      executionTreeExecutionSchema.safeParse({ ...execution, status: 'interrupt' }).success,
    ).toBe(false);
  });
  it('默认查根层，有界分页，拒绝缺失父 ID、未知参数和非法 limit', () => {
    expect(executionTreeQuerySchema.parse({})).toEqual({ parentType: 'workflow_run', limit: 50 });
    expect(
      executionTreeQuerySchema.parse({
        parentType: 'child_execution',
        parentId: execution.id,
        limit: '2',
      }).limit,
    ).toBe(2);
    for (const value of [
      { parentType: 'node_run' },
      { limit: 0 },
      { limit: 101 },
      { limit: 'NaN' },
      { scopeKey: 'private' },
      { after: '' },
    ])
      expect(executionTreeQuerySchema.safeParse(value).success).toBe(false);
  });
  it('response 可 JSON 往返，根状态复用 WorkflowRun，不返回内部运行身份', () => {
    const response = {
      run: {
        type: 'workflow_run',
        id: 'run',
        workflowId: 'workflow',
        workflowVersionId: 'version',
        status: 'waiting',
        createdAt: execution.createdAt,
      },
      parent: { type: 'node_run', id: 'owner-attempt' },
      items: [execution],
      nextCursor: null,
    };
    expect(executionTreeResponseSchema.parse(JSON.parse(JSON.stringify(response)))).toEqual(
      response,
    );
    expect(
      executionTreeResponseSchema.safeParse({
        ...response,
        run: { ...response.run, threadId: 'private' },
      }).success,
    ).toBe(false);
  });
});
