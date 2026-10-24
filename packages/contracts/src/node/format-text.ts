import { z } from 'zod';

// data.format_text@1 的值契约。只替换本节点已声明输入的 {{name}}，
// 不解释 Graph TemplateBinding，也不执行表达式。
export const formatTextVariableNames = ['text', 'index'] as const;
export type FormatTextVariableName = (typeof formatTextVariableNames)[number];

const declaredVariables = new Set<string>(formatTextVariableNames);
const reservedNames = new Set(['constructor', 'prototype']);
const variableNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/;

export class FormatTextTemplateError extends Error {
  readonly code: 'FORMAT_TEXT_TEMPLATE_MALFORMED' | 'FORMAT_TEXT_UNKNOWN_VARIABLE';

  constructor(code: FormatTextTemplateError['code'], message: string) {
    super(message);
    this.name = 'FormatTextTemplateError';
    this.code = code;
  }
}

export type FormatTextTemplateSegment =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'variable'; readonly name: FormatTextVariableName };

function malformed(): never {
  throw new FormatTextTemplateError('FORMAT_TEXT_TEMPLATE_MALFORMED', '文本格式模板不合法');
}

export function readFormatTextTemplate(template: string): FormatTextTemplateSegment[] {
  const segments: FormatTextTemplateSegment[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf('{{', cursor);
    const closeBeforeOpen = template.indexOf('}}', cursor);
    if (open === -1) {
      if (closeBeforeOpen !== -1) malformed();
      segments.push({ kind: 'literal', value: template.slice(cursor) });
      break;
    }
    if (closeBeforeOpen !== -1 && closeBeforeOpen < open) malformed();
    const close = template.indexOf('}}', open + 2);
    if (close === -1) malformed();
    const nested = template.indexOf('{{', open + 2);
    if (nested !== -1 && nested < close) malformed();
    const name = template.slice(open + 2, close);
    if (!variableNamePattern.test(name) || reservedNames.has(name)) malformed();
    if (!declaredVariables.has(name)) {
      throw new FormatTextTemplateError(
        'FORMAT_TEXT_UNKNOWN_VARIABLE',
        `文本格式模板引用了未声明的输入：${name}`,
      );
    }
    if (open > cursor) segments.push({ kind: 'literal', value: template.slice(cursor, open) });
    segments.push({ kind: 'variable', name: name as FormatTextVariableName });
    cursor = close + 2;
  }
  return segments;
}

export const formatTextInputSchema = z
  .object({
    text: z.string(),
    index: z.number().finite(),
  })
  .strict();

export const formatTextOutputSchema = z.object({ text: z.string() }).strict();

export const formatTextTemplateSchema = z.string().superRefine((template, context) => {
  try {
    readFormatTextTemplate(template);
  } catch (error) {
    if (!(error instanceof FormatTextTemplateError)) throw error;
    context.addIssue({ code: 'custom', message: error.message });
  }
});

export const formatTextConfigSchema = z.object({ template: formatTextTemplateSchema }).strict();

export type FormatTextInput = z.infer<typeof formatTextInputSchema>;
export type FormatTextOutput = z.infer<typeof formatTextOutputSchema>;
export type FormatTextConfig = z.infer<typeof formatTextConfigSchema>;

export function applyFormatTextTemplate(template: string, input: FormatTextInput): string {
  return readFormatTextTemplate(template)
    .map((segment) => {
      if (segment.kind === 'literal') return segment.value;
      return segment.name === 'index' ? String(input.index) : input.text;
    })
    .join('');
}
