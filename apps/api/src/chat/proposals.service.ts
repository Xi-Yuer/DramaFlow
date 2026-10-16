import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { applyWorkflowChanges } from '@dramaflow/context';
import {
  workflowDefinitionSchema,
  type WorkflowChange,
  type WorkflowChangeProposal,
} from '@dramaflow/contracts';
import { validateWorkflow } from '@dramaflow/workflow';
import { z } from 'zod';
import { AccessService } from '../auth/access.service.js';
import { DatabaseService } from '../infrastructure/database.service.js';
import { json, parse } from '../infrastructure/validation.js';
import { ConversationsService } from './conversations.service.js';
import { WorkflowsService } from '../workflows/workflows.service.js';

@Injectable()
export class ProposalsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly conversations: ConversationsService,
    private readonly workflows: WorkflowsService,
  ) {}
  async list(userId: string, conversationId: string) {
    await this.conversations.get(userId, conversationId);
    const rows = await this.db.client.suggestion.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        conversationId,
        workflowId: row.workflowId,
        baseRevision: row.baseRevision,
        title: row.title,
        explanation: row.explanation,
        changes: row.patch as unknown as WorkflowChange[],
        status: row.status as WorkflowChangeProposal['status'],
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
  async apply(userId: string, proposalId: string, body: unknown) {
    const input = parse(
      z.object({ baseRevision: z.number().int().nonnegative() }).strict(),
      body,
    );
    const proposal = await this.db.client.suggestion.findUnique({
      where: { id: proposalId },
    });
    if (!proposal) throw new NotFoundException('建议不存在');
    await this.access.workflow(userId, proposal.workflowId, 'editor');
    const conversation = await this.conversations.get(
      userId,
      proposal.conversationId,
      true,
    );
    await this.db.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workflow" WHERE id = ${proposal.workflowId} FOR UPDATE`;
      const currentProposal = await tx.suggestion.findUniqueOrThrow({
        where: { id: proposalId },
      });
      if (currentProposal.status === 'applied') return;
      if (currentProposal.status !== 'pending')
        throw new ConflictException('建议不能再次应用');
      const workflow = await tx.workflow.findUniqueOrThrow({
        where: { id: proposal.workflowId },
      });
      if (
        input.baseRevision !== currentProposal.baseRevision ||
        workflow.draftRevision !== currentProposal.baseRevision
      )
        throw new ConflictException('工作流已修改，请重新对话生成建议');
      const changes = currentProposal.patch as unknown as WorkflowChange[];
      if (
        conversation.scope === 'node' &&
        changes.some(
          (change) =>
            !['updateNodeConfig', 'renameNode'].includes(change.kind) ||
            change.nodeId !== conversation.nodeId,
        )
      )
        throw new BadRequestException(
          '节点会话只能建议修改当前节点的配置和名称',
        );
      let definition;
      try {
        definition = applyWorkflowChanges(
          parse(workflowDefinitionSchema, workflow.draft),
          changes,
        );
      } catch {
        throw new BadRequestException('建议中的修改不符合工作流协议');
      }
      const validation = validateWorkflow(definition);
      if (!validation.valid)
        throw new BadRequestException({
          message: '应用建议后工作流验证失败',
          issues: validation.issues,
        });
      await tx.workflow.update({
        where: { id: workflow.id },
        data: { draft: json(definition), draftRevision: { increment: 1 } },
      });
      await tx.suggestion.update({
        where: { id: proposalId },
        data: {
          status: 'applied',
          appliedBy: userId,
          appliedAt: new Date(),
          idempotencyKey: `apply:${proposalId}`,
        },
      });
    });
    return this.workflows.get(userId, proposal.workflowId);
  }
}
