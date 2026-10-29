import { Body, Controller, Header, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { WorkflowRunCancellationService } from '@dramaflow/server';
import { Actor } from '../../auth/auth.guard.js';
import type { AuthActor } from '../../auth/auth.service.js';

@Controller('projects/:projectId/workflows/:workflowId/runs')
export class WorkflowRunCancellationController {
  constructor(
    @Inject(WorkflowRunCancellationService)
    private readonly cancellations: WorkflowRunCancellationService,
  ) {}
  @Post(':runId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('workflowId') workflowId: string,
    @Param('runId') runId: string,
    @Body() body: unknown,
  ) {
    return this.cancellations.cancel(actor.user.id, projectId, workflowId, runId, body);
  }
}
