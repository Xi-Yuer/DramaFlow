import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Actor, AuthGuard, type ActorValue } from '../auth/auth.guard.js';
import { ConversationMemoryService } from './memory.service.js';

@Controller('conversations/:id')
@UseGuards(AuthGuard)
export class ConversationMemoryController {
  constructor(private readonly memory: ConversationMemoryService) {}
  @Get('summaries') list(@Actor() actor: ActorValue, @Param('id') id: string) {
    return this.memory.list(actor.id, id);
  }
  @Post('summarize') summarize(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.memory.summarize(actor.id, id, body);
  }
}
