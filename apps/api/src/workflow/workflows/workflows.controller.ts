import {
  initializeProjectWorkflowRequestSchema,
  saveWorkflowDraftRequestSchema,
  saveWorkflowDraftResponseSchema,
  publishWorkflowRequestSchema,
  workflowVersionResponseSchema,
} from '@dramaflow/contracts';
import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { Actor } from '../../auth/auth.guard.js';
import type { AuthActor } from '../../auth/auth.service.js';
import { WorkflowService } from './workflow.service.js';

@Controller('projects/:projectId/workflow')
export class ProjectWorkflowsController {
  constructor(private readonly workflows: WorkflowService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Actor() actor: AuthActor, @Param('projectId') projectId: string) {
    return this.workflows.getForProject(actor.user.id, projectId);
  }

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  initialize(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    initializeProjectWorkflowRequestSchema.parse(body);
    return this.workflows.initializeForProject(actor.user.id, projectId);
  }
}

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowService) {}

  @Post(':workflowId/publish')
  @Header('Cache-Control', 'no-store')
  async publish(
    @Actor() actor: AuthActor,
    @Param('workflowId') workflowId: string,
    @Body() body: unknown,
  ) {
    const request = publishWorkflowRequestSchema.parse(body);
    return workflowVersionResponseSchema.parse(
      await this.workflows.publish(actor.user.id, { ...request, workflowId }),
    );
  }

  @Get(':workflowId/versions')
  @Header('Cache-Control', 'no-store')
  listVersions(
    @Actor() actor: AuthActor,
    @Param('workflowId') workflowId: string,
    @Query() query: unknown,
  ) {
    return this.workflows.listVersions(actor.user.id, workflowId, query);
  }

  @Put(':workflowId/draft')
  @Header('Cache-Control', 'no-store')
  async saveDraft(
    @Actor() actor: AuthActor,
    @Param('workflowId') workflowId: string,
    @Body() body: unknown,
  ) {
    const request = saveWorkflowDraftRequestSchema.parse(body);
    return saveWorkflowDraftResponseSchema.parse(
      await this.workflows.updateDraft(actor.user.id, {
        ...request,
        workflowId,
      }),
    );
  }
}

@Controller('workflow-versions')
export class WorkflowVersionsController {
  constructor(private readonly workflows: WorkflowService) {}

  @Get(':versionId')
  @Header('Cache-Control', 'no-store')
  get(@Actor() actor: AuthActor, @Param('versionId') versionId: string) {
    return this.workflows.getVersion(actor.user.id, versionId);
  }
}
