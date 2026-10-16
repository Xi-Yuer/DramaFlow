import {
  Body,
  Controller,
  Get,
  Headers,
  MessageEvent,
  Param,
  Post,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Actor, AuthGuard, type ActorValue } from '../auth/auth.guard.js';
import { RunsService } from './runs.service.js';

@Controller()
@UseGuards(AuthGuard)
export class RunsController {
  constructor(private readonly service: RunsService) {}
  @Get('workflows/:id/runs') list(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
  ) {
    return this.service.list(actor.id, id);
  }
  @Post('workflows/:id/runs') start(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.start(actor.id, id, body);
  }
  @Get('runs/:id') get(@Actor() actor: ActorValue, @Param('id') id: string) {
    return this.service.get(actor.id, id);
  }
  @Get('runs/:id/events') events(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
    @Query('after') after?: string,
  ) {
    return this.service.events(actor.id, id, after);
  }
  @Get('runs/:id/tasks') tasks(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
  ) {
    return this.service.tasks(actor.id, id);
  }
  @Post('tasks/:id/respond') respond(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.respond(actor.id, id, body);
  }
  @Post('runs/:id/cancel') cancel(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
  ) {
    return this.service.cancel(actor.id, id);
  }
  @Post('runs/:id/regenerate') regenerate(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.regenerate(actor.id, id, body);
  }
  @Sse('runs/:id/stream') async stream(
    @Actor() actor: ActorValue,
    @Param('id') id: string,
    @Headers('last-event-id') lastId?: string,
    @Query('after') after?: string,
  ): Promise<Observable<MessageEvent>> {
    await this.service.get(actor.id, id);
    let cursor = lastId ?? after;
    return new Observable<MessageEvent>((subscriber) => {
      let stopped = false;
      let pending = false;
      const poll = async () => {
        if (stopped || pending) return;
        pending = true;
        try {
          const { items } = await this.service.events(actor.id, id, cursor);
          if (stopped) return;
          for (const event of items) {
            cursor = event.id;
            subscriber.next({ id: event.id, type: 'message', data: event });
          }
          if (!items.length)
            subscriber.next({
              type: 'heartbeat',
              data: { cursor: cursor ?? '0' },
            });
        } catch (error) {
          subscriber.error(error);
        } finally {
          pending = false;
        }
      };
      const timer = setInterval(() => {
        void poll();
      }, 1500);
      void poll();
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    });
  }
}
