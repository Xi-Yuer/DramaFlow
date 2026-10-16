import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Actor, AuthGuard, type ActorValue } from '../auth/auth.guard.js';
import { WorkflowsService } from './workflows.service.js';

@Controller()
@UseGuards(AuthGuard)
export class WorkflowsController {
  constructor(private readonly service: WorkflowsService) {}
  @Get('workspaces/:workspaceId/workflows') list(
    @Actor() actor: ActorValue,
    @Param('workspaceId') id: string,
  ) {
    return this.service.list(actor.id, id);
  }
  @Post('workspaces/:workspaceId/workflows') create(
    @Actor() actor: ActorValue,
    @Param('workspaceId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.create(actor.id, id, body);
  }
  @Get('workflows/:id') get(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
  ) {
    return this.service.get(actor.id, id);
  }
  @Put('workflows/:id') save(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.save(actor.id, id, body);
  }
  @Post('workflows/:id/validate') validate(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.validate(actor.id, id, body);
  }
  @Post('workflows/:id/publish') publish(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
  ) {
    return this.service.publish(actor.id, id);
  }
  @Get('workflows/:id/versions') versions(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
  ) {
    return this.service.versions(actor.id, id);
  }
}
