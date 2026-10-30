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
import { Actor } from '../auth/auth.guard.js';
import type { AuthActor } from '../auth/auth.service.js';
import { VideosService } from './videos.service.js';

@Controller('projects/:projectId/videos')
export class VideosController {
  constructor(private readonly videos: VideosService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Actor() actor: AuthActor, @Param('projectId') projectId: string, @Query() query: unknown) {
    return this.videos.list(actor.user.id, projectId, query);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Actor() actor: AuthActor, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.videos.create(actor.user.id, projectId, body);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@Actor() actor: AuthActor, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.videos.get(actor.user.id, projectId, id);
  }

  @Put(':id')
  @Header('Cache-Control', 'no-store')
  save(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.videos.save(actor.user.id, projectId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  remove(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.videos.remove(actor.user.id, projectId, id);
  }
}
