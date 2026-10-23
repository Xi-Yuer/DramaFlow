import {
  templateBindingMatches,
  type CandidateBinding,
  type DataEdgeDefinition,
  type InputPortDefinition,
  type NodeDefinition,
  type NodeOutputMap,
  type NodeTypeManifest,
  type RuntimeValue,
  type StaticInputBinding,
  type TemplateBinding,
  type WorkflowEdge,
  type WorkflowInputDefinition,
} from '@dramaflow/contracts';
import {
  BindingResolutionError,
  type BindingResolutionErrorDetails,
} from './binding-resolution-error.js';
import type { WorkflowState } from './state.js';

export interface BindingResolverContext {
  readonly node: NodeDefinition;
  // 由上层按 node.type / typeVersion 取得并完成边界校验的同版本 Manifest。
  readonly nodeType: NodeTypeManifest;
  readonly edges: readonly WorkflowEdge[];
  readonly state: WorkflowState;
  readonly workflowInputs: readonly WorkflowInputDefinition[];
}

export interface BindingResolver {
  resolveInputs(context: BindingResolverContext): Promise<Record<string, RuntimeValue>>;
}

function edgeDetails(edge: DataEdgeDefinition): BindingResolutionErrorDetails {
  return {
    nodeId: edge.target.nodeId,
    inputKey: edge.target.portKey,
    edgeId: edge.id,
    sourceNodeId: edge.source.nodeId,
    sourcePortKey: edge.source.portKey,
  };
}

export function resolveDataEdgeInputs(
  nodeId: string,
  edges: readonly WorkflowEdge[],
  outputs: NodeOutputMap,
): Record<string, RuntimeValue> {
  const incoming = new Map<string, DataEdgeDefinition>();
  for (const edge of edges) {
    if (edge.kind !== 'data' || edge.target.nodeId !== nodeId) continue;
    if (incoming.has(edge.target.portKey)) {
      throw new BindingResolutionError(
        'INPUT_SOURCE_CONFLICT',
        `输入端口 ${nodeId}.${edge.target.portKey} 连接了多条数据边`,
        edgeDetails(edge),
      );
    }
    incoming.set(edge.target.portKey, edge);
  }

  return Object.fromEntries(
    Array.from(incoming, ([inputKey, edge]) => {
      const sourceOutputs = Object.hasOwn(outputs, edge.source.nodeId)
        ? outputs[edge.source.nodeId]
        : undefined;
      const value =
        sourceOutputs && Object.hasOwn(sourceOutputs, edge.source.portKey)
          ? sourceOutputs[edge.source.portKey]
          : undefined;
      if (value === undefined) {
        throw new BindingResolutionError(
          'SOURCE_NODE_OUTPUT_MISSING',
          `上游节点 ${edge.source.nodeId} 未产生输出 ${edge.source.portKey}`,
          edgeDetails(edge),
        );
      }
      // 只保留原 RuntimeValue，不 decode reference、不复制或改写上游结果。
      return [inputKey, value];
    }),
  );
}

function requireInputPort(
  ports: ReadonlyMap<string, InputPortDefinition>,
  details: BindingResolutionErrorDetails,
): InputPortDefinition {
  const port = ports.get(details.inputKey);
  if (!port) {
    throw new BindingResolutionError(
      'INPUT_PORT_NOT_FOUND',
      `节点 ${details.nodeId} 未声明输入端口 ${details.inputKey}`,
      details,
    );
  }
  return port;
}

function resolveTemplateBinding(
  binding: TemplateBinding,
  input: WorkflowState['inputs'],
  nodeOutputs: NodeOutputMap,
  key: string,
  nodeId: string,
  port: InputPortDefinition,
): RuntimeValue {
  if (!templateBindingMatches(binding.value, binding.variables)) {
    throw new BindingResolutionError('TEMPLATE_VARIABLE_INVALID', `模板变量与正文不一致：${key}`, {
      nodeId,
      inputKey: key,
    });
  }
  const values = new Map<string, string>();
  for (const [name, source] of Object.entries(binding.variables)) {
    if (source.type === 'workflow_input') {
      if (!Object.hasOwn(input, source.key)) {
        throw new BindingResolutionError(
          'WORKFLOW_INPUT_MISSING',
          `模板变量缺少工作流输入：${source.key}`,
          { nodeId, inputKey: key, workflowInputKey: source.key, variableName: name },
        );
      }
      values.set(name, inlineString(input[source.key]!, key, nodeId, name));
      continue;
    }
    const output = nodeOutput(nodeOutputs, source.nodeId, source.portKey);
    if (!output) {
      throw new BindingResolutionError(
        'SOURCE_NODE_OUTPUT_MISSING',
        `模板变量缺少来源输出：${source.nodeId}.${source.portKey}`,
        {
          nodeId,
          inputKey: key,
          sourceNodeId: source.nodeId,
          sourcePortKey: source.portKey,
          variableName: name,
        },
      );
    }
    values.set(name, inlineString(output, key, nodeId, name));
  }
  return {
    storage: 'inline',
    type: port.dataType,
    value: binding.value.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_token, name: string) => {
      const value = values.get(name);
      if (value === undefined) {
        throw new BindingResolutionError('TEMPLATE_VARIABLE_INVALID', `模板变量未解析：${name}`, {
          nodeId,
          inputKey: key,
          variableName: name,
        });
      }
      return value;
    }),
  };
}

function nodeOutput(nodeOutputs: NodeOutputMap, sourceNodeId: string, sourcePortKey: string) {
  if (!Object.hasOwn(nodeOutputs, sourceNodeId)) return undefined;
  const ports = nodeOutputs[sourceNodeId];
  if (!ports || !Object.hasOwn(ports, sourcePortKey)) return undefined;
  return ports[sourcePortKey];
}

function inlineString(value: RuntimeValue, key: string, nodeId: string, variableName: string) {
  if (value.storage !== 'inline') {
    throw new BindingResolutionError(
      'TEMPLATE_VARIABLE_INVALID',
      `模板变量必须是已内联的字符串：${variableName}`,
      { nodeId, inputKey: key, variableName },
    );
  }
  if (typeof value.value !== 'string') {
    throw new BindingResolutionError(
      'TEMPLATE_VARIABLE_INVALID',
      `模板变量必须是已内联的字符串：${variableName}`,
      { nodeId, inputKey: key, variableName },
    );
  }
  return value.value;
}

function resolveCandidateBinding(
  binding: CandidateBinding,
  nodeOutputs: NodeOutputMap,
  key: string,
  nodeId: string,
): RuntimeValue {
  const present: RuntimeValue[] = [];
  for (const source of binding.sources) {
    const output = nodeOutput(nodeOutputs, source.nodeId, source.portKey);
    if (output !== undefined) present.push(output);
  }
  if (present.length > 1) {
    throw new BindingResolutionError(
      'CANDIDATE_INPUT_AMBIGUOUS',
      `候选输入 ${nodeId}.${key} 存在多个来源输出`,
      { nodeId, inputKey: key },
    );
  }
  const value = present[0];
  if (value === undefined) {
    throw new BindingResolutionError(
      'SOURCE_NODE_OUTPUT_MISSING',
      `候选输入 ${nodeId}.${key} 缺少来源输出`,
      { nodeId, inputKey: key },
    );
  }
  return value;
}

function resolveStaticBinding(
  binding: StaticInputBinding,
  port: InputPortDefinition,
  context: BindingResolverContext,
): RuntimeValue {
  switch (binding.type) {
    case 'constant':
      return { storage: 'inline', type: port.dataType, value: binding.value };
    case 'workflow_input': {
      const value = Object.hasOwn(context.state.inputs, binding.key)
        ? context.state.inputs[binding.key]
        : undefined;
      if (value === undefined) {
        throw new BindingResolutionError(
          'WORKFLOW_INPUT_MISSING',
          `工作流输入 ${binding.key} 不存在`,
          { nodeId: context.node.id, inputKey: port.key, workflowInputKey: binding.key },
        );
      }
      // 工作流输入可能已是引用；保留原 RuntimeValue 及其实际类型和承载方式。
      return value;
    }
    case 'asset':
      return {
        storage: 'reference',
        type: port.dataType,
        reference: { kind: 'asset', id: binding.assetId, versionId: binding.versionId },
      };
    case 'template':
      return resolveTemplateBinding(
        binding,
        context.state.inputs,
        context.state.outputs,
        port.key,
        context.node.id,
        port,
      );
    case 'candidate':
      return resolveCandidateBinding(binding, context.state.outputs, port.key, context.node.id);
  }
}

export function createBindingResolver(): BindingResolver {
  return {
    async resolveInputs(context) {
      const { node, nodeType, edges, state } = context;
      const ports = new Map(nodeType.inputs.map((port) => [port.key, port]));
      // 在查找输出和转换静态绑定前检查冲突与目标端口，不定义来源覆盖优先级。
      for (const edge of edges) {
        if (edge.kind !== 'data' || edge.target.nodeId !== node.id) continue;
        if (Object.hasOwn(node.inputs, edge.target.portKey)) {
          throw new BindingResolutionError(
            'INPUT_SOURCE_CONFLICT',
            `输入端口 ${node.id}.${edge.target.portKey} 同时存在静态绑定和数据边`,
            edgeDetails(edge),
          );
        }
        requireInputPort(ports, edgeDetails(edge));
      }

      const staticInputs = Object.entries(node.inputs).map(([inputKey, binding]) => ({
        inputKey,
        binding,
        port: requireInputPort(ports, { nodeId: node.id, inputKey }),
      }));
      const inputs = Object.entries(resolveDataEdgeInputs(node.id, edges, state.outputs));
      for (const { inputKey, binding, port } of staticInputs) {
        // 发布已核对节点 Schema 的可省略性；这里只传播明确 optional 来源的 missing。
        if (
          binding.type === 'workflow_input' &&
          !Object.hasOwn(state.inputs, binding.key) &&
          port.required !== true &&
          context.workflowInputs.some(
            (input) => input.name === binding.key && input.required === false,
          )
        )
          continue;
        inputs.push([inputKey, resolveStaticBinding(binding, port, context)]);
      }
      return Object.fromEntries(inputs);
    },
  };
}
