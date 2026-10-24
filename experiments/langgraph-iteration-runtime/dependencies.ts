import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 仅复用当前 workspace 已安装的公开包入口；本实验不安装或升级依赖。
export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const experimentRoot = fileURLToPath(new URL('./', import.meta.url));
const workflowRequire = createRequire(
  new URL('../../packages/workflow/package.json', import.meta.url),
);
const serverRequire = createRequire(new URL('../../packages/server/package.json', import.meta.url));

function packageEntry(require: NodeJS.Require, name: string, expected: string) {
  const path = require.resolve(`${name}/package.json`);
  const metadata: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('version' in metadata) ||
    !('main' in metadata)
  )
    throw new Error(`包元数据不完整：${name}`);
  if (metadata.version !== expected || typeof metadata.main !== 'string')
    throw new Error(`依赖版本不符合实验锁定值：${name}`);
  return pathToFileURL(resolve(dirname(path), metadata.main)).href;
}

export const versions = {
  node: process.version,
  langgraph: '1.5.0',
  checkpoint: '1.2.0',
  postgresSaver: '1.1.0',
};
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('实验要求 Node 24');
packageEntry(serverRequire, '@langchain/langgraph-checkpoint', versions.checkpoint);
export const { Annotation, StateGraph, Send, START, END, Command, interrupt, MemorySaver } =
  (await import(
    packageEntry(workflowRequire, '@langchain/langgraph', versions.langgraph)
  )) as typeof import('@langchain/langgraph');
export const { PostgresSaver } = (await import(
  packageEntry(serverRequire, '@langchain/langgraph-checkpoint-postgres', versions.postgresSaver)
)) as typeof import('@langchain/langgraph-checkpoint-postgres');
export const pg = serverRequire('pg') as typeof import('pg');
export const { z } = (await import(
  packageEntry(workflowRequire, 'zod', '4.6.7')
)) as typeof import('zod');
export type {
  LangGraphRunnableConfig,
  StateSnapshot,
  BaseCheckpointSaver,
} from '@langchain/langgraph';

export const databaseName = 'dramaflow_iteration_experiment';
export function databaseUrl(): string {
  const url = new URL(
    process.env.DRAMAFLOW_RUNTIME_EXPERIMENT_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
  );
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !['postgres:', 'postgresql:'].includes(url.protocol)
  )
    throw new Error('实验仅连接本机 PostgreSQL');
  if (process.env.DRAMAFLOW_RUNTIME_EXPERIMENT_DATABASE_URL && url.pathname !== `/${databaseName}`)
    throw new Error('实验连接必须使用独立实验数据库');
  if (!process.env.DRAMAFLOW_RUNTIME_EXPERIMENT_DATABASE_URL && url.pathname !== '/dramaflow')
    throw new Error('仅允许从已核对的本地 DramaFlow 开发库派生实验连接');
  url.pathname = `/${databaseName}`;
  return url.href;
}

export function openSaver() {
  // 与正式服务相同的官方 PostgresSaver + pg.Pool + langgraph schema 路径。
  const pool = new pg.Pool({
    connectionString: databaseUrl(),
    application_name: 'dramaflow-iteration-runtime-experiment',
    max: 10,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
  });
  return new PostgresSaver(pool, undefined, { schema: 'langgraph' });
}
