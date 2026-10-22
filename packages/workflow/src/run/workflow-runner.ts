import {
  runtimeValueMapSchema,
  workflowIdentifierSchema,
  workflowRunSchema,
  type WorkflowDefinition,
  type RuntimeValue,
  type WorkflowRun,
  type WorkflowRunError,
} from '@dramaflow/contracts';
import { Command, isGraphBubbleUp, isInterrupted, type StateSnapshot } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import type {
  CompiledWorkflow,
  WorkflowCompiler,
  WorkflowResumeCommand,
} from '../compiler/workflow-compiler.js';
import { workflowStateSchema, type WorkflowState } from '../runtime/state.js';
import { createWorkflowRunConfig } from './config.js';
import type { WorkflowOutputResolver } from './workflow-output-resolver.js';
import type { WorkflowRunRepository } from './workflow-run-repository.js';
import { WorkflowRunNotPendingError, WorkflowRunNotWaitingError } from './workflow-run-error.js';
import type { ResumeWorkflowRunInput } from './submission/workflow-run-submission.js';
import {
  loadWorkflowVersion,
  type WorkflowVersionRecord,
  type WorkflowVersionRepository,
} from './workflow-version-repository.js';

const resumeInputSchema = z
  .object({
    workflowRunId: workflowIdentifierSchema,
    value: z.unknown().refine((value) => value !== undefined, '必须提供恢复值'),
  })
  .strict();

export type StartWorkflowRunResult = {
  readonly workflowRunId: string;
  readonly threadId: string;
} & (
  | { readonly status: 'waiting' }
  | { readonly status: 'completed'; readonly outputs: Record<string, RuntimeValue> }
);
export type ResumeWorkflowRunResult = StartWorkflowRunResult;

export interface WorkflowRunner {
  executeStart(workflowRunId: string): Promise<StartWorkflowRunResult>;
  executeResume(input: ResumeWorkflowRunInput): Promise<ResumeWorkflowRunResult>;
}

const failureCodes = {
  load_version: 'WORKFLOW_VERSION_LOAD_FAILED',
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

  async executeStart(workflowRunId: string): Promise<StartWorkflowRunResult> {
    const id = workflowIdentifierSchema.parse(workflowRunId);
    const expected = await this.runs.getById(id);
    if (!expected || expected.status !== 'pending') throw new WorkflowRunNotPendingError(id);
    const claimed = await this.runs.claimPendingForStart(id);
    if (!claimed) throw new WorkflowRunNotPendingError(id);
    const run = Object.freeze(workflowRunSchema.parse(claimed));
    this.assertClaim(run, expected, id);
    const { version, graph } = await this.prepare(run);
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
    return this.invoke(run, version, graph, initialState);
  }

  async executeResume(input: ResumeWorkflowRunInput): Promise<ResumeWorkflowRunResult> {
    const request = resumeInputSchema.parse(input);
    const expected = await this.runs.getById(request.workflowRunId);
    if (!expected || expected.status !== 'waiting')
      throw new WorkflowRunNotWaitingError(request.workflowRunId);
    const claimed = await this.runs.claimWaitingForResume(request.workflowRunId);
    if (!claimed) throw new WorkflowRunNotWaitingError(request.workflowRunId);
    const run = Object.freeze(workflowRunSchema.parse(claimed));
    this.assertClaim(run, expected, request.workflowRunId);
    const { version, graph } = await this.prepare(run);
    return this.invoke(
      run,
      version,
      graph,
      new Command<unknown, never, never>({ resume: request.value }),
    );
  }

  private assertClaim(run: WorkflowRun, expected: WorkflowRun, id: string): void {
    if (
      run.status !== 'running' ||
      run.id !== id ||
      run.id !== expected.id ||
      run.projectId !== expected.projectId ||
      run.workflowId !== expected.workflowId ||
      run.workflowVersionId !== expected.workflowVersionId ||
      run.threadId !== expected.threadId
    )
      throw new Error('抢占运行与原执行身份不匹配');
  }

  private async prepare(
    run: WorkflowRun,
  ): Promise<{ version: WorkflowVersionRecord; graph: CompiledWorkflow }> {
    let stage: WorkflowRunStage = 'load_version';
    try {
      const version = await loadWorkflowVersion(this.versions, run);
      stage = 'compile';
      const graph = await this.compiler.compile(version.definition, run);
      return { version, graph };
    } catch (error) {
      return this.fail(run, stage, error);
    }
  }

  private checkpointState(run: WorkflowRun, snapshot: StateSnapshot): WorkflowState {
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
    return state;
  }

  private async invoke(
    run: WorkflowRun,
    version: WorkflowVersionRecord,
    graph: CompiledWorkflow,
    input: WorkflowState | WorkflowResumeCommand,
  ): Promise<StartWorkflowRunResult> {
    const config = createWorkflowRunConfig(run, {
      id: version.id,
      workflowId: version.workflowId,
      version: version.version,
      publishedAt: version.publishedAt,
    });
    let invocation = input;
    if (input instanceof Command) {
      try {
        const snapshot = await graph.getState(config);
        this.checkpointState(run, snapshot);
        if (snapshot.next.length === 0 && snapshot.tasks.length === 0)
          throw new Error('原 Graph checkpoint 没有待恢复任务');
        const interrupts = snapshot.tasks.flatMap((task) => task.interrupts);
        // LangGraph 1.5.0 的直接 resume 值使用 truthy 检查；原生 ID map 可无损传递 false / 0 / null 等值。
        // 单个 pending interrupt 的 value 仍是不透明业务数据，不把其对象键误当作原生 resume map。
        if (interrupts.length === 1 && interrupts[0]?.id) {
          invocation = new Command<unknown, never, never>({
            resume: { [interrupts[0].id]: input.resume },
          });
        }
      } catch (error) {
        return this.fail(run, 'inspect_state', error);
      }
    }
    let result: unknown;
    try {
      result = await graph.invoke(invocation, config);
    } catch (error) {
      return this.fail(run, 'invoke', error);
    }
    return this.handleExecutionResult(run, version.definition, graph, result, config);
  }

  private async handleExecutionResult(
    run: WorkflowRun,
    definition: WorkflowDefinition,
    graph: CompiledWorkflow,
    result: unknown,
    config: RunnableConfig,
  ): Promise<StartWorkflowRunResult> {
    let stage: WorkflowRunStage = 'inspect_state';
    let outputs: Record<string, RuntimeValue> | undefined;
    let waiting: boolean;
    try {
      const snapshot = await graph.getState(config);
      const state = this.checkpointState(run, snapshot);
      waiting = isInterrupted(result) || snapshot.next.length > 0 || snapshot.tasks.length > 0;
      if (!waiting) {
        stage = 'resolve_output';
        outputs = runtimeValueMapSchema.parse(this.outputResolver.resolve(definition, state));
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
