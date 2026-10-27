import type { StaticInputBinding } from '@dramaflow/contracts';
import { draftBinding, nodeOutputVariables, textFromBinding } from './binding';
import { templateSegments } from './segments';
import type {
  NodeOutputVariables,
  TemplateEditorDocument,
  TemplateEditorInlineNode,
  TemplateEditorParagraphNode,
  TextBindingDraft,
} from './types';

// 将领域 TemplateBinding / ConstantBinding 转换为编辑器内部 Document（不泄漏到领域协议）。
export function textAndVariablesToEditorDocument(
  text: string,
  variables: NodeOutputVariables,
): TemplateEditorDocument {
  const names = new Set(Object.keys(variables));
  const lines = text.split('\n');
  const paragraphs: TemplateEditorParagraphNode[] = lines.map((line) => {
    const segments = templateSegments(line, names);
    const content: TemplateEditorInlineNode[] = [];
    for (const segment of segments) {
      if (segment.kind === 'text') {
        if (segment.text.length > 0) {
          content.push({ type: 'text', text: segment.text });
        }
      } else {
        const source = variables[segment.name];
        if (source) {
          content.push({
            type: 'variableToken',
            attrs: {
              alias: segment.name,
              nodeId: source.nodeId,
              portKey: source.portKey,
            },
          });
        }
      }
    }
    return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
  });
  return {
    type: 'doc',
    content: paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph' }],
  };
}

export function bindingToTemplateEditorDocument(
  binding: StaticInputBinding | undefined,
): TemplateEditorDocument {
  return textAndVariablesToEditorDocument(textFromBinding(binding), nodeOutputVariables(binding));
}

// 将编辑器内部 Document 还原为领域 TemplateBinding / ConstantBinding，并自动清理未引用的变量绑定。
export function templateEditorDocumentToDraft(
  doc: { content?: ReadonlyArray<{ type?: string; content?: ReadonlyArray<unknown> }> },
  fallbackVariables: NodeOutputVariables = {},
): { text: string; variables: NodeOutputVariables; draft: TextBindingDraft } {
  const usedVariables: NodeOutputVariables = {};
  const paragraphs = doc.content ?? [];
  const lines = paragraphs.map((paragraph) => {
    const inlineNodes = (paragraph.content ?? []) as ReadonlyArray<{
      type?: string;
      text?: string;
      attrs?: { alias?: string; nodeId?: string; portKey?: string };
    }>;
    let lineText = '';
    for (const node of inlineNodes) {
      if (node.type === 'text' && typeof node.text === 'string') {
        lineText += node.text;
      } else if (node.type === 'hardBreak') {
        lineText += '\n';
      } else if (node.type === 'variableToken' && node.attrs?.alias) {
        const alias = node.attrs.alias;
        const source =
          node.attrs.nodeId && node.attrs.portKey
            ? {
                type: 'node_output' as const,
                nodeId: node.attrs.nodeId,
                portKey: node.attrs.portKey,
              }
            : fallbackVariables[alias];
        if (source) {
          usedVariables[alias] = source;
          lineText += `{{${alias}}}`;
        }
      }
    }
    return lineText;
  });
  const text = lines.join('\n');
  return {
    text,
    variables: usedVariables,
    draft: draftBinding(text, usedVariables),
  };
}

export function templateEditorDocumentToBinding(
  doc: { content?: ReadonlyArray<{ type?: string; content?: ReadonlyArray<unknown> }> },
  fallbackVariables: NodeOutputVariables = {},
): StaticInputBinding | null {
  const { draft } = templateEditorDocumentToDraft(doc, fallbackVariables);
  if (draft.status === 'ready') return draft.binding;
  return null;
}
