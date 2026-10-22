import {
  workflowRunResponseSchema,
  type StartWorkflowRunRequest,
  type WorkflowRunResponse,
} from '@dramaflow/contracts';
import { ApiError } from '../../../../lib/http';
import { InvocationReceiptStore, type InvocationReceipt } from './invocation-receipts';

export const terminalRun = (run: WorkflowRunResponse) =>
  ['completed', 'failed', 'cancelled'].includes(run.status);
export function receiptMatches(receipt: InvocationReceipt, run: WorkflowRunResponse) {
  return (
    receipt.workflowId === run.workflowId &&
    receipt.workflowVersionId === run.workflowVersionId &&
    receipt.invocationKey === run.invocationKey &&
    (!receipt.workflowRunId || receipt.workflowRunId === run.id)
  );
}
export interface RecoveryEntry {
  receipt: InvocationReceipt;
  phase: 'found' | 'unconfirmed' | 'conflict' | 'error';
  run: WorkflowRunResponse | null;
}
export interface InvocationRecoveryState {
  checking: boolean;
  entries: RecoveryEntry[];
  selected: WorkflowRunResponse | null;
  notice: string | null;
  storageError: boolean;
}
interface RecoveryOperations {
  lookup(workflowId: string, invocationKey: string): Promise<{ run: WorkflowRunResponse | null }>;
  start(request: StartWorkflowRunRequest): Promise<WorkflowRunResponse>;
}
export class InvocationRecoveryController {
  private state: InvocationRecoveryState = {
    checking: true,
    entries: [],
    selected: null,
    notice: null,
    storageError: false,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private uncertain = new Set<string>();
  private active = true;
  constructor(
    readonly store: InvocationReceiptStore,
    private operations: RecoveryOperations,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(change: Partial<InvocationRecoveryState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  stop() {
    this.active = false;
    this.generation++;
  }
  async refresh() {
    this.active = true;
    const generation = ++this.generation;
    this.update({ checking: true });
    try {
      const { receipts, corrupt } = this.store.list();
      const entries = await Promise.all(
        receipts.map(async (receipt): Promise<RecoveryEntry> => {
          try {
            const response = await this.operations.lookup(
              receipt.workflowId,
              receipt.invocationKey,
            );
            const run = response.run ? workflowRunResponseSchema.parse(response.run) : null;
            if (!run) return { receipt, phase: 'unconfirmed', run: null };
            if (!receiptMatches(receipt, run)) return { receipt, phase: 'conflict', run: null };
            return { receipt, phase: 'found', run };
          } catch {
            return { receipt, phase: 'error', run: null };
          }
        }),
      );
      if (!this.active || generation !== this.generation) return;
      const selected = this.state.selected ?? entries.find((entry) => entry.run)?.run ?? null;
      // 先让页面状态持有已确认身份，再清理终态 receipt。
      this.update({
        entries,
        selected,
        checking: false,
        storageError: false,
        notice: corrupt ? '部分本地恢复标识损坏，已忽略；此前请求可能仍在执行。' : null,
      });
      for (const entry of entries) if (entry.run) this.recordRun(entry.receipt, entry.run);
    } catch {
      if (this.active && generation === this.generation)
        this.update({
          checking: false,
          storageError: true,
          notice: '无法读取本地运行恢复标识，请检查浏览器存储设置后重试。',
        });
    }
  }
  select(key: string) {
    const run = this.state.entries.find((entry) => entry.receipt.invocationKey === key)?.run;
    if (run) this.update({ selected: run });
  }
  private recordRun(receipt: InvocationReceipt, run: WorkflowRunResponse) {
    try {
      if (terminalRun(run)) this.store.remove(receipt.invocationKey);
      else this.store.save({ ...receipt, workflowRunId: run.id });
    } catch {
      this.update({ notice: '运行身份已确认，但本地恢复信息更新失败；不会重新提交运行。' });
    }
  }
  observe(run: WorkflowRunResponse) {
    const entry = this.state.entries.find((item) => receiptMatches(item.receipt, run));
    if (!entry) return;
    this.update({
      entries: this.state.entries.map((item) =>
        item === entry ? { ...item, phase: 'found', run } : item,
      ),
      selected: this.state.selected?.id === run.id ? run : this.state.selected,
    });
    this.recordRun(entry.receipt, run);
  }
  async submit(request: StartWorkflowRunRequest): Promise<WorkflowRunResponse> {
    if (!this.active) throw new ApiError('当前登录上下文已失效，运行请求尚未发送', 400);
    let receipt: InvocationReceipt;
    let existed = false;
    try {
      const existing = this.store
        .list()
        .receipts.find((item) => item.invocationKey === request.invocationKey);
      existed = !!existing;
      receipt = existing ?? {
        projectId: this.store.scope.projectId,
        workflowId: this.store.scope.workflowId,
        workflowVersionId: request.workflowVersionId,
        invocationKey: request.invocationKey,
        createdAt: new Date().toISOString(),
      };
      this.store.save(receipt);
    } catch {
      throw new ApiError('无法保存运行恢复标识，因此运行请求尚未发送', 400);
    }
    this.update({
      selected: null,
      entries: [
        { receipt, phase: 'unconfirmed', run: null },
        ...this.state.entries.filter(
          (item) => item.receipt.invocationKey !== request.invocationKey,
        ),
      ],
    });
    try {
      const run = workflowRunResponseSchema.parse(await this.operations.start(request));
      if (!receiptMatches(receipt, run)) throw new ApiError('返回的运行身份与本次请求不匹配', 200);
      if (this.active) {
        this.update({
          selected: run,
          entries: this.state.entries.map((item) =>
            item.receipt.invocationKey === request.invocationKey
              ? { receipt, phase: 'found', run }
              : item,
          ),
        });
        this.recordRun(receipt, run);
      }
      return run;
    } catch (error) {
      const detail =
        error instanceof ApiError && error.details && typeof error.details === 'object'
          ? error.details
          : null;
      if (
        detail &&
        'code' in detail &&
        detail.code === 'WORKFLOW_QUEUE_UNAVAILABLE' &&
        (('invocationKey' in detail && detail.invocationKey !== request.invocationKey) ||
          (receipt.workflowRunId &&
            'workflowRunId' in detail &&
            receipt.workflowRunId !== detail.workflowRunId))
      ) {
        this.uncertain.add(request.invocationKey);
        throw new ApiError('运行响应身份冲突，请查询原运行请求', 200);
      }
      if (
        this.active &&
        detail &&
        'code' in detail &&
        detail.code === 'WORKFLOW_QUEUE_UNAVAILABLE' &&
        'workflowRunId' in detail &&
        typeof detail.workflowRunId === 'string' &&
        (!('invocationKey' in detail) || detail.invocationKey === request.invocationKey)
      ) {
        try {
          this.store.save({ ...receipt, workflowRunId: detail.workflowRunId });
        } catch {
          this.update({ notice: '本地恢复信息更新失败；原 invocation 标识仍保留，不会重新提交。' });
        }
      }
      const definite =
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        !(detail && 'workflowRunId' in detail);
      if (this.active && definite && !existed && !this.uncertain.has(request.invocationKey)) {
        try {
          this.store.remove(request.invocationKey);
          this.update({
            entries: this.state.entries.filter(
              (entry) => entry.receipt.invocationKey !== request.invocationKey,
            ),
          });
        } catch {
          this.update({ notice: '运行请求被拒绝，但本地恢复标识清理失败。' });
        }
      } else this.uncertain.add(request.invocationKey);
      throw error;
    }
  }
}
