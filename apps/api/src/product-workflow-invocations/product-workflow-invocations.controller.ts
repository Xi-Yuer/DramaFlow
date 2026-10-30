import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Actor } from '../auth/auth.guard.js';
import type { AuthActor } from '../auth/auth.service.js';
import { ProductWorkflowInvocationsService } from './product-workflow-invocations.service.js';

@Controller('projects/:projectId/videos/:videoId/workflow-invocations')
export class VideoWorkflowInvocationsController {
  constructor(private readonly invocations: ProductWorkflowInvocationsService) {}
  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  start(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('videoId') videoId: string,
    @Body() body: unknown,
  ) {
    return this.invocations.start(actor.user.id, projectId, videoId, body);
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('videoId') videoId: string,
    @Query() query: unknown,
  ) {
    return this.invocations.listForVideo(actor.user.id, projectId, videoId, query);
  }
}

@Controller('projects/:projectId/workflow-invocations')
export class ProductWorkflowInvocationsController {
  constructor(private readonly invocations: ProductWorkflowInvocationsService) {}
  @Get('by-key/:key')
  @Header('Cache-Control', 'no-store')
  lookup(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('key') key: string,
  ) {
    return this.invocations.lookup(actor.user.id, projectId, key);
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@Actor() actor: AuthActor, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.invocations.get(actor.user.id, projectId, id);
  }
}
