'use client';

import { Check, Minus, ScanEye } from 'lucide-react';
import type { ContextBundle } from '@dramaflow/contracts';

export function ContextPreview({ bundle }: { bundle: ContextBundle }) {
  const { manifest } = bundle;
  return (
    <div className="context-preview">
      <h4>
        <ScanEye size={12} style={{ display: 'inline', marginRight: 6 }} />
        本次上下文 · {manifest.policyVersion}
      </h4>
      <p className="field-hint" style={{ margin: '7px 0 12px' }}>
        输入 {manifest.estimatedInputTokens.toLocaleString()} /{' '}
        {manifest.inputBudget.toLocaleString()} tokens · 预留输出{' '}
        {manifest.reservedOutputTokens.toLocaleString()}
        <br />
        工作流 r{manifest.workflowRevision} ·{' '}
        {manifest.estimation === 'approximate' ? '近似估算' : '供应商计数'}
      </p>
      {manifest.sources.map((source, index) => (
        <div
          key={`${source.kind}:${source.id}:${index}`}
          style={{
            display: 'flex',
            gap: 6,
            padding: '5px 0',
            lineHeight: 1.5,
            color: source.included ? '#a7c496' : '#6c7e70',
          }}
        >
          {source.included ? (
            <Check size={11} style={{ flexShrink: 0, marginTop: 2 }} />
          ) : (
            <Minus size={11} style={{ flexShrink: 0, marginTop: 2 }} />
          )}
          <span>
            {source.label} {source.version && <small>v{source.version}</small>} ·{' '}
            {source.estimatedTokens} tokens
            {source.reason && (
              <small style={{ display: 'block', color: '#7d8f70' }}>{source.reason}</small>
            )}
          </span>
        </div>
      ))}
      <details style={{ marginTop: 10 }}>
        <summary>查看实际消息内容</summary>
        <pre>
          {bundle.messages.map((message) => `[${message.role}]\n${message.content}`).join('\n\n')}
        </pre>
      </details>
    </div>
  );
}
