import type {
  CancelWorkflowRunResponse,
  NodeRun,
  PendingHumanReview,
  PendingHumanReviewsResponse,
  ResumeWorkflowRunRequest,
  WorkflowRunResponse,
} from '@dramaflow/contracts';
import { ApiError } from '../../../../lib/http';
import type { WorkflowRunState } from '../workflow-run';

const POLL_INTERVAL_MS = 2_000;

export interface WorkflowRunStatusError {
  message: string;
  status: number;
}

export interface HumanReviewState {
  phase: 'ready' | 'submitting' | 'reconciling';
  item: PendingHumanReview;
  feedback: string;
  notice: string | null;
}

export interface HumanReviewActions {
  onFeedback: (identity: PendingHumanReview, feedback: string) => void;
  onDecision: (identity: PendingHumanReview, action: 'approve' | 'reject') => void;
}

export interface WorkflowRunStatusState {
  cancelSubmitting?: boolean;
  cancelNotice?: string | null;
  phase: 'idle' | 'loading' | 'ready' | 'error';
  runId: string | null;
  run: WorkflowRunResponse | null;
  nodeRuns?: readonly NodeRun[];
  error: WorkflowRunStatusError | null;
  refreshing: boolean;
  review: HumanReviewState | null;
}

interface WorkflowRunStatusOperations {
  cancel?(runId: string): Promise<CancelWorkflowRunResponse>;
  get(runId: string, signal: AbortSignal): Promise<WorkflowRunResponse>;
  getPending(runId: string, signal: AbortSignal): Promise<PendingHumanReviewsResponse>;
  getNodeRuns?(runId: string, signal: AbortSignal): Promise<{ items: NodeRun[] }>;
  resume(runId: string, input: ResumeWorkflowRunRequest): Promise<WorkflowRunResponse>;
}

function statusError(error: unknown): WorkflowRunStatusError {
  return {
    message: error instanceof Error ? error.message : '运行状态读取失败',
    status: error instanceof ApiError ? error.status : 0,
  };
}

function sameReview(a: PendingHumanReview, b: PendingHumanReview) {
  return a.interruptId === b.interruptId && a.waitingRevision === b.waitingRevision;
}

export function workflowRunTrackingId(state: WorkflowRunState): string | null {
  if (state.phase === 'accepted' && state.accepted) return state.accepted.id;
  if (state.phase === 'error' && state.error?.workflowRunId) return state.error.workflowRunId;
  return null;
}

export function canCancelWorkflowRun(state: WorkflowRunStatusState): boolean {
  return (
    state.phase === 'ready' &&
    !state.refreshing &&
    !state.cancelSubmitting &&
    state.review?.phase !== 'submitting' &&
    !!state.run &&
    ['pending', 'running', 'waiting'].includes(state.run.status) &&
    !state.run.cancellationRequestedAt &&
    (!state.run.cancellation || state.run.cancellation === 'none')
  );
}

export class WorkflowRunStatusController {
  private state: WorkflowRunStatusState = {
    phase: 'idle',
    runId: null,
    run: null,
    nodeRuns: [],
    error: null,
    refreshing: false,
    review: null,
  };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private request: AbortController | null = null;
  private targetGeneration = 0;
  private requestGeneration = 0;

  constructor(private readonly operations: WorkflowRunStatusOperations) {}

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(change: Partial<WorkflowRunStatusState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  watch(runId: string | null): void {
    if (runId === this.state.runId) return;
    this.cancelActive();
    this.targetGeneration++;
    this.update({
      phase: runId ? 'loading' : 'idle',
      cancelSubmitting: false,
      cancelNotice: null,
      runId,
      run: null,
      nodeRuns: [],
      error: null,
      refreshing: !!runId,
      review: null,
    });
    if (runId) void this.load(runId, this.targetGeneration);
  }

  stop(runId: string): void {
    if (this.state.runId === runId) this.watch(null);
  }

  async refresh(): Promise<void> {
    if (
      !this.state.runId ||
      this.state.review?.phase === 'submitting' ||
      this.state.cancelSubmitting
    )
      return;
    await this.load(this.state.runId, this.targetGeneration);
  }

  setFeedback(identity: PendingHumanReview, feedback: string): void {
    const review = this.state.review;
    if (!review || !sameReview(review.item, identity) || !this.canSubmit()) return;
    this.update({ review: { ...review, feedback } });
  }

  private canSubmit() {
    return (
      this.state.phase === 'ready' &&
      !this.state.refreshing &&
      !this.state.cancelSubmitting &&
      !this.state.run?.cancellationRequestedAt &&
      (!this.state.run?.cancellation || this.state.run.cancellation === 'none') &&
      this.state.run?.status === 'waiting' &&
      this.state.review?.phase === 'ready' &&
      this.state.review.item.submissionStatus === 'pending'
    );
  }

  async cancel(expectedRunId: string): Promise<void> {
    if (
      this.state.runId !== expectedRunId ||
      !canCancelWorkflowRun(this.state) ||
      !this.operations.cancel
    )
      return;
    const generation = this.targetGeneration;
    const workflowId = this.state.run!.workflowId;
    const isCurrent = () =>
      generation === this.targetGeneration && this.state.runId === expectedRunId;
    this.cancelActive();
    this.update({ cancelSubmitting: true, cancelNotice: null, error: null });
    let notice: string | null = null;
    try {
      const result = await this.operations.cancel(expectedRunId);
      if (!isCurrent()) return;
      if (result.run.id !== expectedRunId || result.run.workflowId !== workflowId)
        throw new ApiError('取消响应与当前运行不匹配', 200);
      this.update({ run: result.run, review: null });
    } catch {
      notice = '取消请求结果尚未确认，已重新查询运行状态；请核对后再操作。';
    }
    if (!isCurrent()) return;
    this.update({ cancelSubmitting: false, cancelNotice: notice });
    // 无论 POST 是否丢失响应，都只 GET 对账；不重放取消或创建另一套 timer。
    await this.load(expectedRunId, generation);
  }

  async submit(identity: PendingHumanReview, action: 'approve' | 'reject'): Promise<void> {
    const { runId, review } = this.state;
    if (!runId || !review || !sameReview(review.item, identity) || !this.canSubmit()) return;
    const generation = this.targetGeneration;
    this.cancelActive();
    this.update({ review: { ...review, phase: 'submitting', notice: null } });
    let notice: string | null = null;
    try {
      // 不自动重放 POST；即使响应丢失，后续也只查询服务端事实。
      await this.operations.resume(runId, {
        interruptId: review.item.interruptId,
        expectedWaitingRevision: review.item.waitingRevision,
        value: { action, ...(review.feedback ? { feedback: review.feedback } : {}) },
      });
    } catch (error) {
      notice =
        error instanceof ApiError && error.status === 409
          ? '审批状态已变化，已重新读取当前审批，请核对后操作。'
          : '未能确认审批提交结果，已重新查询服务器状态；请核对当前审批后再操作。';
    }
    if (generation !== this.targetGeneration || this.state.runId !== runId) return;
    this.update({ review: { ...review, phase: 'reconciling', notice } });
    await this.load(runId, generation, notice);
  }

  private cancelActive() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.request?.abort();
    this.request = null;
  }

  private async load(
    runId: string,
    targetGeneration: number,
    notice: string | null = null,
  ): Promise<void> {
    if (this.state.runId !== runId || this.targetGeneration !== targetGeneration) return;
    this.cancelActive();
    const request = new AbortController();
    this.request = request;
    const requestGeneration = ++this.requestGeneration;
    const isCurrent = () =>
      !request.signal.aborted &&
      this.state.runId === runId &&
      this.targetGeneration === targetGeneration &&
      this.requestGeneration === requestGeneration;
    this.update({
      ...(this.state.run ? {} : { phase: 'loading' as const }),
      error: null,
      refreshing: true,
    });
    try {
      const run = await this.operations.get(runId, request.signal);
      if (!isCurrent()) return;
      if (run.id !== runId) throw new ApiError('返回的运行身份与查询目标不匹配', 200);
      const waitingForReview =
        run.status === 'waiting' &&
        !run.cancellationRequestedAt &&
        (!run.cancellation || run.cancellation === 'none');
      const cancellationKnown =
        !!run.cancellationRequestedAt ||
        run.cancellation === 'requested' ||
        run.cancellation === 'uncertain' ||
        ['completed', 'failed', 'cancelled'].includes(run.status);
      this.update({
        run,
        review: waitingForReview ? this.state.review : null,
        ...(cancellationKnown ? { cancelNotice: null } : {}),
      });
      let nodeRuns: readonly NodeRun[] = this.state.nodeRuns ?? [];
      let review: HumanReviewState | null = null;
      if (this.operations.getNodeRuns || waitingForReview) {
        const [nodeRunsResult, pending] = await Promise.all([
          this.operations.getNodeRuns
            ? this.operations.getNodeRuns(runId, request.signal)
            : Promise.resolve(null),
          waitingForReview
            ? this.operations.getPending(runId, request.signal)
            : Promise.resolve(null),
        ]);
        if (!isCurrent()) return;
        if (nodeRunsResult) {
          if (nodeRunsResult.items.some((item) => item.workflowRunId !== runId)) {
            throw new ApiError('返回的节点运行记录与查询目标不匹配', 200);
          }
          nodeRuns = nodeRunsResult.items;
        }
        if (pending) {
          if (pending.items.length > 1)
            throw new ApiError('当前暂不支持同时处理多个待审批节点', 200);
          const item = pending.items[0];
          if (item) {
            const previous = this.state.review;
            review = {
              phase: 'ready',
              item,
              feedback: previous && sameReview(previous.item, item) ? previous.feedback : '',
              notice,
            };
          }
        }
      }
      this.request = null;
      this.update({ phase: 'ready', run, nodeRuns, review, error: null, refreshing: false });
      // 普通待审批不频繁查询；已提交或状态切换间隙沿用同一 Run timer 跟踪。
      if (
        run.status === 'pending' ||
        run.status === 'running' ||
        (run.status === 'waiting' && (!review || review.item.submissionStatus === 'submitted'))
      ) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.load(runId, targetGeneration);
        }, POLL_INTERVAL_MS);
      }
    } catch (error) {
      if (!isCurrent()) return;
      this.request = null;
      // 查询失败后撤下旧审批，避免旧 token/revision 继续可提交。
      this.update({ phase: 'error', error: statusError(error), refreshing: false, review: null });
    }
  }
}
