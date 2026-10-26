import {
  executionTreeEntrySchema,
  executionTreeParentRefSchema,
  executionTreeResponseSchema,
  workflowIdentifierSchema,
  type ExecutionTreeParentRef,
  type ExecutionTreeEntry,
  type ExecutionTreeRun,
  type ExecutionTreeQuery,
  type ExecutionTreeResponse,
} from '@dramaflow/contracts';
import { z } from 'zod';

export type ChildRef = Exclude<ExecutionTreeParentRef, { type: 'workflow_run' }>;

// Source 必须限定一个已授权 Run；结构遍历不按 kind、业务值或存储类型分支。
export interface ExecutionTreeSource {
  get(ref: ChildRef): Promise<ExecutionTreeEntry | null>;
  children(
    parent: ExecutionTreeParentRef,
    page: { take: number; afterId?: string },
  ): Promise<ExecutionTreeEntry[]>;
}
export class ExecutionTreeQueryError extends Error {
  constructor(readonly code: 'PARENT_NOT_FOUND' | 'CURSOR_INVALID' | 'INCONSISTENT') {
    super('运行树查询无法完成');
    this.name = 'ExecutionTreeQueryError';
  }
}
const cursorSchema = z
  .object({
    version: z.literal(1),
    workflowRunId: workflowIdentifierSchema,
    parent: executionTreeParentRefSchema,
    lastId: workflowIdentifierSchema,
  })
  .strict();
const sameRef = (a: ExecutionTreeParentRef, b: ExecutionTreeParentRef) =>
  a.type === b.type && a.id === b.id;

function checkedEntry(raw: ExecutionTreeEntry): ExecutionTreeEntry {
  const parsed = executionTreeEntrySchema.safeParse(raw);
  if (!parsed.success) throw new ExecutionTreeQueryError('INCONSISTENT');
  return parsed.data;
}

// 单次读取沿持久化父引用核对到根；不会递归加载整树，也不为孤儿猜一个 root。
async function validateAncestry(
  source: ExecutionTreeSource,
  root: ExecutionTreeRun,
  parent: ExecutionTreeParentRef,
) {
  const seen = new Set<string>();
  let ref = parent;
  let first = true;
  while (ref.type !== 'workflow_run') {
    const key = JSON.stringify([ref.type, ref.id]);
    if (seen.has(key)) throw new ExecutionTreeQueryError('INCONSISTENT');
    seen.add(key);
    const raw = await source.get(ref);
    if (!raw) throw new ExecutionTreeQueryError(first ? 'PARENT_NOT_FOUND' : 'INCONSISTENT');
    const entry = checkedEntry(raw);
    if (!sameRef(entry, ref)) throw new ExecutionTreeQueryError('INCONSISTENT');
    ref = entry.parent;
    first = false;
  }
  if (ref.id !== root.id)
    throw new ExecutionTreeQueryError(first ? 'PARENT_NOT_FOUND' : 'INCONSISTENT');
}

export async function queryExecutionTree(
  source: ExecutionTreeSource,
  run: ExecutionTreeRun,
  query: ExecutionTreeQuery,
): Promise<ExecutionTreeResponse> {
  const parent: ExecutionTreeParentRef = { type: query.parentType, id: query.parentId ?? run.id };
  await validateAncestry(source, run, parent);
  let afterId: string | undefined;
  if (query.after !== undefined) {
    let cursor: z.infer<typeof cursorSchema>;
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.after, 'base64url').toString('utf8')),
      );
    } catch {
      throw new ExecutionTreeQueryError('CURSOR_INVALID');
    }
    if (cursor.workflowRunId !== run.id || !sameRef(cursor.parent, parent))
      throw new ExecutionTreeQueryError('CURSOR_INVALID');
    const type = parent.type === 'node_run' ? 'child_execution' : 'node_run';
    const raw = await source.get({ type, id: cursor.lastId });
    if (
      !raw ||
      !sameRef(checkedEntry(raw), { type, id: cursor.lastId }) ||
      !sameRef(checkedEntry(raw).parent, parent)
    )
      throw new ExecutionTreeQueryError('CURSOR_INVALID');
    afterId = cursor.lastId;
  }
  const rows = await source.children(parent, {
    take: query.limit + 1,
    ...(afterId ? { afterId } : {}),
  });
  if (rows.length > query.limit + 1) throw new ExecutionTreeQueryError('INCONSISTENT');
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = checkedEntry(raw);
    const key = JSON.stringify([row.type, row.id]);
    if (!sameRef(row.parent, parent) || seen.has(key))
      throw new ExecutionTreeQueryError('INCONSISTENT');
    seen.add(key);
  }
  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > query.limit && last
      ? Buffer.from(
          JSON.stringify({ version: 1, workflowRunId: run.id, parent, lastId: last.id }),
        ).toString('base64url')
      : null;
  return executionTreeResponseSchema.parse({ run, parent, items, nextCursor });
}
