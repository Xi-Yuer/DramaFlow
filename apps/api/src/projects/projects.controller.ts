import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Actor } from '../auth/auth.guard.js';
import type { AuthActor } from '../auth/auth.service.js';
import { ProjectsService } from './projects.service.js';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}
  @Get() @Header('Cache-Control', 'no-store') list(
    @Actor() actor: AuthActor,
    @Query() query: unknown,
  ) {
    return this.projects.list(actor.user.id, query);
  }
  @Post() create(@Actor() actor: AuthActor, @Body() body: unknown) {
    return this.projects.create(actor.user.id, body);
  }
  @Get(':id') @Header('Cache-Control', 'no-store') get(
    @Actor() actor: AuthActor,
    @Param('id') id: string,
  ) {
    return this.projects.get(actor.user.id, id);
  }
  @Put(':id') save(
    @Actor() actor: AuthActor,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.projects.save(actor.user.id, id, body);
  }
}
