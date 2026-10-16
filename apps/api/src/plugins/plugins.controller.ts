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
import { PluginsService } from './plugins.service.js';
import { listNodeDefinitions } from '@dramaflow/workflow';

@Controller()
@UseGuards(AuthGuard)
export class PluginsController {
  constructor(private readonly service: PluginsService) {}
  @Get('node-catalog') catalog() {
    return { items: listNodeDefinitions() };
  }
  @Get('workspaces/:workspaceId/plugins') plugins(
    @Actor() actor: ActorValue,
    @Param('workspaceId') id: string,
  ) {
    return this.service.list(actor.id, id);
  }
  @Put('workspaces/:workspaceId/plugins/:pluginId') enable(
    @Actor() actor: ActorValue,
    @Param('workspaceId') id: string,
    @Param('pluginId') pluginId: string,
    @Body() body: unknown,
  ) {
    return this.service.setEnabled(actor.id, id, pluginId, body);
  }
  @Get('workspaces/:workspaceId/connections') connections(
    @Actor() actor: ActorValue,
    @Param('workspaceId') id: string,
  ) {
    return this.service.connections(actor.id, id);
  }
  @Post('workspaces/:workspaceId/connections') create(
    @Actor() actor: ActorValue,
    @Param('workspaceId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.createConnection(actor.id, id, body);
  }
}
