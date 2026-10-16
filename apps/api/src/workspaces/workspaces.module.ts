import { Module } from '@nestjs/common';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';
@Module({ providers: [WorkspacesService], controllers: [WorkspacesController] })
export class WorkspacesModule {}
