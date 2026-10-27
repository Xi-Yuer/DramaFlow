import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionTreeService } from '@dramaflow/server';
import type { AuthActor } from '../../auth/auth.service.js';
import { WorkflowExecutionTreeController } from './workflow-execution-tree.controller.js';

describe('Execution Tree 只读 HTTP 入口', () => {
  it('统一传认证用户、Run 与查询参数给 Tree Service，不调用 Runtime', async () => {
    const query = vi.fn().mockResolvedValue({ items: [] });
    const controller = new WorkflowExecutionTreeController({
      query,
    } as unknown as WorkflowExecutionTreeService);
    const params = { parentType: 'child_execution', parentId: 'stable-id' };
    expect(await controller.query({ user: { id: 'owner' } } as AuthActor, 'run', params)).toEqual({
      items: [],
    });
    expect(query).toHaveBeenCalledWith('owner', 'run', params);
  });
  it('默认认证、GET、no-store；入口命名不绑定 Composite 类型', () => {
    const method = WorkflowExecutionTreeController.prototype.query;
    expect(Reflect.getMetadata('path', method)).toBe(':runId/execution-tree');
    expect(Reflect.getMetadata('method', method)).toBe(0);
    expect(Reflect.getMetadata('__headers__', method)).toContainEqual({
      name: 'Cache-Control',
      value: 'no-store',
    });
    expect(Reflect.getMetadata('auth:public', method)).not.toBe(true);
    expect(Reflect.getMetadata('auth:public', WorkflowExecutionTreeController)).not.toBe(true);
  });
});
