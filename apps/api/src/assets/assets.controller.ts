import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Actor, AuthGuard, type ActorValue } from '../auth/auth.guard.js';
import { AssetsService } from './assets.service.js';

@Controller()
@UseGuards(AuthGuard)
export class AssetsController {
  constructor(private readonly service: AssetsService) {}
  @Get('workspaces/:workspaceId/assets') list(
    @Actor() actor: ActorValue,
    @Param('workspaceId') id: string,
  ) {
    return this.service.list(actor.id, id);
  }
  @Post('workspaces/:workspaceId/assets') upload(
    @Actor() actor: ActorValue,
    @Param('workspaceId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.upload(actor.id, id, body);
  }
  @Get('assets/:versionId/content') async content(
    @Actor() actor: ActorValue,
    @Param('versionId') id: string,
    @Res() response: Response,
  ) {
    const { row, bytes } = await this.service.content(actor.id, id);
    response.setHeader('Content-Type', row.mimeType);
    response.setHeader('Content-Length', bytes.length);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "sandbox; default-src 'none'",
    );
    response.setHeader('Cache-Control', 'private, max-age=3600');
    if (!/^(image\/(png|jpeg|webp|gif)|video\/|audio\/)/.test(row.mimeType))
      response.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(row.asset.name)}`,
      );
    response.send(Buffer.from(bytes));
  }
}
