import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { WorkflowVersionRepositories } from '../src/workflow/run/repository/workflow-version-repository.js';

describe('WorkflowVersionRepositories.findOwnedWorkflow', () => {
  it('按 owner 定位版本所属工作流，找不到时返回 null', async () => {
    const findFirst = vi.fn(
      async (query: { where: { id: string; workflow: { project: { ownerId: string } } } }) =>
        query.where.id === 'version-a' && query.where.workflow.project.ownerId === 'owner-a'
          ? { workflow: { id: 'workflow-a', projectId: 'project-a' } }
          : null,
    );
    const repositories = new WorkflowVersionRepositories({
      client: { workflowVersion: { findFirst } },
    } as unknown as DatabaseService);

    await expect(repositories.findOwnedWorkflow('owner-a', 'version-a')).resolves.toEqual({
      projectId: 'project-a',
      workflowId: 'workflow-a',
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'version-a',
        workflow: { project: { ownerId: 'owner-a' } },
      },
      select: { workflow: { select: { id: true, projectId: true } } },
    });
    await expect(repositories.findOwnedWorkflow('owner-b', 'version-a')).resolves.toBeNull();
  });
});
