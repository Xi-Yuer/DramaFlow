import { Module } from '@nestjs/common';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { PluginsModule } from '../plugins/plugins.module.js';
import { AssetsModule } from '../assets/assets.module.js';
import { RunsModule } from '../runs/runs.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { ConversationsService } from './conversations.service.js';
import { ProposalsService } from './proposals.service.js';
import { ConversationMemoryService } from './memory.service.js';
import { ConversationMemoryController } from './memory.controller.js';
@Module({
  imports: [WorkflowsModule, PluginsModule, AssetsModule, RunsModule],
  controllers: [ChatController, ConversationMemoryController],
  providers: [
    ChatService,
    ConversationsService,
    ProposalsService,
    ConversationMemoryService,
  ],
})
export class ChatModule {}
