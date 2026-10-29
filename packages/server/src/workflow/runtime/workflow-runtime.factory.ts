import {
  createBindingResolver,
  DefaultNodeExecutor,
  DefaultWorkflowCompiler,
  DefaultWorkflowOutputResolver,
  DefaultWorkflowRunner,
  NodeRegistry,
  type WorkflowRunner,
  type WorkflowExecutionCancellation,
} from '@dramaflow/workflow';
import { Injectable } from '@nestjs/common';
import { WorkflowCheckpointerService } from '../../checkpoint/workflow-checkpointer.service.js';
import { NodeRunRepositories } from './execution/node-run-repository.js';
import { WorkflowRunRepositories } from '../run/repository/workflow-run-repository.js';
import { WorkflowVersionRepositories } from '../run/repository/workflow-version-repository.js';
import { ArtifactRuntimeFactory } from '../../artifacts/artifact-runtime.factory.js';
import { WorkflowCapabilitiesFactory } from '../../models/workflow-capabilities.factory.js';

// API / Worker 复用构造逻辑，作用域仍由调用方显式提供，不缓存跨用户 Runner。
@Injectable()
export class WorkflowRuntimeFactory {
  private readonly bindings = createBindingResolver();

  constructor(
    private readonly versions: WorkflowVersionRepositories,
    private readonly runs: WorkflowRunRepositories,
    private readonly nodeRuns: NodeRunRepositories,
    private readonly registry: NodeRegistry,
    private readonly artifacts: ArtifactRuntimeFactory,
    private readonly capabilities: WorkflowCapabilitiesFactory,
    private readonly outputs: DefaultWorkflowOutputResolver,
    private readonly checkpointer: WorkflowCheckpointerService,
  ) {}

  async forProject(
    ownerId: string,
    projectId: string,
    executionId?: string,
    cancellation?: WorkflowExecutionCancellation,
  ): Promise<WorkflowRunner> {
    const versions = await this.versions.forProject(ownerId, projectId);
    const runs = await this.runs.forProject(ownerId, projectId, executionId);
    const compiler = new DefaultWorkflowCompiler(
      this.registry,
      async (run, valueServices) =>
        new DefaultNodeExecutor(
          this.registry,
          this.bindings,
          valueServices?.codec ?? (await this.artifacts.forRun(ownerId, projectId, run.id)),
          await this.nodeRuns.forRun(ownerId, projectId, run.id, cancellation),
          this.capabilities.forRun(ownerId, projectId, run.id),
        ),
      this.checkpointer.saver,
      async (run) => ({
        bindings: this.bindings,
        codec: await this.artifacts.forRun(ownerId, projectId, run.id),
      }),
      async (run) => this.nodeRuns.forRun(ownerId, projectId, run.id, cancellation),
      async (run) => this.nodeRuns.forRun(ownerId, projectId, run.id, cancellation),
      async (run) => this.nodeRuns.forRun(ownerId, projectId, run.id, cancellation),
    );
    return new DefaultWorkflowRunner(versions, runs, compiler, this.outputs, cancellation);
  }
}
