import {
  isTypeAssignable,
  StringType,
  templateBindingMatches,
  templateVariableNames,
  type NodeTypeManifest,
  type StaticInputBinding,
  type TemplateBinding,
  type WorkflowDefinition,
} from '@dramaflow/contracts';

export interface AvailableOutput {
  nodeId: string;
  nodeName: string;
  portKey: string;
  portName: string;
}

type NodeOutputVariables = {
  [name: string]: Extract<TemplateBinding['variables'][string], { type: 'node_output' }>;
};

export type TextBindingDraft =
  { status: 'clear' } | { status: 'ready'; binding: StaticInputBinding } | { status: 'invalid' };

// 自身以及沿边或模板引用能够到达的节点都是下游。其余节点都可以成为新的上游，不会形成环。
export function downstreamNodeIds(
  definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>,
  nodeId: string,
) {
  const outgoing = new Map<string, Set<string>>();
  const add = (source: string, target: string) => {
    const targets = outgoing.get(source) ?? new Set<string>();
    targets.add(target);
    outgoing.set(source, targets);
  };
  for (const edge of definition.edges) add(edge.source.nodeId, edge.target.nodeId);
  for (const node of definition.nodes) {
    for (const binding of Object.values(node.inputs)) {
      if (binding.type !== 'template') continue;
      for (const source of Object.values(binding.variables)) {
        if (source.type === 'node_output') add(source.nodeId, node.id);
      }
    }
  }
  const downstream = new Set<string>([nodeId]);
  const pending = [nodeId];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (!current) continue;
    for (const target of outgoing.get(current) ?? []) {
      if (downstream.has(target)) continue;
      downstream.add(target);
      pending.push(target);
    }
  }
  return downstream;
}

export function availableStringOutputs(
  definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>,
  nodeId: string,
  manifests: readonly NodeTypeManifest[],
): AvailableOutput[] {
  const blocked = downstreamNodeIds(definition, nodeId);
  const outputs: AvailableOutput[] = [];
  for (const node of definition.nodes) {
    if (blocked.has(node.id)) continue;
    const manifest = manifests.find(
      (item) => item.type === node.type && item.version === node.typeVersion,
    );
    if (!manifest) continue;
    for (const port of manifest.outputs) {
      if (!isTypeAssignable(port.dataType, StringType)) continue;
      outputs.push({
        nodeId: node.id,
        nodeName: node.name,
        portKey: port.key,
        portName: port.name,
      });
    }
  }
  return outputs;
}

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

export function sourceLabel(nodeName: string, portName: string) {
  return `${nodeName} · ${portName}`;
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

export function describeNodeOutput(
  definition: Pick<WorkflowDefinition, 'nodes'>,
  manifests: readonly NodeTypeManifest[],
  source: { nodeId: string; portKey: string },
) {
  const node = definition.nodes.find((item) => item.id === source.nodeId);
  const manifest = node
    ? manifests.find((item) => item.type === node.type && item.version === node.typeVersion)
    : undefined;
  const port = manifest?.outputs.find((item) => item.key === source.portKey);
  return {
    nodeName: node?.name ?? source.nodeId,
    portName: port?.name ?? source.portKey,
  };
}
