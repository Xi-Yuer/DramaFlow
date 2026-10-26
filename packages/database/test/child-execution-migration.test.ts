import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@dramaflow/database';
import { PrismaExecutionTreeAdapter } from '../../server/src/workflow/execution-tree/prisma-execution-tree-adapter.js';

const enabled = process.env.DRAMAFLOW_INTEGRATION === '1';
const migration = (name: string) =>
  readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8');
describe.skipIf(!enabled)('ChildExecution lossless migration', () => {
  it('原地迁移三种状态和多个 parent attempt，保留 ID/FK/index，旧 Run 继续通过正式 Tree Adapter 查询', async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/dramaflow_test')
      throw new Error('仅允许本机 dramaflow_test');
    const schema = `child_migration_${randomUUID().replaceAll('-', '')}`;
    const client = new pg.Client({ connectionString: url.href });
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.href }, { schema }),
    });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}", public`);
      await client.query('CREATE TABLE "canvas_project" ("id" UUID PRIMARY KEY)');
      for (const name of [
        '20261020000000_node_runs',
        '20261020010000_node_run_boundary',
        '20261020020000_workflow_runs',
        '20261020060000_artifacts',
        '20261024000000_node_occurrences',
        '20261026000000_iteration_item_runs',
      ])
        await client.query(migration(name));
      const projectId = randomUUID(),
        occurrence = randomUUID();
      const parents = [randomUUID(), randomUUID()];
      const children = [randomUUID(), randomUUID(), randomUUID()];
      const bodies = [randomUUID(), randomUUID(), randomUUID()];
      await client.query('INSERT INTO "canvas_project" VALUES ($1)', [projectId]);
      await client.query(
        `INSERT INTO "workflow_run" ("id","projectId","workflowId","workflowVersionId","threadId","inputs") VALUES ('legacy',$1,'workflow','version','thread','{}')`,
        [projectId],
      );
      await client.query(
        `INSERT INTO "node_occurrence" ("id","projectId","workflowRunId","nodeId","scopeKey") VALUES ($1,$2,'legacy','iteration','root')`,
        [occurrence, projectId],
      );
      for (let i = 0; i < 2; i++)
        await client.query(
          `INSERT INTO "node_run" ("id","projectId","workflowRunId","nodeId","occurrenceId","attempt") VALUES ($1,$2,'legacy','iteration',$3,$4)`,
          [parents[i], projectId, occurrence, i + 1],
        );
      const statuses = ['running', 'completed', 'failed'];
      for (let i = 0; i < 3; i++) {
        const scope = `opaque-${i}`,
          index = i === 2 ? 0 : i;
        await client.query(
          `INSERT INTO "iteration_item_run" ("id","projectId","workflowRunId","iterationNodeRunId","iterationNodeId","scopeKey","index","status","completedAt","error") VALUES ($1,$2,'legacy',$3,'iteration',$4,$5,$6,$7,$8)`,
          [
            children[i],
            projectId,
            parents[i === 2 ? 1 : 0],
            scope,
            index,
            statuses[i],
            i === 0 ? null : new Date('2026-10-26T00:00:00Z'),
            i === 2 ? { stage: 'execute', message: 'legacy error' } : null,
          ],
        );
        const bodyOccurrence = randomUUID();
        await client.query(
          `INSERT INTO "node_occurrence" ("id","projectId","workflowRunId","nodeId","scopeKey") VALUES ($1,$2,'legacy','format',$3)`,
          [bodyOccurrence, projectId, scope],
        );
        await client.query(
          `INSERT INTO "node_run" ("id","projectId","workflowRunId","nodeId","occurrenceId","iterationItemRunId","attempt") VALUES ($1,$2,'legacy','format',$3,$4,1)`,
          [bodies[i], projectId, bodyOccurrence, children[i]],
        );
      }
      const before = (
        await client.query<
          Record<string, unknown> & {
            iterationNodeRunId: string;
            iterationNodeId: string;
            index: number;
          }
        >('SELECT * FROM "iteration_item_run" ORDER BY "id"')
      ).rows;
      const nodeBefore = (
        await client.query<Record<string, unknown> & { iterationItemRunId: string | null }>(
          'SELECT * FROM "node_run" ORDER BY "id"',
        )
      ).rows;
      await client.query(migration('20261027000000_child_executions'));
      const after = (await client.query('SELECT * FROM "child_execution" ORDER BY "id"')).rows;
      expect(after).toEqual(
        before.map(({ iterationNodeRunId, iterationNodeId, ...row }) => ({
          ...row,
          parentNodeRunId: iterationNodeRunId,
          parentNodeId: iterationNodeId,
          kind: 'iteration_item',
          invocationKey: `iteration-item:${row.index}`,
          metadata: { index: row.index },
        })),
      );
      expect((await client.query('SELECT * FROM "node_run" ORDER BY "id"')).rows).toEqual(
        nodeBefore.map(({ iterationItemRunId, ...row }) => ({
          ...row,
          childExecutionId: iterationItemRunId,
        })),
      );
      const source = new PrismaExecutionTreeAdapter(prisma, { projectId, workflowRunId: 'legacy' });
      const root = await source.children({ type: 'workflow_run', id: 'legacy' }, { take: 10 });
      expect(root.map((n) => n.id)).toEqual(parents);
      const executions = await source.children({ type: 'node_run', id: parents[0]! }, { take: 10 });
      expect(executions).toMatchObject([
        { id: children[0], kind: 'iteration_item', metadata: { index: 0 }, status: 'running' },
        { id: children[1], kind: 'iteration_item', metadata: { index: 1 }, status: 'completed' },
      ]);
      expect(
        await source.children({ type: 'child_execution', id: children[0]! }, { take: 10 }),
      ).toMatchObject([
        { id: bodies[0], parent: { type: 'child_execution', id: children[0] }, attempt: 1 },
      ]);
      // 原约束 + 新 invocation 唯一约束均实际执行；独立语句失败不会污染后续断言。
      await expect(
        client.query('UPDATE "child_execution" SET "metadata"=\'{"index":9}\' WHERE "id"=$1', [
          children[0],
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query('UPDATE "node_run" SET "childExecutionId"=$1 WHERE "id"=$2', [
          children[1],
          bodies[0],
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(
          `INSERT INTO "child_execution" SELECT $1,"projectId","workflowRunId","parentNodeRunId","parentNodeId",'new-scope',"index","status","error","createdAt","startedAt","completedAt","kind","invocationKey","metadata" FROM "child_execution" WHERE "id"=$2`,
          [randomUUID(), children[0]],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        client.query(
          `INSERT INTO "child_execution" ("id","projectId","workflowRunId","parentNodeRunId","parentNodeId","scopeKey","kind","invocationKey","metadata") VALUES ($1,$2,'legacy',$3,'iteration','generic','subworkflow','fixed-call','{}')`,
          [randomUUID(), projectId, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await prisma.$disconnect();
      await client.query('ROLLBACK');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
});
