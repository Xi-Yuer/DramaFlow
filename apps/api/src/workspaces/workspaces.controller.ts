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
import { WorkspacesService } from './workspaces.service.js';

@Controller()
@UseGuards(AuthGuard)
export class WorkspacesController {
  constructor(private readonly service: WorkspacesService) {}
  @Get('workspaces') list(@Actor() actor: ActorValue) {
    return this.service.list(actor.id);
  }
  @Get('workspaces/:workspaceId/members') members(
    @Actor() actor: ActorValue,
    @Param('workspaceId') id: string,
  ) {
    return this.service.members(actor.id, id);
  }
  @Post('workspaces/:workspaceId/members') addMember(
    @Actor() actor: ActorValue,
    @Param('workspaceId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.addMember(actor.id, id, body);
  }
  @Put('workspaces/:workspaceId/members/:userId') updateRole(
    @Actor() actor: ActorValue,
    @Param('workspaceId') id: string,
    @Param('userId') targetId: string,
    @Body() body: unknown,
  ) {
    return this.service.updateRole(actor.id, id, targetId, body);
  }
}
