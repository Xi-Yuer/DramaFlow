import { Body, Controller, Get, Patch, Post, Header } from '@nestjs/common';
import { Actor, PlatformAdmin } from '../auth/auth.guard.js';
import type { AuthActor } from '../auth/auth.service.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}
  @Get('me') @Header('Cache-Control', 'no-store') me(@Actor() actor: AuthActor) {
    return this.users.me(actor);
  }
  @Patch('me') update(@Actor() actor: AuthActor, @Body() body: unknown) {
    return this.users.update(actor, body);
  }
  @Get('me/sessions') @Header('Cache-Control', 'no-store') sessions(@Actor() actor: AuthActor) {
    return this.users.sessions(actor);
  }
  @Post('me/revoke-other-sessions') revoke(@Actor() actor: AuthActor) {
    return this.users.revokeOtherSessions(actor);
  }
  @Get() @Header('Cache-Control', 'no-store') @PlatformAdmin() list() {
    return this.users.directory();
  }
}
