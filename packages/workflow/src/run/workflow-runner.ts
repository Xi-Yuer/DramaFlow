import {
  runtimeValueMapSchema,
  workflowIdentifierSchema,
  workflowRunSchema,
  type RuntimeValue,
  type WorkflowRun,
  type WorkflowRunError,
} from '@dramaflow/contracts';
import { isGraphBubbleUp, isInterrupted } from '@langchain/langgraph';
import { z } from 'zod';
import type { CompiledWorkflow, WorkflowCompiler } from '../compiler/workflow-compiler.js';
import { createWorkflowDefinitionSnapshot } from '../definition/version.js';
import { workflowStateSchema, type WorkflowState } from '../runtime/state.js';
import { createWorkflowRunConfig } from './config.js';
import type { WorkflowOutputResolver } from './workflow-output-resolver.js';
import type { WorkflowRunRepository } from './workflow-run-repository.js';
import {
  workflowVersionRecordSchema,
  type WorkflowVersionRepository,
} from './workflow-version-repository.js';

const startInputSchema = z
  .object({
    projectId: workflowIdentifierSchema,
    workflowId: workflowIdentifierSchema,
    workflowVersionId: workflowIdentifierSchema,
    inputs: runtimeValueMapSchema,
  })
  .strict();
export type StartWorkflowRunInput = z.infer<typeof startInputSchema>;

export type StartWorkflowRunResult = {
  readonly workflowRunId: string;
  readonly threadId: string;
} & (
  | { readonly status: 'waiting' }
  | { readonly status: 'completed'; readonly outputs: Record<string, RuntimeValue> }
);

export interface WorkflowRunner {
  start(input: StartWorkflowRunInput): Promise<StartWorkflowRunResult>;
}

const failureCodes = {
  compile: 'WORKFLOW_COMPILATION_FAILED',
  invoke: 'WORKFLOW_EXECUTION_FAILED',
  inspect_state: 'WORKFLOW_STATE_INSPECTION_FAILED',
  resolve_output: 'WORKFLOW_OUTPUT_RESOLUTION_FAILED',
} as const;
type WorkflowRunStage = keyof typeof failureCodes;

// 记录稳定摘要，不把 Node cause、供应商错误或访问 URL 复制进整图记录。
function toWorkflowRunError(stage: WorkflowRunStage): WorkflowRunError {
  return { stage, code: failureCodes[stage], message: `工作流在 ${stage} 阶段失败` };
}

export class WorkflowRunRecordingError extends AggregateError {
  constructor(
    public readonly workflowRunId: string,
    cause: unknown,
    public readonly recordingError: unknown,
  ) {
    super([cause, recordingError], '工作流失败，且失败记录写入也失败', { cause });
    this.name = 'WorkflowRunRecordingError';
  }
}

export class DefaultWorkflowRunner implements WorkflowRunner {
  constructor(
    private readonly versions: WorkflowVersionRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly compiler: WorkflowCompiler,
    private readonly outputResolver: WorkflowOutputResolver,
  ) {}

  async start(input: StartWorkflowRunInput): Promise<StartWorkflowRunResult> {
    const request = startInputSchema.parse(input);
    const loaded = workflowVersionRecordSchema.parse(
      await this.versions.getVersion(request.workflowVersionId),
    );
    const version = Object.freeze({
      ...loaded,
      definition: createWorkflowDefinitionSnapshot(loaded.definition),
    });
    if (
      version.id !== request.workflowVersionId ||
      version.workflowId !== request.workflowId ||
      version.projectId !== request.projectId
    )
      throw new Error('工作流版本与请求的项目 / 工作流不匹配');

    // create 返回的 RuntimeValue 输入快照及 thread 是本次执行身份的唯一来源。
    const run = Object.freeze(workflowRunSchema.parse(await this.runs.create(request)));
    if (
      run.projectId !== request.projectId ||
      run.workflowId !== version.workflowId ||
      run.workflowVersionId !== version.id ||
      run.status !== 'pending'
    )
      throw new Error('新建运行与已加载版本不匹配或不是 pending');
    const config = createWorkflowRunConfig(run, {
      id: version.id,
      workflowId: version.workflowId,
      version: version.version,
      publishedAt: version.publishedAt,
    });
    let graph: CompiledWorkflow;
    try {
      graph = await this.compiler.compile(version.definition, run);
    } catch (error) {
      if (error !== null && isGraphBubbleUp(error)) throw error;
      // 编译发生在 pending；失败也按既定 pending → running → failed 路径记录，不增加非法转换。
      try {
        await this.runs.markRunning(run.id);
      } catch (recordingError) {
        throw new WorkflowRunRecordingError(run.id, error, recordingError);
      }
      return this.fail(run, 'compile', error);
    }

    await this.runs.markRunning(run.id);
    const initialState: WorkflowState = {
      run: {
        projectId: run.projectId,
        workflowId: run.workflowId,
        workflowRunId: run.id,
        workflowVersionId: run.workflowVersionId,
      },
      inputs: structuredClone(run.inputs),
      outputs: {},
      variables: {},
      execution: {},
    };
    let stage: WorkflowRunStage = 'invoke';
    let outputs: Record<string, RuntimeValue> | undefined;
    let waiting: boolean;
    try {
      const result = await graph.invoke(initialState, config);
      stage = 'inspect_state';
      const snapshot = await graph.getState(config);
      if (snapshot.tasks.some((task) => task.error !== undefined))
        throw new Error('Graph checkpoint 存在未解决的任务错误');
      const state = workflowStateSchema.parse(snapshot.values);
      if (
        state.run.workflowRunId !== run.id ||
        state.run.projectId !== run.projectId ||
        state.run.workflowId !== run.workflowId ||
        state.run.workflowVersionId !== run.workflowVersionId ||
        snapshot.config.configurable?.thread_id !== run.threadId
      )
        throw new Error('Graph checkpoint 与本次运行身份不匹配');
      waiting = isInterrupted(result) || snapshot.next.length > 0 || snapshot.tasks.length > 0;
      if (!waiting) {
        stage = 'resolve_output';
        outputs = runtimeValueMapSchema.parse(
          this.outputResolver.resolve(version.definition, state),
        );
      }
    } catch (error) {
      return this.fail(run, stage, error);
    }

    // 记录服务自身失败原样上抛，不反向 markFailed；成功确认后才向调用方返回结果。
    if (waiting) {
      await this.runs.markWaiting(run.id);
      return { workflowRunId: run.id, threadId: run.threadId, status: 'waiting' };
    }
    if (outputs === undefined) throw new Error('工作流最终输出未解析');
    await this.runs.markCompleted(run.id, outputs);
    return { workflowRunId: run.id, threadId: run.threadId, status: 'completed', outputs };
  }

  private async fail(run: WorkflowRun, stage: WorkflowRunStage, error: unknown): Promise<never> {
    if (error !== null && isGraphBubbleUp(error)) throw error;
    try {
      await this.runs.markFailed(run.id, toWorkflowRunError(stage));
    } catch (recordingError) {
      throw new WorkflowRunRecordingError(run.id, error, recordingError);
    }
    throw error;
  }
}
