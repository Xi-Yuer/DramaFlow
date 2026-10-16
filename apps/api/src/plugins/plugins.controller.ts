import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { Actor } from '../auth/auth.guard.js';
import type { AuthActor } from '../auth/auth.service.js';
import { PluginsService } from './plugins.service.js';

@Controller('plugins')
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  catalog() {
    return this.plugins.catalog();
  }
  @Get('installations')
  @Header('Cache-Control', 'no-store')
  list(@Actor() actor: AuthActor) {
    return this.plugins.list(actor.user.id);
  }
  @Get('installations/:id/models')
  @Header('Cache-Control', 'no-store')
  models(@Actor() actor: AuthActor, @Param('id') id: string) {
    return this.plugins.models(actor.user.id, id);
  }
  @Post('installations')
  install(@Actor() actor: AuthActor, @Body() body: unknown) {
    return this.plugins.install(actor.user.id, body);
  }
  @Put('installations/:id')
  update(
    @Actor() actor: AuthActor,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.plugins.update(actor.user.id, id, body);
  }
  @Delete('installations/:id')
  remove(@Actor() actor: AuthActor, @Param('id') id: string) {
    return this.plugins.remove(actor.user.id, id);
  }
}
