import {
  executionTreeQuerySchema,
  executionTreeRunSchema,
  workflowIdentifierSchema,
  type ExecutionTreeResponse,
} from '@dramaflow/contracts';
import { Prisma } from '@dramaflow/database';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { ExecutionTreeQueryError, queryExecutionTree } from './execution-tree-query.js';
import { PrismaExecutionTreeAdapter } from './prisma-execution-tree-adapter.js';

@Injectable()
export class WorkflowExecutionTreeService {
  constructor(private readonly database: DatabaseService) {}

  async query(
    ownerId: string,
    rawRunId: string,
    rawQuery: unknown = {},
  ): Promise<ExecutionTreeResponse> {
    const id = workflowIdentifierSchema.safeParse(rawRunId);
    const query = executionTreeQuerySchema.safeParse(rawQuery);
    if (!id.success || !query.success)
      throw new BadRequestException({
        code: 'WORKFLOW_EXECUTION_TREE_QUERY_INVALID',
        message: '运行树查询参数无效',
      });
    try {
      return await this.database.client.$transaction(
        async (tx) => {
          // 与现有 Run 查询一致的 Owner → Project → Run 授权；所有 source 共用这个入口。
          const row = await tx.workflowRun.findFirst({
            where: { id: id.data, project: { ownerId } },
            select: {
              id: true,
              projectId: true,
              workflowId: true,
              workflowVersionId: true,
              status: true,
              error: true,
              createdAt: true,
              startedAt: true,
              completedAt: true,
            },
          });
          if (!row)
            throw new NotFoundException({
              code: 'WORKFLOW_RUN_NOT_FOUND',
              message: '工作流运行不存在或无权访问',
            });
          const run = executionTreeRunSchema.parse({
            type: 'workflow_run',
            id: row.id,
            workflowId: row.workflowId,
            workflowVersionId: row.workflowVersionId,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
            ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
            ...(row.error !== null ? { error: row.error } : {}),
          });
          const source = new PrismaExecutionTreeAdapter(tx, {
            projectId: row.projectId,
            workflowRunId: row.id,
          });
          return queryExecutionTree(source, run, query.data);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    } catch (error) {
      if (!(error instanceof ExecutionTreeQueryError)) throw error;
      if (error.code === 'PARENT_NOT_FOUND')
        throw new NotFoundException({
          code: 'WORKFLOW_EXECUTION_TREE_PARENT_NOT_FOUND',
          message: '运行树父条目不存在或不属于本次运行',
        });
      if (error.code === 'CURSOR_INVALID')
        throw new BadRequestException({
          code: 'WORKFLOW_EXECUTION_TREE_CURSOR_INVALID',
          message: '运行树分页位置无效，请重新查询',
        });
      throw new InternalServerErrorException(
        {
          code: 'WORKFLOW_EXECUTION_TREE_INCONSISTENT',
          message: '运行树记录无法完整关联',
        },
        { cause: error },
      );
    }
  }
}
