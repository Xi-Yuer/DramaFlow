import { z } from 'zod';
import { workflowVersionSummarySchema, type WorkflowVersionResponse } from '@dramaflow/contracts';
import { ApiError } from '../../../lib/http';

export type PublishedWorkflowVersion = z.infer<typeof workflowVersionSummarySchema>;
export interface WorkflowPublicationStatus {
  latest: PublishedWorkflowVersion | null;
  current: PublishedWorkflowVersion | null;
}
export interface WorkflowPublishTarget {
  workflowId: string;
  revision: number;
}
export interface WorkflowPublishError {
  message: string;
  status: number;
  code?: string;
  requestId?: string;
  issues: {
    code?: string;
    nodeId?: string;
    portKey?: string;
    message?: string;
    path?: (string | number)[];
  }[];
}

const issueSchema = z.object({
  message: z.string().optional(),
  code: z.string().optional(),
  nodeId: z.string().optional(),
  portKey: z.string().optional(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
});
const errorSchema = z.object({
  code: z.string().optional(),
  requestId: z.string().optional(),
  nodeId: z.string().optional(),
  portKey: z.string().optional(),
  details: z.array(issueSchema).optional(),
});

const publishIssueMessages = new Map([
  [
    'IF_TOPOLOGY_UNSUPPORTED',
    '当前仅支持 true / false 分别连接不同的末端操作节点；暂不支持分支后续连接、汇合或嵌套条件。分支输入须来自条件节点已完成的上游。',
  ],
  [
    'CONDITIONAL_WORKFLOW_OUTPUT_UNSUPPORTED',
    '条件分支最终输出须使用同一 If 的 true / false 两个末端节点作为候选来源；单来源输出须来自必定执行的节点。',
  ],
  ['NODE_EXECUTION_KIND_UNSUPPORTED', '当前暂不支持运行此类节点，请调整工作流后再发布。'],
  ['CONTROL_OUTPUT_PORT_REQUIRED', '请从条件节点的 true / false 出口连接分支。'],
  ['CONTROL_OUTPUT_BRANCH_MISSING', '请为条件节点连接 true 和 false 两个分支。'],
]);

export function workflowPublishErrorDescription(error: WorkflowPublishError): string {
  const issue = error.issues.find((item) => item.code && publishIssueMessages.has(item.code));
  const message = publishIssueMessages.get(issue?.code ?? error.code ?? '');
  if (message) return `${message}${issue?.nodeId ? `（节点：${issue.nodeId}）` : ''}`;
  return `${error.message}${error.issues[0]?.message ? `：${error.issues[0].message}` : ''}${error.code ? `（${error.code}）` : ''}`;
}

export function workflowPublishError(error: unknown): WorkflowPublishError {
  const parsed = errorSchema.safeParse(error instanceof ApiError ? error.details : undefined);
  return {
    message: error instanceof Error ? error.message : '发布结果未确认，请核对已发布版本后重试',
    status: error instanceof ApiError ? error.status : 0,
    ...(parsed.success ? { code: parsed.data.code, requestId: parsed.data.requestId } : {}),
    issues: parsed.success
      ? (parsed.data.details ??
        (parsed.data.nodeId || parsed.data.portKey
          ? [{ nodeId: parsed.data.nodeId, portKey: parsed.data.portKey }]
          : []))
      : [],
  };
}

export function workflowPublicationForRevision(
  revision: number,
  listed: WorkflowPublicationStatus | undefined,
  confirmed: PublishedWorkflowVersion | null,
): WorkflowPublicationStatus {
  const latest = listed?.latest ?? null;
  return {
    latest: confirmed && (!latest || confirmed.version > latest.version) ? confirmed : latest,
    current:
      listed?.current?.sourceRevision === revision
        ? listed.current
        : confirmed?.sourceRevision === revision
          ? confirmed
          : null,
  };
}

export interface WorkflowPublishState {
  publishing: boolean;
  publishedVersion: PublishedWorkflowVersion | null;
  error: WorkflowPublishError | null;
  refreshError: WorkflowPublishError | null;
}
interface PublishOperations {
  begin(): WorkflowPublishTarget | null;
  end(): void;
  conflict(message: string): void;
  publish(target: WorkflowPublishTarget): Promise<WorkflowVersionResponse>;
  refresh(target: WorkflowPublishTarget): Promise<WorkflowPublicationStatus>;
}

// 仅管理本次 Editor 的发布操作；不保存或改写 Draft，也不选择未来 Run 的版本。
export class WorkflowPublisher {
  private state: WorkflowPublishState = {
    publishing: false,
    publishedVersion: null,
    error: null,
    refreshError: null,
  };
  private readonly listeners = new Set<() => void>();
  constructor(private readonly operations: PublishOperations) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(change: Partial<WorkflowPublishState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  clearRefreshError = () => {
    if (this.state.refreshError) this.update({ refreshError: null });
  };

  async publish(): Promise<void> {
    if (this.state.publishing) return;
    const target = this.operations.begin();
    if (!target) return;
    this.update({ publishing: true, error: null, refreshError: null });
    try {
      let version: PublishedWorkflowVersion;
      let recovered = false;
      try {
        const result = await this.operations.publish(target);
        version = workflowVersionSummarySchema.parse({
          id: result.id,
          workflowId: result.workflowId,
          projectId: result.projectId,
          version: result.version,
          sourceRevision: result.sourceRevision,
          publishedAt: result.publishedAt,
        });
      } catch (error) {
        const failure = workflowPublishError(error);
        if (failure.code !== 'WORKFLOW_REVISION_ALREADY_PUBLISHED') throw error;
        const status = await this.operations.refresh(target);
        if (!status.current)
          throw new ApiError('该修订已发布，但尚未找回对应版本，请刷新版本状态后重试', 409, {
            code: 'WORKFLOW_PUBLISHED_VERSION_UNCONFIRMED',
          });
        version = status.current;
        recovered = true;
      }
      if (version.workflowId !== target.workflowId || version.sourceRevision !== target.revision)
        throw new ApiError('返回版本与本次发布修订不匹配，请核对版本状态', 200);
      this.update({ publishedVersion: version });
      if (!recovered) {
        try {
          await this.operations.refresh(target);
        } catch (error) {
          this.update({ refreshError: workflowPublishError(error) });
        }
      }
    } catch (error) {
      const failure = workflowPublishError(error);
      if (failure.code === 'WORKFLOW_REVISION_CONFLICT') this.operations.conflict(failure.message);
      this.update({ error: failure });
    } finally {
      this.operations.end();
      this.update({ publishing: false });
    }
  }
}
