import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

// 普通单元测试不连接数据库；仅在显式隔离集成环境重放真实迁移。
describe.skipIf(process.env.DRAMAFLOW_INTEGRATION !== '1')(
  'NodeOccurrence 无损迁移与数据库约束',
  () => {
    it('旧 root 审计和 Artifact 原样保留，不同 scope 的 attempt 可独立从 1 开始', async () => {
      const url = new URL(process.env.DATABASE_URL ?? '');
      if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/dramaflow_test')
        throw new Error('迁移测试仅允许本机 dramaflow_test');
      const client = new pg.Client({ connectionString: url.href });
      const schema = `occurrence_migration_${randomUUID().replaceAll('-', '')}`;
      await client.connect();
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);
        await client.query('CREATE TABLE "canvas_project" ("id" UUID PRIMARY KEY)');
        const migration = (name: string) =>
          readFileSync(
            new URL(`../../database/prisma/migrations/${name}/migration.sql`, import.meta.url),
            'utf8',
          );
        // 真实旧 NodeRun / WorkflowRun / Artifact DDL；只用独立 schema 的最小 Project 父表。
        for (const name of [
          '20261020000000_node_runs',
          '20261020010000_node_run_boundary',
          '20261020020000_workflow_runs',
          '20261020060000_artifacts',
        ])
          await client.query(migration(name));
        const projectId = randomUUID();
        const ids = [randomUUID(), randomUUID(), randomUUID()];
        const artifactId = randomUUID();
        await client.query('INSERT INTO "canvas_project" VALUES ($1)', [projectId]);
        await client.query(
          'INSERT INTO "workflow_run" ("id", "projectId", "workflowId", "workflowVersionId", "threadId", "inputs") VALUES ($1,$2,$3,$4,$5,$6)',
          ['run', projectId, 'workflow', 'version', 'thread', {}],
        );
        await client.query(
          `INSERT INTO "node_run" ("id", "projectId", "workflowRunId", "nodeId", "attempt", "status", "inputs", "outputs", "error", "completedAt") VALUES
        ($1,$4,'run','A',1,'failed',NULL,NULL,'{"stage":"execute","message":"failed"}',CURRENT_TIMESTAMP),
        ($2,$4,'run','A',2,'completed','{}','{"text":{"storage":"inline","value":"kept"}}',NULL,CURRENT_TIMESTAMP),
        ($3,$4,'run','B',1,'running',NULL,NULL,NULL,NULL)`,
          [...ids, projectId],
        );
        await client.query(
          `INSERT INTO "artifact" ("id","projectId","workflowRunId","nodeRunId","nodeId","outputKey","type","contentKind","storageKey","mimeType","size","checksum")
        VALUES ($1,$2,'run',$3,'A','text','{}','json','migration-fixture','application/json',0,'checksum')`,
          [artifactId, projectId, ids[1]],
        );
        const before = await client.query(
          'SELECT to_jsonb(n) AS value FROM "node_run" n ORDER BY "nodeId", "attempt"',
        );
        const artifactBefore = await client.query('SELECT to_jsonb(a) AS value FROM "artifact" a');
        await client.query(migration('20261024000000_node_occurrences'));
        const after = await client.query(
          'SELECT to_jsonb(n) - \'occurrenceId\' AS value FROM "node_run" n ORDER BY "nodeId", "attempt"',
        );
        expect(after.rows).toEqual(before.rows);
        expect((await client.query('SELECT to_jsonb(a) AS value FROM "artifact" a')).rows).toEqual(
          artifactBefore.rows,
        );
        const occurrences = await client.query<{ id: string; nodeId: string; scopeKey: string }>(
          'SELECT * FROM "node_occurrence" ORDER BY "nodeId"',
        );
        expect(occurrences.rows.map((row) => [row.nodeId, row.scopeKey])).toEqual([
          ['A', 'root'],
          ['B', 'root'],
        ]);
        const root = occurrences.rows[0]!;
        expect(
          (
            await client.query(
              'SELECT DISTINCT "occurrenceId" FROM "node_run" WHERE "nodeId" = \'A\'',
            )
          ).rows,
        ).toEqual([{ occurrenceId: root.id }]);
        const childId = randomUUID();
        await client.query(
          'INSERT INTO "node_occurrence" ("id","projectId","workflowRunId","nodeId","scopeKey") VALUES ($1,$2,\'run\',\'A\',\'opaque-child\')',
          [childId, projectId],
        );
        const insertAttempt = (occurrenceId: string, nodeId = 'A', attempt = 1) =>
          client.query(
            'INSERT INTO "node_run" ("id","projectId","workflowRunId","nodeId","occurrenceId","attempt") VALUES ($1,$2,\'run\',$3,$4,$5)',
            [randomUUID(), projectId, nodeId, occurrenceId, attempt],
          );
        await insertAttempt(childId);
        await expect(insertAttempt(childId)).rejects.toMatchObject({ code: '23505' });
        await expect(insertAttempt(childId, 'B', 2)).rejects.toMatchObject({ code: '23503' });
        await expect(insertAttempt(childId, 'A', 0)).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query('UPDATE "node_occurrence" SET "scopeKey"=\'changed\' WHERE "id"=$1', [
            root.id,
          ]),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query('UPDATE "node_run" SET "occurrenceId"=$1 WHERE "id"=$2', [childId, ids[0]]),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query('UPDATE "node_run" SET "attempt"=9 WHERE "id"=$1', [ids[0]]),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            'INSERT INTO "node_occurrence" ("id","projectId","workflowRunId","nodeId","scopeKey") VALUES ($1,$2,\'run\',\'A\',\'root\')',
            [randomUUID(), projectId],
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query(
            'INSERT INTO "node_occurrence" ("id","projectId","workflowRunId","nodeId","scopeKey") VALUES ($1,$2,\'run\',\'C\',\'\')',
            [randomUUID(), projectId],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await client.query('DELETE FROM "workflow_run" WHERE "id"=\'run\'');
        for (const table of ['node_occurrence', 'node_run', 'artifact'])
          expect(
            (await client.query(`SELECT count(*)::int AS count FROM "${table}"`)).rows,
          ).toEqual([{ count: 0 }]);
      } finally {
        // 仅删除本用例创建的随机 schema；不清空 public 或其他运行数据。
        await client.query('ROLLBACK');
        await client.query('SET search_path TO public');
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await client.end();
      }
    }, 30000);
  },
);
