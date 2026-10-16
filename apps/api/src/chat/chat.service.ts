import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { parseWorkflowProposal } from '@dramaflow/context';
import {
  chatRequestSchema,
  modelSelectionSchema,
  type ChatReply,
  type PlatformMessage,
  type WorkflowChangeProposal,
} from '@dramaflow/contracts';
import { normalizeProviderError } from '@dramaflow/plugins';
import { DatabaseService } from '../infrastructure/database.service.js';
import { PluginsService } from '../plugins/plugins.service.js';
import { json, parse } from '../infrastructure/validation.js';
import { ConversationsService } from './conversations.service.js';

@Injectable()
export class ChatService {
  constructor(
    private readonly db: DatabaseService,
    private readonly conversations: ConversationsService,
    private readonly plugins: PluginsService,
  ) {}
  async send(
    userId: string,
    conversationId: string,
    body: unknown,
    idempotencyKey: string = randomUUID(),
  ): Promise<ChatReply> {
    const conversation = await this.conversations.get(
      userId,
      conversationId,
      true,
    );
    const input = parse(chatRequestSchema, body);
    if (idempotencyKey.length > 200)
      throw new BadRequestException('幂等键过长');
    const operationId = `chat:${conversationId}:${idempotencyKey}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    const existing = await this.db.client.operation.findUnique({
      where: { id: operationId },
    });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ConflictException('幂等键已用于不同消息');
      if (existing.status === 'succeeded' && existing.result)
        return existing.result as unknown as ChatReply;
      throw new ConflictException({
        code:
          existing.status === 'submitted' ||
          existing.status === 'outcome_unknown'
            ? 'OUTCOME_UNKNOWN'
            : 'CHAT_REQUEST_EXISTS',
        message: '此消息请求已受理，请查看历史记录；需要重新生成时使用新请求',
      });
    }
    const context = await this.conversations.context(
      userId,
      conversationId,
      input,
    );
    const model = parse(modelSelectionSchema, conversation.model);
    const { provider, context: providerContext } = await this.plugins.resolve(
      conversation.workspaceId,
      model,
      'chat',
    );
    const requestMessage = await this.db.client.$transaction(async (tx) => {
      await tx.operation.create({
        data: {
          id: operationId,
          conversationId,
          nodeId: conversation.nodeId || 'global',
          attemptId: idempotencyKey,
          requestHash,
          status: 'submitted',
        },
      });
      return tx.chatMessage.create({
        data: {
          conversationId,
          role: 'user',
          content: input.content,
          assetVersionRefs: json(input.assetVersionIds),
          requestKey: idempotencyKey,
        },
      });
    });
    try {
      if (!provider.generateText)
        throw new BadRequestException('所选插件不支持对话');
      const result = await provider.generateText(
        {
          modelId: model.modelId,
          messages: context.messages.map((message) => ({
            role: message.role === 'tool' ? 'user' : message.role,
            content: message.content,
          })),
          parameters: {
            maxOutputTokens: context.manifest.reservedOutputTokens,
          },
        },
        providerContext,
      );
      const proposed = parseWorkflowProposal(result.text);
      const allowedProposal =
        proposed &&
        (conversation.scope !== 'node' ||
          proposed.changes.every(
            (change) =>
              ['updateNodeConfig', 'renameNode'].includes(change.kind) &&
              change.nodeId === conversation.nodeId,
          ))
          ? proposed
          : undefined;
      return await this.db.client.$transaction(async (tx) => {
        const row = await tx.chatMessage.create({
          data: {
            conversationId,
            role: 'assistant',
            content: result.text,
            metadata: json({
              operationId,
              ...(result.usage ? { usage: result.usage } : {}),
            }),
          },
        });
        const message: PlatformMessage = {
          id: row.id,
          role: 'assistant',
          content: row.content,
          createdAt: row.createdAt.toISOString(),
        };
        await tx.contextTrace.create({
          data: {
            conversationId,
            requestMessageId: requestMessage.id,
            manifest: json(context.manifest),
            ...(result.usage ? { usage: json(result.usage) } : {}),
          },
        });
        let proposal: WorkflowChangeProposal | undefined;
        if (allowedProposal) {
          const saved = await tx.suggestion.create({
            data: {
              workflowId: conversation.workflowId,
              conversationId,
              baseRevision: context.manifest.workflowRevision,
              title: allowedProposal.title,
              explanation: allowedProposal.explanation,
              patch: json(allowedProposal.changes),
            },
          });
          proposal = {
            id: saved.id,
            workflowId: saved.workflowId,
            conversationId,
            baseRevision: saved.baseRevision,
            title: saved.title,
            explanation: saved.explanation,
            changes: allowedProposal.changes,
            status: 'pending',
            createdAt: saved.createdAt.toISOString(),
          };
        }
        const reply: ChatReply = {
          message,
          context: context.manifest,
          ...(proposal ? { proposal } : {}),
        };
        await tx.operation.update({
          where: { id: operationId },
          data: {
            status: 'succeeded',
            result: json(reply),
            providerRequestId: result.providerRequestId,
          },
        });
        return reply;
      });
    } catch (error) {
      const safe = normalizeProviderError(error);
      await this.db.client.operation.update({
        where: { id: operationId },
        data: {
          status: safe.outcomeUnknown ? 'outcome_unknown' : 'failed',
          error: { code: safe.code, message: safe.message },
        },
      });
      throw new BadRequestException({ code: safe.code, message: safe.message });
    }
  }
}
