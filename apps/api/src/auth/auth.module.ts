import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { AuthGuard } from './auth.guard.js';
import { AccessService } from './access.service.js';

@Global()
@Module({
  providers: [AuthService, AuthGuard, AccessService],
  exports: [AuthService, AuthGuard, AccessService],
})
export class AuthModule {}
