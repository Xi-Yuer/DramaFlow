import { describe, expect, it } from 'vitest';
import {
  applyFormatTextTemplate,
  formatTextConfigSchema,
  formatTextInputSchema,
  formatTextOutputSchema,
  formatTextVariableNames,
  readFormatTextTemplate,
} from '../fixtures/format-text.js';

const input = { text: 'A', index: 0 };

describe('test.format_text@1 值契约', () => {
  it('声明输入与模板变量一致，并保留空字符串和有限数字', () => {
    expect(Object.keys(formatTextInputSchema.shape)).toEqual([...formatTextVariableNames]);
    expect(formatTextInputSchema.parse(input)).toEqual(input);
    expect(formatTextInputSchema.parse({ text: '', index: -1.5 })).toEqual({
      text: '',
      index: -1.5,
    });
    expect(formatTextOutputSchema.parse({ text: 'A-0' })).toEqual({ text: 'A-0' });
    expect(formatTextOutputSchema.parse({ text: '' })).toEqual({ text: '' });
    for (const value of [
      {},
      { text: 'A' },
      { index: 0 },
      { text: 1, index: 0 },
      { text: 'A', index: '0' },
      { text: 'A', index: Number.NaN },
      { text: 'A', index: Number.POSITIVE_INFINITY },
      { text: 'A', index: 0, extra: true },
    ])
      expect(formatTextInputSchema.safeParse(value).success).toBe(false);
    for (const value of [{}, { text: 1 }, { text: 'A-0', raw: true }])
      expect(formatTextOutputSchema.safeParse(value).success).toBe(false);
  });

  it('按声明输入做命名插值，重复变量各自替换，正文不再扫描', () => {
    expect(applyFormatTextTemplate('{{text}}-{{index}}', input)).toBe('A-0');
    expect(applyFormatTextTemplate('{{index}}:{{text}}', { text: 'B', index: 1 })).toBe('1:B');
    expect(applyFormatTextTemplate('{{text}}/{{text}}-{{index}}', input)).toBe('A/A-0');
    expect(applyFormatTextTemplate('{{text}}-{{index}}', { text: '', index: 0 })).toBe('-0');
    expect(applyFormatTextTemplate('{{text}}-{{index}}', { text: '{{index}}', index: 2 })).toBe(
      '{{index}}-2',
    );
    expect(applyFormatTextTemplate('plain', input)).toBe('plain');
    expect(readFormatTextTemplate('{{text}}-{{index}}')).toEqual([
      { kind: 'variable', name: 'text' },
      { kind: 'literal', value: '-' },
      { kind: 'variable', name: 'index' },
    ]);
  });

  it('未知变量和非法模板在配置契约上失败，不接受表达式', () => {
    const unknown = formatTextConfigSchema.safeParse({ template: '{{caption}}' });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues[0]?.message).toBe('文本格式模板引用了未声明的输入：caption');
    }
    for (const template of [
      '{{text}',
      '{{',
      '}}',
      '{{}}',
      '{{ text }}',
      '{{text-index}}',
      '{{{text}}}',
      '{{constructor}}',
      'prefix}}{{text}}',
    ]) {
      const parsed = formatTextConfigSchema.safeParse({ template });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe('文本格式模板不合法');
    }
    for (const config of [{}, { template: 1 }, { template: '{{text}}', extra: true }])
      expect(formatTextConfigSchema.safeParse(config).success).toBe(false);
    expect(formatTextConfigSchema.parse({ template: '{{text}}-{{index}}' })).toEqual({
      template: '{{text}}-{{index}}',
    });
  });
});
