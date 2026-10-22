import { z } from 'zod';
import { workflowIdentifierSchema, workflowInvocationKeySchema } from '@dramaflow/contracts';

export const invocationReceiptSchema = z
  .object({
    projectId: workflowIdentifierSchema,
    workflowId: workflowIdentifierSchema,
    workflowVersionId: workflowIdentifierSchema,
    invocationKey: workflowInvocationKeySchema,
    workflowRunId: workflowIdentifierSchema.optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type InvocationReceipt = z.infer<typeof invocationReceiptSchema>;
export interface InvocationScope {
  userId: string;
  projectId: string;
  workflowId: string;
}
const prefix = 'dramaflow:invocation:v1:';
const userGenerations = new Map<string, number>();
const encode = encodeURIComponent;
export const receiptUserPrefix = (userId: string) => `${prefix}${encode(userId)}:`;
const logoutKey = (userId: string) => `${receiptUserPrefix(userId)}logout`;
export const receiptScopePrefix = (scope: InvocationScope) =>
  `${receiptUserPrefix(scope.userId)}${encode(scope.projectId)}:${encode(scope.workflowId)}:`;
export const receiptStorageKey = (scope: InvocationScope, key: string) =>
  `${receiptScopePrefix(scope)}${encode(key)}`;
export class InvocationReceiptError extends Error {
  constructor() {
    super('无法保存运行恢复标识，因此运行请求尚未发送');
  }
}

export class InvocationReceiptStore {
  private epoch: string | null | undefined;
  private readonly generation: number;
  constructor(
    readonly scope: InvocationScope,
    private readonly storage: () => Storage,
  ) {
    this.generation = userGenerations.get(scope.userId) ?? 0;
  }
  private access() {
    if (this.generation !== (userGenerations.get(this.scope.userId) ?? 0))
      throw new InvocationReceiptError();
    const storage = this.storage();
    const epoch = storage.getItem(logoutKey(this.scope.userId));
    if (this.epoch === undefined) this.epoch = epoch;
    if (epoch !== this.epoch) throw new InvocationReceiptError();
    return storage;
  }
  list(): { receipts: InvocationReceipt[]; corrupt: boolean } {
    const storage = this.access();
    const receipts: InvocationReceipt[] = [];
    let corrupt = false;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(receiptScopePrefix(this.scope))) continue;
      try {
        const receipt = invocationReceiptSchema.parse(JSON.parse(storage.getItem(key)!));
        if (
          receipt.projectId !== this.scope.projectId ||
          receipt.workflowId !== this.scope.workflowId ||
          key !== receiptStorageKey(this.scope, receipt.invocationKey)
        )
          throw new Error('scope');
        receipts.push(receipt);
      } catch {
        corrupt = true;
      }
    }
    return { receipts: receipts.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), corrupt };
  }
  save(input: InvocationReceipt) {
    try {
      const receipt = invocationReceiptSchema.parse(input);
      if (
        receipt.projectId !== this.scope.projectId ||
        receipt.workflowId !== this.scope.workflowId
      )
        throw new Error('scope');
      this.access().setItem(
        receiptStorageKey(this.scope, receipt.invocationKey),
        JSON.stringify(receipt),
      );
    } catch {
      throw new InvocationReceiptError();
    }
  }
  remove(key: string) {
    this.access().removeItem(receiptStorageKey(this.scope, key));
  }
  relevant(key: string | null) {
    return (
      key === null ||
      key === logoutKey(this.scope.userId) ||
      key.startsWith(receiptScopePrefix(this.scope))
    );
  }
}

export function clearUserInvocationReceipts(userId: string, target: Storage | (() => Storage)) {
  userGenerations.set(userId, (userGenerations.get(userId) ?? 0) + 1);
  const storage = typeof target === 'function' ? target() : target;
  // 先使其他 Tab / 旧请求持有的 Store 失效，再删除本用户记录；不清理其他用户。
  storage.setItem(logoutKey(userId), crypto.randomUUID());
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys)
    if (key?.startsWith(receiptUserPrefix(userId)) && key !== logoutKey(userId))
      storage.removeItem(key);
}
