import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
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

  @Post(':runId/resume')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  resume(
    @Actor() actor: AuthActor,
    @Param('runId') runId: string,
    @Body() body: unknown,
  ) {
    return this.runtime.resumeRun(actor.user.id, runId, body);
  }
}
