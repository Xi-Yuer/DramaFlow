import { workflowDefinitionSchema } from '@dramaflow/contracts';
import type {
  DataType,
  JsonValue,
  WorkflowDefinition,
  WorkflowValidation,
  ValidationIssue,
} from '@dramaflow/contracts';
import { listPluginManifests, validateManifestParameters } from '@dramaflow/plugins/manifest';
import { controlPorts, getNodeDefinition, nodeConfigSchemas } from './catalog.js';

function literalType(value: JsonValue): DataType {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'any';
  if (typeof value === 'string') return 'text';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'json';
}

/** Dependencies include data references, but only controlEdges can activate a node. */
export function dependenciesOf(definition: WorkflowDefinition, nodeId: string): string[] {
  return [
    ...new Set([
      ...definition.controlEdges
        .filter((edge) => edge.target === nodeId)
        .map((edge) => edge.source),
      ...definition.bindings.flatMap((binding) =>
        binding.nodeId === nodeId && binding.source.kind === 'node' ? [binding.source.nodeId] : [],
      ),
    ]),
  ];
}

export function getInvalidatedNodeIds(definition: WorkflowDefinition, nodeId: string): string[] {
  const invalidated = new Set([nodeId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const node of definition.nodes) {
      if (
        !invalidated.has(node.id) &&
        dependenciesOf(definition, node.id).some((id) => invalidated.has(id))
      ) {
        invalidated.add(node.id);
        changed = true;
      }
    }
  }
  return definition.nodes.filter((node) => invalidated.has(node.id)).map((node) => node.id);
}

export function validateWorkflow(value: unknown): WorkflowValidation {
  const parsed = workflowDefinitionSchema.safeParse(value);
  if (!parsed.success)
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'INVALID_DEFINITION',
        message: issue.message,
        path: issue.path.join('.'),
      })),
    };
  const definition = parsed.data;
  const issues: ValidationIssue[] = [];
  const add = (code: string, message: string, nodeId?: string) => {
    issues.push({ code, message, ...(nodeId ? { nodeId } : {}) });
  };
  const ids = new Set<string>();
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  for (const node of definition.nodes) {
    if (ids.has(node.id)) add('DUPLICATE_NODE', '节点 ID 重复', node.id);
    if (
      [
        '__start__',
        '__end__',
        '__finalize__',
        'runId',
        'attemptId',
        'inputs',
        'nodeResults',
        'outputCollections',
        'reusedResults',
        'executeNodeIds',
        '__proto__',
        'constructor',
        'prototype',
      ].includes(node.id) ||
      node.id.includes(':')
    )
      add('RESERVED_NODE_ID', '节点 ID 包含运行时保留名称或字符', node.id);
    ids.add(node.id);
    if (node.version !== '1.0.0') add('UNSUPPORTED_NODE_VERSION', '未安装此节点版本', node.id);
    const configResult = nodeConfigSchemas[node.type].safeParse(node.config);
    if (!configResult.success) {
      for (const issue of configResult.error.issues)
        issues.push({
          code: 'INVALID_NODE_CONFIG',
          message: issue.message,
          nodeId: node.id,
          path: issue.path.join('.'),
        });
      continue;
    }
    if (['text', 'image', 'video', 'batch'].includes(node.type)) {
      const model = node.config.model;
      if (typeof model === 'object' && model !== null && !Array.isArray(model)) {
        const capability =
          node.type === 'batch'
            ? (node.config.capability ?? 'text.generate')
            : `${node.type}.generate`;
        const manifest = listPluginManifests().find(
          (plugin) => plugin.id === model.pluginId && plugin.version === model.pluginVersion,
        );
        if (!manifest) add('PLUGIN_UNAVAILABLE', '未安装指定版本的受信任插件', node.id);
        else if (!manifest.capabilities.some((candidate) => candidate === capability))
          add('CAPABILITY_UNAVAILABLE', '所选插件不支持此节点能力', node.id);
        if (manifest && manifest.capabilities.some((candidate) => candidate === capability)) {
          const selectedCapability = manifest.capabilities.find(
            (candidate) => candidate === capability,
          )!;
          if (
            !validateManifestParameters(manifest, selectedCapability, node.config.parameters ?? {})
              .valid
          ) {
            add('INVALID_MODEL_PARAMETERS', '模型参数不符合所选插件声明的结构化约束', node.id);
          }
        }
      }
      if (
        node.type !== 'batch' &&
        !(typeof node.config.prompt === 'string' && node.config.prompt.trim()) &&
        !definition.bindings.some(
          (binding) => binding.nodeId === node.id && binding.port === 'prompt',
        )
      )
        add('PROMPT_REQUIRED', '需要编写需求或绑定 prompt 输入', node.id);
    }
    if (
      node.type === 'condition' &&
      (node.config.operator ?? 'isTruthy') !== 'isTruthy' &&
      !Object.hasOwn(node.config, 'expected')
    )
      add('CONDITION_EXPECTED_REQUIRED', '此比较方式需要 expected 值', node.id);
    for (const port of getNodeDefinition(node.type).inputs.filter((input) => input.required)) {
      if (
        !definition.bindings.some(
          (binding) => binding.nodeId === node.id && binding.port === port.name,
        )
      )
        add('REQUIRED_BINDING_MISSING', `缺少必需输入 ${port.name}`, node.id);
    }
  }
  const inputNodes = definition.nodes.filter((node) => node.type === 'input');
  if (inputNodes.length !== 1) add('INPUT_NODE_COUNT', '工作流必须包含一个输入节点');
  if (!definition.nodes.some((node) => node.type === 'output'))
    add('OUTPUT_NODE_REQUIRED', '工作流至少需要一个结果收集节点');
  const edgeIds = new Set<string>();
  for (const edge of definition.controlEdges) {
    if (edgeIds.has(edge.id)) add('DUPLICATE_EDGE', '执行连线 ID 重复');
    edgeIds.add(edge.id);
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      add('UNKNOWN_EDGE_NODE', '执行连线引用不存在的节点');
      continue;
    }
    if (!controlPorts(byId.get(edge.source)!.type).includes(edge.sourcePort))
      add('UNKNOWN_CONTROL_PORT', '执行出口不存在', edge.source);
    if (byId.get(edge.target)!.type === 'input')
      add('INPUT_HAS_UPSTREAM', '输入节点不能接收上游执行连线', edge.target);
  }
  const bindingKeys = new Set<string>();
  for (const binding of definition.bindings) {
    const node = byId.get(binding.nodeId);
    if (!node) {
      add('UNKNOWN_BINDING_NODE', '输入绑定的目标节点不存在');
      continue;
    }
    const key = `${binding.nodeId}:${binding.port}`;
    if (['__proto__', 'constructor', 'prototype'].includes(binding.port))
      add('UNSAFE_INPUT_PORT', '输入名称包含保留字段', node.id);
    if (bindingKeys.has(key))
      add('DUPLICATE_BINDING', `输入 ${binding.port} 被重复绑定`, binding.nodeId);
    bindingKeys.add(key);
    if (
      !['merge', 'output'].includes(node.type) &&
      !getNodeDefinition(node.type).inputs.some((port) => port.name === binding.port)
    )
      add('UNKNOWN_INPUT_PORT', `输入端口 ${binding.port} 不存在`, node.id);
    if (binding.source.kind === 'node') {
      const sourceBinding = binding.source;
      const source = byId.get(sourceBinding.nodeId);
      if (!source) add('UNKNOWN_SOURCE_NODE', '数据引用的来源节点不存在', node.id);
      else if (
        source.type !== 'output' &&
        !getNodeDefinition(source.type).outputs.some((port) => port.name === sourceBinding.port)
      )
        add('UNKNOWN_OUTPUT_PORT', '数据引用的来源端口不存在', node.id);
    }
    const targetType = getNodeDefinition(node.type).inputs.find(
      (port) => port.name === binding.port,
    )?.dataType;
    let sourceType: DataType | undefined;
    if (binding.source.kind === 'literal') sourceType = literalType(binding.source.value);
    if (binding.source.kind === 'node' && !binding.source.path) {
      const sourceBinding = binding.source;
      const source = byId.get(sourceBinding.nodeId);
      if (source && source.type !== 'output')
        sourceType = getNodeDefinition(source.type).outputs.find(
          (port) => port.name === sourceBinding.port,
        )?.dataType;
    }
    if (
      sourceType &&
      targetType &&
      sourceType !== 'any' &&
      targetType !== 'any' &&
      sourceType !== targetType
    ) {
      add(
        'BINDING_TYPE_MISMATCH',
        `输入 ${binding.port} 需要 ${targetType}，来源为 ${sourceType}`,
        node.id,
      );
    }
    const paths = binding.source.kind === 'literal' ? [] : [binding.source.path];
    if (
      paths.some((path) =>
        path?.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)),
      )
    )
      add('UNSAFE_DATA_PATH', '数据路径包含保留字段', node.id);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  let cyclic = false;
  const visit = (id: string) => {
    if (visiting.has(id)) {
      cyclic = true;
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependenciesOf(definition, id))
      if (byId.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of definition.nodes) visit(node.id);
  if (cyclic) add('DEPENDENCY_CYCLE', '执行连线与数据引用的联合依赖图存在环');
  if (inputNodes.length === 1) {
    const reachable = new Set([inputNodes[0]!.id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const edge of definition.controlEdges)
        if (reachable.has(edge.source) && !reachable.has(edge.target)) {
          reachable.add(edge.target);
          changed = true;
        }
    }
    for (const node of definition.nodes)
      if (!reachable.has(node.id))
        add('CONTROL_UNREACHABLE', '节点无法通过执行连线从输入节点到达', node.id);
  }
  return { valid: issues.length === 0, issues };
}
