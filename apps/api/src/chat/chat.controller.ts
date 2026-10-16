import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Actor, AuthGuard, type ActorValue } from '../auth/auth.guard.js';
import { ConversationsService } from './conversations.service.js';
import { ChatService } from './chat.service.js';
import { ProposalsService } from './proposals.service.js';

@Controller()
@UseGuards(AuthGuard)
export class ChatController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly chat: ChatService,
    private readonly proposals: ProposalsService,
  ) {}
  @Get('workflows/:id/conversations') list(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
  ) {
    return this.conversations.list(actor.id, id);
  }
  @Post('workflows/:id/conversations') create(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.conversations.create(actor.id, id, body);
  }
  @Get('conversations/:id/messages') messages(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
  ) {
    return this.conversations.messages(actor.id, id);
  }
  @Post('conversations/:id/messages') send(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.chat.send(actor.id, id, body, key);
  }
  @Post('conversations/:id/context-preview') preview(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.conversations.context(actor.id, id, body);
  }
  @Get('conversations/:id/proposals') listProposals(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
  ) {
    return this.proposals.list(actor.id, id);
  }
  @Post('proposals/:id/apply') apply(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.proposals.apply(actor.id, id, body);
  }
}
