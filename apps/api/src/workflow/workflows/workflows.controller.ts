import {
  saveWorkflowDraftRequestSchema,
  saveWorkflowDraftResponseSchema,
  publishWorkflowRequestSchema,
  workflowVersionResponseSchema,
} from '@dramaflow/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Actor } from '../../auth/auth.guard.js';
import type { AuthActor } from '../../auth/auth.service.js';
import { WorkflowService } from './workflow.service.js';

@Controller('projects/:projectId/workflows')
export class ProjectWorkflowsController {
  constructor(private readonly workflows: WorkflowService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Actor() actor: AuthActor, @Param('projectId') projectId: string, @Query() query: unknown) {
    return this.workflows.listForProject(actor.user.id, projectId, query);
  }
  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Actor() actor: AuthActor, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.workflows.createForProject(actor.user.id, projectId, body);
  }
  @Get(':workflowId')
  @Header('Cache-Control', 'no-store')
  get(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('workflowId') workflowId: string,
  ) {
    return this.workflows.get(actor.user.id, projectId, workflowId);
  }
  @Put(':workflowId')
  @Header('Cache-Control', 'no-store')
  save(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('workflowId') workflowId: string,
    @Body() body: unknown,
  ) {
    return this.workflows.saveMetadata(actor.user.id, projectId, workflowId, body);
  }
  @Delete(':workflowId')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  remove(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('workflowId') workflowId: string,
    @Body() body: unknown,
  ) {
    return this.workflows.remove(actor.user.id, projectId, workflowId, body);
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
