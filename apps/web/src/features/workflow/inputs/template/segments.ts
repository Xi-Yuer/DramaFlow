export type TemplateSegment = { kind: 'text'; text: string } | { kind: 'variable'; name: string };

// 只把已绑定 alias 当成变量。未绑定的 {{名称}} 仍是普通文字，避免把展示名写进模板。
export function templateSegments(text: string, names: ReadonlySet<string>): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)) {
    const name = match[1];
    const index = match.index ?? 0;
    if (!name || !names.has(name)) continue;
    if (index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, index) });
    segments.push({ kind: 'variable', name });
    cursor = index + match[0].length;
  }
  segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}

// 保证变量前后都有文本片段，方便把光标放在芯片两侧。空片段不改变保存文本。
export function displayTemplateSegments(
  text: string,
  names: ReadonlySet<string>,
): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  const pushText = (value: string) => {
    const last = segments.at(-1);
    if (last?.kind === 'text') last.text += value;
    else segments.push({ kind: 'text', text: value });
  };
  const parts = templateSegments(text, names);
  if (parts[0]?.kind !== 'text') pushText('');
  for (const part of parts) {
    if (part.kind === 'variable' && segments.at(-1)?.kind === 'variable') pushText('');
    if (part.kind === 'text') pushText(part.text);
    else segments.push(part);
  }
  if (segments.at(-1)?.kind !== 'text') pushText('');
  if (segments.length === 0) segments.push({ kind: 'text', text: '' });
  return segments;
}

export function templateFromSegments(segments: readonly TemplateSegment[]) {
  return segments
    .map((segment) => (segment.kind === 'text' ? segment.text : `{{${segment.name}}}`))
    .join('');
}
