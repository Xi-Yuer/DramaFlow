import { describe, expect, it } from 'vitest';
import { emptyWorkflowDefinition } from '@dramaflow/contracts';
import type { PlatformMessage } from '@dramaflow/contracts';
import {
  applyWorkflowChanges,
  buildContext,
  ContextBudgetError,
  parseWorkflowProposal,
  selectSummaryMessages,
} from '../src/index.js';

const workflow = { id: 'workflow', revision: 2, definition: emptyWorkflowDefinition };
describe('上下文与建议边界', () => {
  it('节点上下文不带入无关节点结果或所有会话', () => {
    const context = buildContext({
      scope: { kind: 'node', nodeId: 'output' },
      workflow,
      messages: [],
      currentRequest: '检查输入',
      run: {
        id: 'r1',
        status: 'waiting',
        nodeResults: {
          input: { status: 'succeeded', outputs: { value: '绑定结果' }, activePorts: ['out'] },
          secret: { status: 'succeeded', outputs: { value: '无关节点秘密' }, activePorts: [] },
        },
      },
    });
    expect(JSON.stringify(context)).toContain('绑定结果');
    expect(JSON.stringify(context)).not.toContain('无关节点秘密');
    expect(context.manifest.workflowRevision).toBe(2);
  });
  it('明确选择的内容超限时拒绝，不静默截断', () => {
    expect(() =>
      buildContext({
        scope: { kind: 'workflow' },
        workflow,
        messages: [],
        currentRequest: '设定'.repeat(20000),
        model: { contextWindow: 4096 },
      }),
    ).toThrow(ContextBudgetError);
  });
  it('保留原始消息且裁剪完整对话轮次', () => {
    const messages: PlatformMessage[] = Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      role: i % 2 ? 'assistant' : 'user',
      content: `第${i}条消息`,
      createdAt: '2026-10-16T00:00:00Z',
    }));
    const context = buildContext({
      scope: { kind: 'workflow' },
      workflow,
      messages,
      currentRequest: '继续',
      policy: { recentMessageLimit: 4 },
    });
    expect(messages).toHaveLength(40);
    expect(context.messages.filter((message) => message.id === '0')).toHaveLength(0);
    expect(context.manifest.sources.some((source) => !source.included)).toBe(true);
  });
  it('建议只生成新的定义，未知操作不能应用', () => {
    const next = applyWorkflowChanges(emptyWorkflowDefinition, [
      { kind: 'renameNode', nodeId: 'output', value: '新的结果集' },
    ]);
    expect(next.nodes[1]?.title).toBe('新的结果集');
    expect(emptyWorkflowDefinition.nodes[1]?.title).toBe('收集结果');
    expect(parseWorkflowProposal('普通回答')).toBeUndefined();
    expect(
      parseWorkflowProposal(
        '```workflow-proposal\n{"title":"标题","explanation":"原因","changes":[{"kind":"executeRun","value":{}}]}\n```',
      ),
    ).toBeUndefined();
  });
  it('摘要保持来源可追溯，不重复纳入已覆盖的原始消息', () => {
    const messages: PlatformMessage[] = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      role: i % 2 ? 'assistant' : 'user',
      content: `原始内容${i}`,
      createdAt: '2026-10-16T00:00:00Z',
    }));
    const chosen = selectSummaryMessages(messages);
    expect(chosen.map((message) => message.id)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
    const summary = {
      id: 's1',
      content: '用户已确认角色设定',
      throughMessageId: '7',
      messageIds: chosen.map((message) => message.id),
      createdAt: '2026-10-16T00:00:00Z',
    };
    const context = buildContext({
      scope: { kind: 'workflow' },
      workflow,
      messages,
      summary,
      currentRequest: '继续讨论',
    });
    expect(context.messages.some((message) => message.id === '0')).toBe(false);
    expect(context.messages.some((message) => message.content.includes('用户已确认角色设定'))).toBe(
      true,
    );
    expect(context.manifest.sources.find((source) => source.id === '0')?.reason).toContain(
      '摘要覆盖',
    );
    expect(messages).toHaveLength(12);
    expect(selectSummaryMessages(messages, summary)).toEqual([]);
  });
});
