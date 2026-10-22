import type { WorkflowRunResponse } from '@dramaflow/contracts';
import { ApiError } from '../../../../lib/http';
import type { WorkflowRunState } from '../workflow-run';

const POLL_INTERVAL_MS = 2_000;

export interface WorkflowRunStatusError {
  message: string;
  status: number;
}

export interface WorkflowRunStatusState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  runId: string | null;
  run: WorkflowRunResponse | null;
  error: WorkflowRunStatusError | null;
  refreshing: boolean;
}

interface WorkflowRunStatusOperations {
  get(runId: string, signal: AbortSignal): Promise<WorkflowRunResponse>;
}

function statusError(error: unknown): WorkflowRunStatusError {
  return {
    message: error instanceof Error ? error.message : '运行状态读取失败',
    status: error instanceof ApiError ? error.status : 0,
  };
}

function continuesPolling(run: WorkflowRunResponse): boolean {
  return run.status === 'pending' || run.status === 'running';
}

export function workflowRunTrackingId(state: WorkflowRunState): string | null {
  if (state.phase === 'accepted' && state.accepted) return state.accepted.id;
  if (state.phase === 'error' && state.error?.workflowRunId) return state.error.workflowRunId;
  return null;
}

export class WorkflowRunStatusController {
  private state: WorkflowRunStatusState = {
    phase: 'idle',
    runId: null,
    run: null,
    error: null,
    refreshing: false,
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
    if (!runId) {
      this.update({
        phase: 'idle',
        runId: null,
        run: null,
        error: null,
        refreshing: false,
      });
      return;
    }
    this.update({
      phase: 'loading',
      runId,
      run: null,
      error: null,
      refreshing: true,
    });
    void this.load(runId, this.targetGeneration);
  }

  stop(runId: string): void {
    if (this.state.runId !== runId) return;
    this.cancelActive();
    this.targetGeneration++;
    this.update({
      phase: 'idle',
      runId: null,
      run: null,
      error: null,
      refreshing: false,
    });
  }

  async refresh(): Promise<void> {
    if (!this.state.runId) return;
    await this.load(this.state.runId, this.targetGeneration);
  }

  private cancelActive() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.request?.abort();
    this.request = null;
  }

  private async load(runId: string, targetGeneration: number): Promise<void> {
    if (this.state.runId !== runId || this.targetGeneration !== targetGeneration) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const requestGeneration = ++this.requestGeneration;
    this.update({
      ...(this.state.run ? {} : { phase: 'loading' as const }),
      error: null,
      refreshing: true,
    });
    try {
      const run = await this.operations.get(runId, request.signal);
      if (
        request.signal.aborted ||
        this.state.runId !== runId ||
        this.targetGeneration !== targetGeneration ||
        this.requestGeneration !== requestGeneration
      )
        return;
      if (run.id !== runId) throw new ApiError('返回的运行身份与查询目标不匹配', 200);
      this.request = null;
      this.update({
        phase: 'ready',
        run,
        error: null,
        refreshing: false,
      });
      if (continuesPolling(run)) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.load(runId, targetGeneration);
        }, POLL_INTERVAL_MS);
      }
    } catch (error) {
      if (
        request.signal.aborted ||
        this.state.runId !== runId ||
        this.targetGeneration !== targetGeneration ||
        this.requestGeneration !== requestGeneration
      )
        return;
      this.request = null;
      this.update({
        phase: 'error',
        error: statusError(error),
        refreshing: false,
      });
    }
  }
}
