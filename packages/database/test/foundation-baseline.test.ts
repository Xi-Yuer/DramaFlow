import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const enabled = process.env.DRAMAFLOW_INTEGRATION === '1';
const execute = promisify(execFile);
const baseline = '20261030000000_foundation_v1_baseline';
const videoMigration = '20261030032909_video_identity';
const invocationMigration = '20261030062304_product_workflow_invocations';
const databaseName = `dramaflow_test_baseline_${randomUUID().replaceAll('-', '')}`;
const cwd = new URL('..', import.meta.url).pathname;
let admin: pg.Client;
let db: pg.Client;
let created = false;
let target: URL;

async function rejected(sql: string, values: unknown[] = [], code = '23514') {
  await db.query('SAVEPOINT rejected_statement');
  try {
    await expect(db.query(sql, values)).rejects.toMatchObject({ code });
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT rejected_statement');
    await db.query('RELEASE SAVEPOINT rejected_statement');
  }
}
async function fixture() {
  const user = randomUUID(),
    project = randomUUID(),
    workflow = randomUUID(),
    version = randomUUID();
  await db.query(
    'INSERT INTO auth_user (id,name,email,"updatedAt") VALUES ($1,\'test\',$2,now())',
    [user, `${user}@example.test`],
  );
  await db.query(
    'INSERT INTO canvas_project (id,"ownerId",name,viewport,"updatedAt") VALUES ($1,$2,\'test\',\'{}\',now())',
    [project, user],
  );
  await db.query(
    'INSERT INTO workflow (id,"projectId",name,draft,"updatedAt") VALUES ($1,$2,\'test\',\'{}\',now())',
    [workflow, project],
  );
  await db.query(
    'INSERT INTO workflow_version (id,"workflowId",version,"sourceRevision",definition) VALUES ($1,$2,1,1,\'{}\')',
    [version, workflow],
  );
  async function run() {
    const id = randomUUID();
    await db.query(
      'INSERT INTO workflow_run (id,"projectId","workflowId","workflowVersionId","invocationKey","threadId",inputs) VALUES ($1,$2,$3,$4,$1,$1,\'{}\')',
      [id, project, workflow, version],
    );
    return id;
  }
  return { user, project, workflow, version, run: await run(), newRun: run };
}
async function occurrence(project: string, run: string, node: string, scope = 'root') {
  const id = randomUUID();
  await db.query(
    'INSERT INTO node_occurrence (id,"projectId","workflowRunId","nodeId","scopeKey") VALUES ($1,$2,$3,$4,$5)',
    [id, project, run, node, scope],
  );
  return id;
}
async function nodeRun(
  project: string,
  run: string,
  node: string,
  occurrenceId: string,
  child: string | null = null,
) {
  const id = randomUUID();
  await db.query(
    'INSERT INTO node_run (id,"projectId","workflowRunId","nodeId","occurrenceId","childExecutionId",attempt) VALUES ($1,$2,$3,$4,$5,$6,1)',
    [id, project, run, node, occurrenceId, child],
  );
  return id;
}

describe.skipIf(!enabled)('Foundation v1 空数据库基线', () => {
  beforeAll(async () => {
    const source = new URL(process.env.DATABASE_URL ?? '');
    if (
      !['localhost', '127.0.0.1'].includes(source.hostname) ||
      source.pathname !== '/dramaflow_test'
    )
      throw Error('仅允许本机 dramaflow_test 发起独立空库测试');
    admin = new pg.Client({ connectionString: source.href });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    target = new URL(source);
    target.pathname = `/${databaseName}`;
    await execute('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd,
      env: { ...process.env, DATABASE_URL: target.href },
    });
    db = new pg.Client({ connectionString: target.href });
    await db.connect();
  }, 60000);
  beforeEach(async () => {
    await db.query('BEGIN');
  });
  afterEach(async () => {
    await db?.query('ROLLBACK');
  });
  afterAll(async () => {
    try {
      await db?.end();
      if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    } finally {
      await admin?.end();
    }
  });

  it('正式 deploy 从空库建立完整迁移序列，ORM schema 无漂移且不预建官方 checkpoint', async () => {
    expect(
      (
        await db.query(
          'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name',
        )
      ).rows,
    ).toEqual([
      { migration_name: baseline },
      { migration_name: videoMigration },
      { migration_name: invocationMigration },
    ]);
    expect(
      (await db.query("SELECT count(*)::int AS count FROM pg_namespace WHERE nspname='langgraph'"))
        .rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (await db.query("SELECT extname FROM pg_extension WHERE extname='vector'")).rows,
    ).toEqual([{ extname: 'vector' }]);
    await execute(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      { cwd, env: { ...process.env, DATABASE_URL: target.href } },
    );
  }, 30000);

  it('完整核对 tables / columns / defaults / nullability / enums / indexes / FK / CHECK / triggers / functions', async () => {
    const expected: unknown = JSON.parse(
      readFileSync(new URL('./fixtures/foundation-catalog.json', import.meta.url), 'utf8'),
    );
    const queries: Record<string, string> = JSON.parse(
      readFileSync(new URL('./fixtures/foundation-catalog-queries.json', import.meta.url), 'utf8'),
    );
    const actual: Record<string, unknown> = {};
    for (const [key, sql] of Object.entries(queries))
      actual[key] = (await db.query<Record<string, unknown>>(sql)).rows;
    expect(actual).toEqual(expected);
  });

  it('Video 基础生命周期、名称、修订与 Project 外键受保护，项目删除级联且不影响其他项目', async () => {
    const first = await fixture(),
      other = await fixture();
    const id = randomUUID(),
      otherId = randomUUID();
    await db.query(
      'INSERT INTO video (id,"projectId",name,"updatedAt") VALUES ($1,$2,\'作品\',now()),($3,$4,\'其他作品\',now())',
      [id, first.project, otherId, other.project],
    );
    expect((await db.query('SELECT status,revision FROM video WHERE id=$1', [id])).rows).toEqual([
      { status: 'draft', revision: 1 },
    ]);
    await rejected("UPDATE video SET status='rendering' WHERE id=$1", [id]);
    await rejected('UPDATE video SET revision=0 WHERE id=$1', [id]);
    await rejected("UPDATE video SET name='   ' WHERE id=$1", [id]);
    await rejected(
      'INSERT INTO video (id,"projectId",name,"updatedAt") VALUES ($1,$2,\'无项目\',now())',
      [randomUUID(), randomUUID()],
      '23503',
    );
    await db.query("UPDATE video SET status='active',revision=2 WHERE id=$1", [id]);
    await db.query('DELETE FROM canvas_project WHERE id=$1', [first.project]);
    expect((await db.query('SELECT id FROM video ORDER BY id')).rows).toEqual([{ id: otherId }]);
  });

  it('产品来源受理后不可改挂或单独删除，Video 删除保留快照，Project 删除级联', async () => {
    const first = await fixture(),
      other = await fixture();
    const video = randomUUID(),
      foreignVideo = randomUUID(),
      id = randomUUID();
    await db.query(
      'INSERT INTO video (id,"projectId",name,"updatedAt") VALUES ($1,$2,\'原始作品\',now()),($3,$4,\'其他作品\',now())',
      [video, first.project, foreignVideo, other.project],
    );
    const insert =
      'INSERT INTO product_workflow_invocation (id,"projectId","sourceVideoId","sourceVideoName","workflowRunId","invocationKey") VALUES ($1,$2,$3,\'原始作品\',$4,$5)';
    await rejected(
      insert,
      [randomUUID(), first.project, foreignVideo, first.run, first.run],
      '23503',
    );
    await rejected(insert, [randomUUID(), first.project, video, first.run, 'wrong-key']);
    await rejected(insert, [randomUUID(), other.project, foreignVideo, first.run, first.run]);
    await db.query(insert, [id, first.project, video, first.run, first.run]);
    await rejected(insert, [randomUUID(), first.project, video, first.run, first.run], '23505');
    await rejected('UPDATE product_workflow_invocation SET "sourceVideoId"=$2 WHERE id=$1', [
      id,
      foreignVideo,
    ]);
    await rejected(
      'UPDATE product_workflow_invocation SET "sourceVideoName"=\'改写历史\' WHERE id=$1',
      [id],
    );
    await rejected('DELETE FROM product_workflow_invocation WHERE id=$1', [id]);
    await db.query('DELETE FROM video WHERE id=$1', [video]);
    expect(
      (
        await db.query(
          'SELECT "sourceVideoId","sourceVideoName","workflowRunId" FROM product_workflow_invocation WHERE id=$1',
          [id],
        )
      ).rows,
    ).toEqual([{ sourceVideoId: video, sourceVideoName: '原始作品', workflowRunId: first.run }]);
    expect((await db.query('SELECT id FROM workflow_run WHERE id=$1', [first.run])).rowCount).toBe(
      1,
    );
    await db.query('DELETE FROM canvas_project WHERE id=$1', [first.project]);
    expect(
      (await db.query('SELECT id FROM product_workflow_invocation WHERE id=$1', [id])).rowCount,
    ).toBe(0);
  });

  it('版本不可变、Run 身份 / 生命周期 / 首次取消意图与 waitingRevision 由数据库保护', async () => {
    const f = await fixture();
    await rejected('UPDATE workflow_version SET definition=\'{"changed":true}\' WHERE id=$1', [
      f.version,
    ]);
    await rejected('UPDATE workflow_run SET "invocationKey"=\'other\' WHERE id=$1', [f.run]);
    await rejected(
      "UPDATE workflow_run SET status='completed',outputs='{}',\"completedAt\"=now() WHERE id=$1",
      [f.run],
    );
    await db.query('UPDATE workflow_run SET "cancellationRequestedAt"=now() WHERE id=$1', [f.run]);
    await rejected(
      'UPDATE workflow_run SET "cancellationRequestedAt"=now()+interval \'1 second\' WHERE id=$1',
      [f.run],
    );
    await db.query('UPDATE workflow_run SET status=\'cancelled\',"completedAt"=now() WHERE id=$1', [
      f.run,
    ]);
    expect(
      (await db.query('SELECT "startedAt" FROM workflow_run WHERE id=$1', [f.run])).rows[0],
    ).toEqual({ startedAt: null });
    await rejected('UPDATE workflow_run SET inputs=\'{"changed":1}\' WHERE id=$1', [f.run]);
    const run = await f.newRun();
    await db.query('UPDATE workflow_run SET status=\'running\',"startedAt"=now() WHERE id=$1', [
      run,
    ]);
    await db.query("UPDATE workflow_run SET status='waiting' WHERE id=$1", [run]);
    expect(
      (await db.query('SELECT "waitingRevision" FROM workflow_run WHERE id=$1', [run])).rows[0],
    ).toEqual({ waitingRevision: 1 });
    await rejected('UPDATE workflow_run SET "waitingRevision"=2 WHERE id=$1', [run]);
    await db.query("UPDATE workflow_run SET status='running' WHERE id=$1", [run]);
    await db.query(
      "UPDATE workflow_run SET status='completed',outputs='{}',\"completedAt\"=now() WHERE id=$1",
      [run],
    );
    await rejected(
      'UPDATE workflow_run SET status=\'running\',outputs=NULL,"completedAt"=NULL WHERE id=$1',
      [run],
    );
  });

  it('Occurrence / NodeRun / ChildExecution 的身份、父链、scope、attempt、typed index 与终态均受保护', async () => {
    const f = await fixture(),
      root = await occurrence(f.project, f.run, 'parent');
    const parent = await nodeRun(f.project, f.run, 'parent', root),
      child = randomUUID();
    await rejected('UPDATE node_occurrence SET "scopeKey"=\'changed\' WHERE id=$1', [root]);
    await db.query(
      'INSERT INTO child_execution (id,"projectId","workflowRunId","parentNodeRunId","parentNodeId","scopeKey",index,kind,"invocationKey",metadata) VALUES ($1,$2,$3,$4,\'parent\',\'child\',0,\'iteration_item\',\'iteration-item:0\',\'{"index":0}\')',
      [child, f.project, f.run, parent],
    );
    await rejected('UPDATE child_execution SET metadata=\'{"index":1}\' WHERE id=$1', [child]);
    await rejected(
      'INSERT INTO child_execution (id,"projectId","workflowRunId","parentNodeRunId","parentNodeId","scopeKey",index,kind,"invocationKey",metadata) VALUES ($1,$2,$3,$4,\'parent\',\'other\',1,\'iteration_item\',\'iteration-item:1\',\'{"index":2}\')',
      [randomUUID(), f.project, f.run, parent],
    );
    await rejected(
      'INSERT INTO child_execution (id,"projectId","workflowRunId","parentNodeRunId","parentNodeId","scopeKey",kind,"invocationKey",metadata) VALUES ($1,$2,$3,$4,\'parent\',\'other\',\'subworkflow\',\'iteration-item:0\',\'{}\')',
      [randomUUID(), f.project, f.run, parent],
      '23505',
    );
    const bodyOccurrence = await occurrence(f.project, f.run, 'body', 'child');
    await rejected(
      'INSERT INTO node_run (id,"projectId","workflowRunId","nodeId","occurrenceId",attempt) VALUES ($1,$2,$3,\'body\',$4,1)',
      [randomUUID(), f.project, f.run, bodyOccurrence],
    );
    const body = await nodeRun(f.project, f.run, 'body', bodyOccurrence, child);
    await rejected('UPDATE node_run SET attempt=2 WHERE id=$1', [body]);
    await rejected(
      'INSERT INTO node_run (id,"projectId","workflowRunId","nodeId","occurrenceId","childExecutionId",attempt) VALUES ($1,$2,$3,\'body\',$4,$5,0)',
      [randomUUID(), f.project, f.run, bodyOccurrence, child],
    );
    const foreign = await fixture();
    await rejected(
      'INSERT INTO node_occurrence (id,"projectId","workflowRunId","nodeId","scopeKey") VALUES ($1,$2,$3,\'x\',\'root\')',
      [randomUUID(), foreign.project, f.run],
      '23503',
    );
    await db.query('UPDATE node_run SET status=\'cancelled\',"completedAt"=now() WHERE id=$1', [
      body,
    ]);
    await rejected('UPDATE node_run SET status=\'running\',"completedAt"=NULL WHERE id=$1', [body]);
    await db.query(
      'UPDATE child_execution SET status=\'cancelled\',"completedAt"=now() WHERE id=$1',
      [child],
    );
    await rejected('UPDATE child_execution SET status=\'running\',"completedAt"=NULL WHERE id=$1', [
      child,
    ]);
  });

  it('Artifact 内容身份、写入状态、唯一存储 key 与项目级联有效', async () => {
    const f = await fixture(),
      id = randomUUID();
    await db.query(
      'INSERT INTO artifact (id,"projectId","workflowRunId","nodeId","outputKey",type,"contentKind","storageKey","mimeType",size,checksum) VALUES ($1,$2,$3,\'node\',\'out\',\'{}\',\'json\',$4,\'application/json\',1,\'test\')',
      [id, f.project, f.run, id],
    );
    await rejected('UPDATE artifact SET "storageKey"=\'changed\' WHERE id=$1', [id]);
    await rejected("UPDATE artifact SET status='ready' WHERE id=$1", [id]);
    await db.query('UPDATE artifact SET status=\'ready\',"completedAt"=now() WHERE id=$1', [id]);
    await rejected("UPDATE artifact SET status='failed',\"failureStage\"='upload' WHERE id=$1", [
      id,
    ]);
    await db.query('DELETE FROM canvas_project WHERE id=$1', [f.project]);
    for (const table of ['workflow', 'workflow_run', 'artifact'])
      expect((await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows).toEqual([
        { count: 0 },
      ]);
    expect((await db.query('SELECT count(*)::int AS count FROM workflow_version')).rows).toEqual([
      { count: 0 },
    ]);
  });

  it('Provider / Model 的 owner 复合 FK 与不可变绑定有效，启停 / 凭证轮换仍允许', async () => {
    const f = await fixture(),
      other = await fixture(),
      provider = randomUUID(),
      model = randomUUID();
    await db.query(
      'INSERT INTO model_provider (id,"ownerId",name,"pluginId","pluginVersion",configuration,"encryptedCredentials") VALUES ($1,$2,\'test\',\'test\',1,\'{}\',\'encrypted\')',
      [provider, f.user],
    );
    await rejected('UPDATE model_provider SET configuration=\'{"changed":true}\' WHERE id=$1', [
      provider,
    ]);
    await db.query(
      'UPDATE model_provider SET enabled=false,"encryptedCredentials"=\'rotated\' WHERE id=$1',
      [provider],
    );
    await rejected(
      "INSERT INTO model_configuration (id,\"ownerId\",\"providerId\",capability,model,settings) VALUES ($1,$2,$3,'text.generate','test','{}')",
      [model, other.user, provider],
      '23503',
    );
    await db.query(
      "INSERT INTO model_configuration (id,\"ownerId\",\"providerId\",capability,model,settings) VALUES ($1,$2,$3,'text.generate','test','{}')",
      [model, f.user, provider],
    );
    await rejected('UPDATE model_configuration SET settings=\'{"changed":1}\' WHERE id=$1', [
      model,
    ]);
    await db.query('UPDATE model_configuration SET enabled=false WHERE id=$1', [model]);
    await db.query('DELETE FROM canvas_project WHERE id=$1', [f.project]);
    expect((await db.query('SELECT count(*)::int AS count FROM model_configuration')).rows).toEqual(
      [{ count: 1 }],
    );
    await db.query('DELETE FROM auth_user WHERE id=$1', [f.user]);
    expect((await db.query('SELECT count(*)::int AS count FROM model_configuration')).rows).toEqual(
      [{ count: 0 }],
    );
  });

  it('Outbox payload 身份、周期去重与 immutable intent 有效', async () => {
    const f = await fixture(),
      id = randomUUID(),
      payload = { kind: 'start', workflowRunId: f.run };
    await db.query(
      'INSERT INTO workflow_execution_outbox (id,kind,"workflowRunId",payload) VALUES ($1,\'start\',$2,$3)',
      [id, f.run, payload],
    );
    await rejected("UPDATE workflow_execution_outbox SET payload='{}' WHERE id=$1", [id]);
    await rejected(
      'INSERT INTO workflow_execution_outbox (id,kind,"workflowRunId",payload) VALUES ($1,\'start\',$2,$3)',
      [randomUUID(), f.run, payload],
      '23505',
    );
    await rejected(
      'INSERT INTO workflow_execution_outbox (id,kind,"workflowRunId","waitingRevision",payload) VALUES ($1,\'resume\',$2,1,\'{}\')',
      [randomUUID(), f.run],
    );
    await db.query(
      'UPDATE workflow_execution_outbox SET status=\'cancelled\',"completedAt"=now() WHERE id=$1',
      [id],
    );
  });
});
