// 仅由确认过持久化取消意图的执行宿主触发；不是 timeout / Provider error。
export class WorkflowExecutionCancelled extends Error {
  readonly code = 'WORKFLOW_EXECUTION_CANCELLED';
  constructor(readonly workflowRunId: string) {
    super('工作流执行已取消');
    this.name = 'WorkflowExecutionCancelled';
  }
}

export class CancellationRecordingError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, '取消生命周期记录不可用');
    this.name = 'CancellationRecordingError';
  }
}

export function executionCancellation(
  signal?: AbortSignal,
): WorkflowExecutionCancelled | undefined {
  return signal?.aborted && signal.reason instanceof WorkflowExecutionCancelled
    ? signal.reason
    : undefined;
}
export function throwIfExecutionCancelled(signal?: AbortSignal): void {
  const cancelled = executionCancellation(signal);
  if (cancelled) throw cancelled;
}

// 只跟踪已创建的审计记录及其取消写入，不等待/调度业务 Promise，不进入 State 或 checkpoint。
export class WorkflowExecutionCancellation {
  private finished = false;
  private readonly controller = new AbortController();
  private readonly owners = new Map<string, () => Promise<void>>();
  private readonly writes = new Set<Promise<void>>();
  private readonly registrations = new Set<Promise<void>>();
  private readonly errors: unknown[] = [];
  readonly signal = this.controller.signal;

  constructor(readonly workflowRunId: string) {}

  request(): void {
    if (this.finished || this.signal.aborted) return;
    this.controller.abort(new WorkflowExecutionCancelled(this.workflowRunId));
    for (const [key, cancel] of this.owners) this.cancelOwner(key, cancel);
  }

  // invocation 已完成 / 进入等待后，不再把后续持久化请求施加到已返回的调用。
  finish(): void {
    this.finished = true;
  }

  release(key: string): void {
    this.owners.delete(key);
  }

  private cancelOwner(key: string, cancel: () => Promise<void>): void {
    this.owners.delete(key);
    const write = Promise.resolve()
      .then(cancel)
      .catch((error: unknown) => {
        this.errors.push(error);
      });
    this.writes.add(write);
    void write.then(() => this.writes.delete(write));
  }

  async own<T>(
    create: () => Promise<T>,
    owner: (value: T) => { key: string; cancel(): Promise<void> },
  ): Promise<T> {
    throwIfExecutionCancelled(this.signal);
    if (this.finished) throw new Error('该执行调用已结束');
    let registered!: () => void;
    const registration = new Promise<void>((resolve) => {
      registered = resolve;
    });
    this.registrations.add(registration);
    try {
      const value = await create();
      const { key, cancel } = owner(value);
      if (this.signal.aborted) this.cancelOwner(key, cancel);
      else this.owners.set(key, cancel);
      throwIfExecutionCancelled(this.signal);
      return value;
    } catch (error) {
      // create 的提交结果不明时不能假定没有记录；保留 infrastructure 边界，不伪造已全部取消。
      if (!(error instanceof WorkflowExecutionCancelled)) this.errors.push(error);
      throw error;
    } finally {
      registered();
      this.registrations.delete(registration);
    }
  }

  async settle(): Promise<void> {
    // 覆盖 abort 时尚在提交的 create：提交后必须注册自己的收尾，不能留下 running 记录。
    while (this.registrations.size || this.writes.size)
      await Promise.all([...this.registrations, ...this.writes]);
    if (this.errors.length) throw new CancellationRecordingError([...this.errors]);
  }
}
