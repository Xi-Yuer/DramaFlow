import {
  BooleanType,
  NumberType,
  StringType,
  dataTypeSchema,
  graphInputDefinitionSchema,
  isTypeAssignable,
  iterationBodyInputMappingSchema,
  iterationCompositeDefinitionSchema,
  workflowDraftDefinitionSchema,
  workflowPortNameSchema,
  type DataType,
  type GraphInputDefinition,
  type IterationBodyInputMapping,
  type IterationCompositeDefinition,
  type NodeDefinition,
  type NodeTypeManifest,
  type StaticInputBinding,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { removeVariable, replaceNodeInput } from '../inputs/template-input';
import { resolveWorkflowNodePorts } from '../ports/resolve-workflow-node-ports';

export const ITERATION_ITEMS_KEY = 'items';

const stringList = { kind: 'array' as const, itemType: StringType };
const numberList = { kind: 'array' as const, itemType: NumberType };

export const graphInputTypeChoices: readonly { id: string; label: string; type: DataType }[] = [
  { id: 'string', label: '文本', type: StringType },
  { id: 'number', label: '数字', type: NumberType },
  { id: 'boolean', label: '布尔', type: BooleanType },
  { id: 'string[]', label: '文本列表', type: stringList },
  { id: 'number[]', label: '数字列表', type: numberList },
];

export type GraphInputPatch = {
  name?: string;
  type?: DataType;
  required?: boolean;
};

export type BodyInputSourceOption = {
  id: string;
  source: IterationBodyInputMapping['source'];
  dataType: DataType;
  label: string;
};

function fail(error: { issues: readonly { message: string }[] }, fallback: string): never {
  throw new Error(error.issues[0]?.message ?? fallback);
}

function parseComposite(composite: IterationCompositeDefinition) {
  const parsed = iterationCompositeDefinitionSchema.safeParse(composite);
  if (!parsed.success) fail(parsed.error, 'Iteration 定义无效');
  return parsed.data;
}

function parseInput(input: GraphInputDefinition) {
  const parsed = graphInputDefinitionSchema.safeParse(input);
  if (!parsed.success) fail(parsed.error, '输入无效');
  return parsed.data;
}

function parsePortName(name: string) {
  const parsed = workflowPortNameSchema.safeParse(name);
  if (!parsed.success) fail(parsed.error, '输入名称不合法');
  return parsed.data;
}

function withComposite(
  node: NodeDefinition,
  composite: IterationCompositeDefinition,
): NodeDefinition {
  return { ...node, composite: parseComposite(composite) };
}

export function createEmptyIterationComposite(
  itemType: DataType = StringType,
): IterationCompositeDefinition {
  return parseComposite({
    kind: 'iteration',
    itemType,
    invariantInputs: [],
    bodyInputMapping: [],
    body: { inputs: [], nodes: [], edges: [], outputs: [] },
  });
}

export function initializeIterationBody(node: NodeDefinition): NodeDefinition {
  if (node.composite?.kind === 'iteration') return node;
  return withComposite(node, createEmptyIterationComposite());
}

function requireComposite(node: NodeDefinition) {
  if (node.composite?.kind !== 'iteration') throw new Error('Iteration 尚未初始化 Body');
  return node.composite;
}

function uniqueName(base: string, used: ReadonlySet<string>) {
  let name = base;
  let index = 2;
  while (used.has(name)) {
    name = `${base}_${index}`;
    index += 1;
  }
  return name;
}

function sameSource(
  left: IterationBodyInputMapping['source'],
  right: IterationBodyInputMapping['source'],
) {
  if (left.type !== right.type) return false;
  return (
    left.type !== 'iteration_input' || right.type !== 'iteration_input' || left.key === right.key
  );
}

function sourceType(
  composite: IterationCompositeDefinition,
  source: IterationBodyInputMapping['source'],
) {
  if (source.type === 'current_item') return composite.itemType;
  if (source.type === 'current_index') return NumberType;
  return composite.invariantInputs.find((input) => input.name === source.key)?.type;
}

function dropIncompatibleMappings(
  composite: IterationCompositeDefinition,
): IterationCompositeDefinition {
  return {
    ...composite,
    bodyInputMapping: composite.bodyInputMapping.filter((mapping) => {
      const target = composite.body.inputs.find((input) => input.name === mapping.target);
      const type = sourceType(composite, mapping.source);
      return !!target && !!type && isTypeAssignable(type, target.type);
    }),
  };
}

function rewriteBinding(
  binding: StaticInputBinding,
  from: string,
  to: string | null,
): StaticInputBinding | null {
  if (binding.type === 'workflow_input') {
    if (binding.key !== from) return binding;
    return to ? { type: 'workflow_input', key: to } : null;
  }
  if (binding.type !== 'template') return binding;
  let value = binding.value;
  const variables = { ...binding.variables };
  let changed = false;
  for (const [alias, source] of Object.entries(variables)) {
    if (source.type !== 'workflow_input' || source.key !== from) continue;
    changed = true;
    if (to) variables[alias] = { type: 'workflow_input', key: to };
    else {
      delete variables[alias];
      value = removeVariable(value, alias);
    }
  }
  if (!changed) return binding;
  if (Object.keys(variables).length === 0) {
    const trimmed = value.trim();
    return trimmed ? { type: 'constant', value: trimmed } : null;
  }
  return { type: 'template', value, variables };
}

function rewriteGraphBindings(graph: WorkflowDefinition, from: string, to: string | null) {
  return graph.nodes.map((node) => {
    let changed = false;
    const inputs = { ...node.inputs };
    for (const [key, binding] of Object.entries(inputs)) {
      const next = rewriteBinding(binding, from, to);
      if (next === binding) continue;
      changed = true;
      if (next) inputs[key] = next;
      else delete inputs[key];
    }
    return changed ? { ...node, inputs } : node;
  });
}

function clearIncompatibleBindings(
  graph: WorkflowDefinition,
  inputName: string,
  inputType: DataType,
  manifests: readonly NodeTypeManifest[],
) {
  return graph.nodes.map((node) => {
    const manifest = manifests.find(
      (item) => item.type === node.type && item.version === node.typeVersion,
    );
    if (!manifest) return node;
    const ports = resolveWorkflowNodePorts(node, manifest);
    let changed = false;
    const inputs = { ...node.inputs };
    for (const [key, binding] of Object.entries(inputs)) {
      if (binding.type !== 'workflow_input' || binding.key !== inputName) continue;
      const port = ports.inputs.find((item) => item.key === key);
      if (port && isTypeAssignable(inputType, port.dataType)) continue;
      delete inputs[key];
      changed = true;
    }
    return changed ? { ...node, inputs } : node;
  });
}

export function setIterationItemType(node: NodeDefinition, itemType: DataType): NodeDefinition {
  const composite = requireComposite(node);
  return withComposite(
    node,
    dropIncompatibleMappings({ ...composite, itemType: dataTypeSchema.parse(itemType) }),
  );
}

export function addBodyInput(node: NodeDefinition): NodeDefinition {
  const composite = requireComposite(node);
  const name = uniqueName('input', new Set(composite.body.inputs.map((input) => input.name)));
  return withComposite(node, {
    ...composite,
    body: {
      ...composite.body,
      inputs: [...composite.body.inputs, parseInput({ name, type: StringType, required: true })],
    },
  });
}

export function removeBodyInput(node: NodeDefinition, name: string): NodeDefinition {
  const composite = requireComposite(node);
  return withComposite(node, {
    ...composite,
    bodyInputMapping: composite.bodyInputMapping.filter((mapping) => mapping.target !== name),
    body: {
      ...composite.body,
      inputs: composite.body.inputs.filter((input) => input.name !== name),
      nodes: rewriteGraphBindings(composite.body, name, null),
    },
  });
}

export function updateBodyInput(
  node: NodeDefinition,
  previousName: string,
  patch: GraphInputPatch,
  manifests: readonly NodeTypeManifest[] = [],
): NodeDefinition {
  const composite = requireComposite(node);
  const current = composite.body.inputs.find((input) => input.name === previousName);
  if (!current) throw new Error('Body 输入不存在');
  const name = patch.name === undefined ? current.name : parsePortName(patch.name);
  if (name !== previousName && composite.body.inputs.some((input) => input.name === name)) {
    throw new Error('输入名称不能重复');
  }
  const type = patch.type === undefined ? current.type : dataTypeSchema.parse(patch.type);
  const required = patch.required === undefined ? current.required : patch.required;
  const nextInput = parseInput({ name, type, required });
  const renamed = name !== previousName;
  const next = dropIncompatibleMappings({
    ...composite,
    bodyInputMapping: renamed
      ? composite.bodyInputMapping.map((mapping) =>
          mapping.target === previousName ? { ...mapping, target: name } : mapping,
        )
      : composite.bodyInputMapping,
    body: {
      ...composite.body,
      inputs: composite.body.inputs.map((input) =>
        input.name === previousName ? nextInput : input,
      ),
      nodes: renamed
        ? rewriteGraphBindings(composite.body, previousName, name)
        : composite.body.nodes,
    },
  });
  return withComposite(node, {
    ...next,
    body: { ...next.body, nodes: clearIncompatibleBindings(next.body, name, type, manifests) },
  });
}

export function bodyInputSourceOptions(
  composite: IterationCompositeDefinition,
  targetType: DataType,
): BodyInputSourceOption[] {
  const options: BodyInputSourceOption[] = [];
  if (isTypeAssignable(composite.itemType, targetType)) {
    options.push({
      id: 'current_item',
      source: { type: 'current_item' },
      dataType: composite.itemType,
      label: '← 当前元素',
    });
  }
  if (isTypeAssignable(NumberType, targetType)) {
    options.push({
      id: 'current_index',
      source: { type: 'current_index' },
      dataType: NumberType,
      label: '← 当前序号',
    });
  }
  for (const input of composite.invariantInputs) {
    if (input.name === ITERATION_ITEMS_KEY || !isTypeAssignable(input.type, targetType)) continue;
    options.push({
      id: `iteration_input:${input.name}`,
      source: { type: 'iteration_input', key: input.name },
      dataType: input.type,
      label: `← 迭代输入 · ${input.name}`,
    });
  }
  return options;
}

export function setBodyInputMapping(
  node: NodeDefinition,
  target: string,
  source: IterationBodyInputMapping['source'] | null,
): NodeDefinition {
  const composite = requireComposite(node);
  const input = composite.body.inputs.find((item) => item.name === target);
  if (!input) throw new Error('Body 输入不存在');
  const rest = composite.bodyInputMapping.filter((mapping) => mapping.target !== target);
  if (!source) return withComposite(node, { ...composite, bodyInputMapping: rest });
  const parsed = iterationBodyInputMappingSchema.shape.source.safeParse(source);
  if (!parsed.success) fail(parsed.error, '映射来源无效');
  const match = bodyInputSourceOptions(composite, input.type).find((option) =>
    sameSource(option.source, parsed.data),
  );
  if (!match) throw new Error('来源类型与 Body 输入不兼容');
  const bodyInputMapping = [...rest, { target, source: match.source }];
  if (new Set(bodyInputMapping.map((mapping) => mapping.target)).size !== bodyInputMapping.length) {
    throw new Error('Body 输入映射不能重复');
  }
  return withComposite(node, { ...composite, bodyInputMapping });
}

export function addInvariantInput(node: NodeDefinition): NodeDefinition {
  const composite = requireComposite(node);
  const name = uniqueName(
    'input',
    new Set([ITERATION_ITEMS_KEY, ...composite.invariantInputs.map((input) => input.name)]),
  );
  return withComposite(node, {
    ...composite,
    invariantInputs: [
      ...composite.invariantInputs,
      parseInput({ name, type: StringType, required: true }),
    ],
  });
}

export function removeInvariantInput(node: NodeDefinition, name: string): NodeDefinition {
  const composite = requireComposite(node);
  return withComposite(node, {
    ...composite,
    invariantInputs: composite.invariantInputs.filter((input) => input.name !== name),
    bodyInputMapping: composite.bodyInputMapping.filter(
      (mapping) => !(mapping.source.type === 'iteration_input' && mapping.source.key === name),
    ),
  });
}

export function updateInvariantInput(
  node: NodeDefinition,
  previousName: string,
  patch: GraphInputPatch,
): NodeDefinition {
  const composite = requireComposite(node);
  const current = composite.invariantInputs.find((input) => input.name === previousName);
  if (!current) throw new Error('不变输入不存在');
  const name = patch.name === undefined ? current.name : parsePortName(patch.name);
  if (name === ITERATION_ITEMS_KEY) throw new Error('不变输入不能使用保留名称 items');
  if (name !== previousName && composite.invariantInputs.some((input) => input.name === name)) {
    throw new Error('输入名称不能重复');
  }
  const type = patch.type === undefined ? current.type : dataTypeSchema.parse(patch.type);
  const required = patch.required === undefined ? current.required : patch.required;
  const nextInput = parseInput({ name, type, required });
  return withComposite(
    node,
    dropIncompatibleMappings({
      ...composite,
      invariantInputs: composite.invariantInputs.map((input) =>
        input.name === previousName ? nextInput : input,
      ),
      bodyInputMapping:
        name === previousName
          ? composite.bodyInputMapping
          : composite.bodyInputMapping.map((mapping) =>
              mapping.source.type === 'iteration_input' && mapping.source.key === previousName
                ? { ...mapping, source: { type: 'iteration_input', key: name } }
                : mapping,
            ),
    }),
  );
}

export function formatDataType(type: DataType): string {
  if (type.kind === 'any') return '任意';
  if (type.kind === 'array') return `(${formatDataType(type.itemType)})[]`;
  if (type.kind === 'object') return '结构化对象';
  if (type.kind === 'union') return type.types.map(formatDataType).join(' | ');
  if (type.kind === 'primitive') {
    if (type.name === 'string') return '文本';
    if (type.name === 'number') return '数字';
    if (type.name === 'boolean') return '布尔';
    return '空值';
  }
  return type.name;
}

export function graphInputTypeChoiceId(type: DataType) {
  const serialized = JSON.stringify(dataTypeSchema.parse(type));
  return (
    graphInputTypeChoices.find(
      (choice) => JSON.stringify(dataTypeSchema.parse(choice.type)) === serialized,
    )?.id ?? null
  );
}

export function bindGraphInput(
  definition: WorkflowDefinition,
  manifests: readonly NodeTypeManifest[],
  targetNodeId: string,
  portKey: string,
  inputKey: string,
): WorkflowDefinition {
  const input = definition.inputs.find((item) => item.name === inputKey);
  if (!input) throw new Error('Body 输入不存在');
  const node = definition.nodes.find((item) => item.id === targetNodeId);
  if (!node) throw new Error('目标节点不存在');
  const manifest = manifests.find(
    (item) => item.type === node.type && item.version === node.typeVersion,
  );
  if (!manifest) throw new Error('节点类型不可用');
  const port = resolveWorkflowNodePorts(node, manifest).inputs.find((item) => item.key === portKey);
  if (!port) throw new Error('目标端口不存在');
  if (!isTypeAssignable(input.type, port.dataType)) throw new Error('端口类型不兼容');
  const existing = node.inputs[portKey];
  const blockingEdge = definition.edges.some(
    (edge) =>
      edge.kind === 'data' &&
      edge.target.nodeId === targetNodeId &&
      edge.target.portKey === portKey,
  );
  if (existing?.type === 'workflow_input' && existing.key === inputKey && !blockingEdge) {
    return definition;
  }
  const replaced = replaceNodeInput(definition, targetNodeId, portKey, {
    type: 'workflow_input',
    key: inputKey,
  });
  return workflowDraftDefinitionSchema.parse({
    ...replaced,
    edges: replaced.edges.filter(
      (edge) =>
        !(
          edge.kind === 'data' &&
          edge.target.nodeId === targetNodeId &&
          edge.target.portKey === portKey
        ),
    ),
  });
}
