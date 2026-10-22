import {
  createBindingResolver,
  DefaultNodeExecutor,
  DefaultWorkflowCompiler,
  DefaultWorkflowOutputResolver,
  DefaultWorkflowRunner,
  NodeRegistry,
  type WorkflowRunner,
} from '@dramaflow/workflow';
import { Injectable } from '@nestjs/common';
import { WorkflowCheckpointerService } from '../../checkpoint/workflow-checkpointer.service.js';
import { NodeRunRepositories } from './node-run-repository.js';
import { WorkflowRunRepositories } from '../workflow-run-repository.js';
import { WorkflowVersionRepositories } from '../workflow-version-repository.js';
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
  ): Promise<WorkflowRunner> {
    const versions = await this.versions.forProject(ownerId, projectId);
    const runs = await this.runs.forProject(ownerId, projectId, executionId);
    const compiler = new DefaultWorkflowCompiler(
      this.registry,
      async (run) =>
        new DefaultNodeExecutor(
          this.registry,
          this.bindings,
          await this.artifacts.forRun(ownerId, projectId, run.id),
          await this.nodeRuns.forRun(ownerId, projectId, run.id),
          this.capabilities.forRun(ownerId, projectId, run.id),
        ),
      this.checkpointer.saver,
    );
    return new DefaultWorkflowRunner(versions, runs, compiler, this.outputs);
  }
}
