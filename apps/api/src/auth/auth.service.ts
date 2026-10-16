import { Injectable } from '@nestjs/common';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { DatabaseService } from '../infrastructure/database.service.js';

@Injectable()
export class AuthService {
  readonly auth;
  private readonly provisioner;
  constructor(db: DatabaseService) {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret || secret.length < 32)
      throw new Error('BETTER_AUTH_SECRET 至少需要 32 个字符');
    const options = {
      secret,
      baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3001',
      basePath: '/api/auth',
      trustedOrigins: [process.env.WEB_ORIGIN ?? 'http://localhost:3000'],
      database: prismaAdapter(db.client, { provider: 'postgresql' }),
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 12,
        disableSignUp: true,
      },
      advanced: { cookiePrefix: 'dramaflow' },
    };
    this.auth = betterAuth(options);
    // This instance has no HTTP handler. Provisioning is reachable only through the RBAC protected member service.
    this.provisioner = betterAuth({
      ...options,
      emailAndPassword: { ...options.emailAndPassword, disableSignUp: false },
    });
  }
  async provisionUser(
    email: string,
    password: string,
    name: string,
  ): Promise<string> {
    const result = await this.provisioner.api.signUpEmail({
      body: { email, password, name },
    });
    return result.user.id;
  }
}
