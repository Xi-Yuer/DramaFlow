import { WorkflowRuntimeFactory } from '@dramaflow/server';
import type {
  ResumeWorkflowRunInput,
  StartWorkflowRunInput,
} from '@dramaflow/workflow';
import { Injectable } from '@nestjs/common';

@Injectable()
export class WorkflowRuntimeService {
  constructor(private readonly runtimes: WorkflowRuntimeFactory) {}

  async start(ownerId: string, input: StartWorkflowRunInput) {
    const runner = await this.runtimes.forProject(ownerId, input.projectId);
    return runner.start(input);
  }

  async resume(
    ownerId: string,
    projectId: string,
    input: ResumeWorkflowRunInput,
  ) {
    const runner = await this.runtimes.forProject(ownerId, projectId);
    return runner.resume(input);
  }
}
