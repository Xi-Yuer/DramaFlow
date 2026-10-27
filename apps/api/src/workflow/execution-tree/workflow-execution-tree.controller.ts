import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { WorkflowExecutionTreeService } from '@dramaflow/server';
import { Actor } from '../../auth/auth.guard.js';
import type { AuthActor } from '../../auth/auth.service.js';

@Controller('workflow-runs')
export class WorkflowExecutionTreeController {
  constructor(private readonly trees: WorkflowExecutionTreeService) {}

  @Get(':runId/execution-tree')
  @Header('Cache-Control', 'no-store')
  query(@Actor() actor: AuthActor, @Param('runId') runId: string, @Query() query: unknown) {
    return this.trees.query(actor.user.id, runId, query);
  }
}
