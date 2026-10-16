import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { buildContext } from '@dramaflow/context';
import {
  chatRequestSchema,
  createConversationSchema,
  modelSelectionSchema,
  type ContextBundle,
  type Conversation,
  type ConversationSummary,
  type PlatformMessage,
} from '@dramaflow/contracts';
import { z } from 'zod';
import { DatabaseService } from '../infrastructure/database.service.js';
import { AccessService } from '../auth/access.service.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { PluginsService } from '../plugins/plugins.service.js';
import { AssetsService } from '../assets/assets.service.js';
import { RunsService } from '../runs/runs.service.js';
import { json, parse } from '../infrastructure/validation.js';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly workflows: WorkflowsService,
    private readonly plugins: PluginsService,
    private readonly assets: AssetsService,
    private readonly runs: RunsService,
  ) {}
  private dto(row: {
    id: string;
    workflowId: string;
    scope: string;
    nodeId: string;
    model: unknown;
    createdAt: Date;
  }): Conversation {
    return {
      id: row.id,
      workflowId: row.workflowId,
      scope: parse(z.enum(['workflow', 'node']), row.scope),
      nodeId: row.nodeId || null,
      model: parse(modelSelectionSchema, row.model),
      createdAt: row.createdAt.toISOString(),
    };
  }
  async get(userId: string, conversationId: string, write = false) {
    const row = await this.db.client.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!row) throw new NotFoundException('会话不存在');
    await this.access.workspace(
      userId,
      row.workspaceId,
      write ? 'editor' : 'viewer',
    );
    return row;
  }
  async list(userId: string, workflowId: string) {
    await this.access.workflow(userId, workflowId);
    return {
      items: (
        await this.db.client.conversation.findMany({
          where: { workflowId },
          orderBy: { createdAt: 'asc' },
        })
      ).map((row) => this.dto(row)),
    };
  }
  async create(
    userId: string,
    workflowId: string,
    body: unknown,
  ): Promise<Conversation> {
    const workflow = await this.workflows.get(userId, workflowId);
    await this.access.workspace(userId, workflow.workspaceId, 'editor');
    const input = parse(createConversationSchema, body);
    if (
      input.scope === 'node' &&
      (!input.nodeId ||
        !workflow.definition.nodes.some((node) => node.id === input.nodeId))
    )
      throw new BadRequestException('请选择当前工作流中的节点');
    if (input.scope === 'workflow' && input.nodeId)
      throw new BadRequestException('全局会话不能指定节点');
    await this.plugins.resolve(workflow.workspaceId, input.model, 'chat');
    return this.dto(
      await this.db.client.conversation.upsert({
        where: {
          workflowId_scope_nodeId: {
            workflowId,
            scope: input.scope,
            nodeId: input.nodeId ?? '',
          },
        },
        create: {
          workflowId,
          workspaceId: workflow.workspaceId,
          scope: input.scope,
          nodeId: input.nodeId ?? '',
          model: json(input.model),
        },
        update: { model: json(input.model) },
      }),
    );
  }
  async messages(
    userId: string,
    conversationId: string,
  ): Promise<{ items: PlatformMessage[] }> {
    await this.get(userId, conversationId);
    const rows = await this.db.client.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    return {
      items: rows.reverse().map((row) => ({
        id: row.id,
        role: parse(z.enum(['system', 'user', 'assistant', 'tool']), row.role),
        content: row.content,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
  async context(
    userId: string,
    conversationId: string,
    body: unknown,
  ): Promise<ContextBundle> {
    const conversation = await this.get(userId, conversationId);
    const input = parse(chatRequestSchema, body);
    const workflow = await this.workflows.get(userId, conversation.workflowId);
    const model = parse(modelSelectionSchema, conversation.model);
    const { provider, connection } = await this.plugins.resolve(
      conversation.workspaceId,
      model,
      'chat',
    );
    const descriptor = provider.manifest.models.find(
      (candidate) => candidate.id === model.modelId,
    );
    const configuration = parse(
      z
        .object({
          contextWindow: z.number().int().min(2048).max(2000000).optional(),
          maxOutputTokens: z.number().int().positive().max(100000).optional(),
        })
        .passthrough(),
      connection.configuration,
    );
    const contextWindow =
      descriptor?.contextWindow ?? configuration.contextWindow;
    if (!contextWindow)
      throw new BadRequestException(
        '此自定义模型未声明上下文窗口，请在模型连接中配置 contextWindow',
      );
    const { items: messages } = await this.messages(userId, conversationId);
    const summaryRow = await this.db.client.conversationSummary.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
    });
    let summary: ConversationSummary | undefined;
    if (summaryRow) {
      const messageIds = parse(
        z.array(z.string()),
        summaryRow.sourceMessageIds,
      );
      const throughMessageId = messageIds.at(-1);
      if (throughMessageId)
        summary = {
          id: summaryRow.id,
          content: summaryRow.content,
          messageIds,
          throughMessageId,
          createdAt: summaryRow.createdAt.toISOString(),
        };
    }
    const run = input.runId
      ? await this.runs.get(userId, input.runId)
      : undefined;
    if (run && run.workflowId !== workflow.id)
      throw new BadRequestException('运行记录不属于当前工作流');
    return buildContext({
      scope: {
        kind: parse(z.enum(['workflow', 'node']), conversation.scope),
        ...(conversation.nodeId ? { nodeId: conversation.nodeId } : {}),
      },
      workflow: {
        id: workflow.id,
        revision: workflow.revision,
        definition: workflow.definition,
        ...(run ? { versionId: run.workflowVersionId } : {}),
      },
      messages,
      currentRequest: input.content,
      ...(summary ? { summary } : {}),
      ...(run
        ? {
            run: {
              id: run.id,
              status: run.status,
              nodeResults: run.nodeResults,
            },
          }
        : {}),
      assets: await this.assets.contextAssets(
        userId,
        conversation.workspaceId,
        input.assetVersionIds,
      ),
      model: {
        contextWindow,
        maxOutputTokens:
          descriptor?.maxOutputTokens ?? configuration.maxOutputTokens,
      },
    });
  }
}
