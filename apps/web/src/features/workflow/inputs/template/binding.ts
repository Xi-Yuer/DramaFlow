import {
  templateBindingMatches,
  templateVariableNames,
  type StaticInputBinding,
  type TemplateBinding,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import type { NodeOutputVariables, TextBindingDraft } from './types';

export function textFromBinding(binding: StaticInputBinding | undefined) {
  if (binding?.type === 'constant') return typeof binding.value === 'string' ? binding.value : '';
  if (binding?.type === 'template') return binding.value;
  return '';
}

export function nodeOutputVariables(binding: StaticInputBinding | undefined): NodeOutputVariables {
  if (binding?.type !== 'template') return {};
  const variables: NodeOutputVariables = {};
  for (const [name, source] of Object.entries(binding.variables)) {
    if (source.type === 'node_output') variables[name] = source;
  }
  return variables;
}

export function variableNameForPort(
  portKey: string,
  variables: NodeOutputVariables,
  source: { nodeId: string; portKey: string },
) {
  const existing = Object.entries(variables).find(
    ([, item]) => item.nodeId === source.nodeId && item.portKey === source.portKey,
  );
  if (existing) return existing[0];
  if (!Object.hasOwn(variables, portKey)) return portKey;
  for (let index = 2; index < 1000; index += 1) {
    const name = `${portKey}${index}`;
    if (!Object.hasOwn(variables, name)) return name;
  }
  return null;
}

export function insertVariable(text: string, start: number, end: number, name: string) {
  const token = `{{${name}}}`;
  return {
    text: `${text.slice(0, start)}${token}${text.slice(end)}`,
    cursor: start + token.length,
  };
}

export function removeVariable(text: string, name: string) {
  return text.replaceAll(`{{${name}}}`, '');
}

export function draftBinding(text: string, variables: NodeOutputVariables): TextBindingDraft {
  const used: NodeOutputVariables = {};
  for (const name of templateVariableNames(text)) {
    const source = variables[name];
    if (source) used[name] = source;
  }
  if (Object.keys(used).length === 0) {
    if (text.length === 0) return { status: 'clear' };
    return { status: 'ready', binding: { type: 'constant', value: text } };
  }
  if (!templateBindingMatches(text, used)) return { status: 'invalid' };
  return { status: 'ready', binding: { type: 'template', value: text, variables: used } };
}

export function replaceNodeInput(
  definition: WorkflowDefinition,
  nodeId: string,
  portKey: string,
  binding: StaticInputBinding | null,
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const inputs = { ...node.inputs };
      if (binding) inputs[portKey] = binding;
      else delete inputs[portKey];
      return { ...node, inputs };
    }),
  };
}

// 删除来源节点时同步移除相关 alias 和正文 token，保留其他变量及原有文本。
export function removeTemplateNodeSources(
  binding: TemplateBinding,
  removedNodeIds: ReadonlySet<string>,
): StaticInputBinding | null {
  let value = binding.value;
  const variables = { ...binding.variables };
  let changed = false;
  for (const [name, source] of Object.entries(variables)) {
    if (source.type !== 'node_output' || !removedNodeIds.has(source.nodeId)) continue;
    value = removeVariable(value, name);
    delete variables[name];
    changed = true;
  }
  if (!changed) return binding;
  if (Object.keys(variables).length) return { ...binding, value, variables };
  return value.length ? { type: 'constant', value } : null;
}
