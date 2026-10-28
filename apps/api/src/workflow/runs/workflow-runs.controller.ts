import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Actor } from '../../auth/auth.guard.js';
import type { AuthActor } from '../../auth/auth.service.js';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';

@Controller('workflow-runs')
export class WorkflowRunsController {
  constructor(private readonly runtime: WorkflowRuntimeService) {}

  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  start(@Actor() actor: AuthActor, @Body() body: unknown) {
    return this.runtime.startVersion(actor.user.id, body);
  }

  @Get(':runId')
  @Header('Cache-Control', 'no-store')
  get(@Actor() actor: AuthActor, @Param('runId') runId: string) {
    return this.runtime.getRun(actor.user.id, runId);
  }

  @Get('by-invocation/:workflowId/:invocationKey')
  @Header('Cache-Control', 'no-store')
  lookup(
    @Actor() actor: AuthActor,
    @Param('workflowId') workflowId: string,
    @Param('invocationKey') invocationKey: string,
  ) {
    return this.runtime.lookupInvocation(actor.user.id, workflowId, invocationKey);
  }

  @Get(':runId/pending-human-reviews')
  @Header('Cache-Control', 'no-store')
  pending(@Actor() actor: AuthActor, @Param('runId') runId: string) {
    return this.runtime.pendingHumanReviews(actor.user.id, runId);
  }

  @Get(':runId/node-runs')
  @Header('Cache-Control', 'no-store')
  nodeRuns(@Actor() actor: AuthActor, @Param('runId') runId: string) {
    return this.runtime.listNodeRuns(actor.user.id, runId);
  }

  @Post(':runId/resume')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  resume(@Actor() actor: AuthActor, @Param('runId') runId: string, @Body() body: unknown) {
    return this.runtime.resumeRun(actor.user.id, runId, body);
  }
}

@Controller('projects/:projectId/workflows/:workflowId/runs')
export class WorkflowRunHistoryController {
  constructor(@Inject(WorkflowRuntimeService) private readonly runtime: WorkflowRuntimeService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('workflowId') workflowId: string,
    @Query() query: unknown,
  ) {
    return this.runtime.listRuns(actor.user.id, projectId, workflowId, query);
  }
}
