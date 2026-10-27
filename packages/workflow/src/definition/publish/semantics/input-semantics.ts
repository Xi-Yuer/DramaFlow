import {
  isTypeAssignable,
  isSubworkflowNodeManifest,
  StringType,
  type GraphDefinition,
} from '@dramaflow/contracts';
import { isIterationNodeManifest } from '../../../node/builtin/iteration.js';
import { WorkflowInvocationContractValidator } from '../../contract/validate-invocation.js';
import { invalid } from '../publish-issue.js';
import type { ValidatedDefinitionNode } from '../types.js';

export function validateInputSemantics(
  definition: GraphDefinition,
  nodes: ReadonlyMap<string, ValidatedDefinitionNode>,
  entries: readonly ValidatedDefinitionNode[],
): void {
  const workflowInputs = new Map(definition.inputs.map((input) => [input.name, input]));
  for (const { node, nodeType, ports: resolved } of entries) {
    const composite =
      isIterationNodeManifest(nodeType.manifest) || isSubworkflowNodeManifest(nodeType.manifest);
    const acceptsMissing = (key: string) =>
      composite
        ? resolved.inputs.find((port) => port.key === key)?.required === false
        : nodeType.inputSchema.shape[key]!.safeParse(undefined).success;
    const acceptsConstant = (key: string, value: unknown) => {
      if (!composite) return nodeType.inputSchema.shape[key]!.safeParse(value).success;
      const port = resolved.inputs.find((port) => port.key === key)!;
      // 空数组没有待验证的业务元素；显式 itemType 仍决定边界类型。
      if (port.dataType.kind === 'array' && Array.isArray(value) && value.length === 0) return true;
      try {
        new WorkflowInvocationContractValidator().validate(
          [{ name: key, type: port.dataType, required: true }],
          { [key]: { storage: 'inline', type: port.dataType, value } },
        );
        return true;
      } catch {
        return false;
      }
    };
    const ports = new Map(resolved.inputs.map((port) => [port.key, port]));
    const connected = new Set(
      definition.edges
        .filter((edge) => edge.kind === 'data' && edge.target.nodeId === node.id)
        .map((edge) => edge.target.portKey),
    );
    const constants: Record<string, unknown> = {};
    let dynamic = connected.size > 0;
    for (const [key, binding] of Object.entries(node.inputs)) {
      const port = ports.get(key);
      if (!port) invalid('INPUT_PORT_NOT_FOUND', node.id, key);
      if (binding.type === 'asset') invalid('ASSET_BINDING_UNSUPPORTED', node.id, key);
      else if (binding.type === 'candidate') {
        dynamic = true;
        for (const source of binding.sources) {
          const sourceNode = nodes.get(source.nodeId);
          if (!sourceNode) invalid('NODE_TYPE_UNAVAILABLE', source.nodeId);
          const output = sourceNode.ports.outputs.find(
            (outputPort) => outputPort.key === source.portKey,
          );
          if (!output) invalid('OUTPUT_PORT_NOT_FOUND', sourceNode.node.id, source.portKey);
          if (!isTypeAssignable(output.dataType, port.dataType))
            invalid('INPUT_TYPE_MISMATCH', node.id, key);
        }
      } else if (binding.type === 'workflow_input') {
        dynamic = true;
        const source = workflowInputs.get(binding.key)!;
        if (source.required === false && (port.required === true || !acceptsMissing(key)))
          invalid('INPUT_SOURCE_OPTIONAL', node.id, key);
        if (!isTypeAssignable(source.type, port.dataType))
          invalid('INPUT_TYPE_MISMATCH', node.id, key);
      } else if (binding.type === 'template') {
        dynamic = true;
        if (!isTypeAssignable(StringType, port.dataType))
          invalid('INPUT_TYPE_MISMATCH', node.id, key);
        for (const source of Object.values(binding.variables)) {
          if (source.type === 'workflow_input') {
            const input = workflowInputs.get(source.key);
            if (input?.required === false) invalid('INPUT_SOURCE_OPTIONAL', node.id, key);
            if (!input || !isTypeAssignable(input.type, StringType))
              invalid('INPUT_TYPE_MISMATCH', node.id, key);
            continue;
          }
          const sourceNode = nodes.get(source.nodeId);
          if (!sourceNode) invalid('NODE_TYPE_UNAVAILABLE', source.nodeId);
          const output = sourceNode.ports.outputs.find(
            (outputPort) => outputPort.key === source.portKey,
          );
          if (!output) invalid('OUTPUT_PORT_NOT_FOUND', sourceNode.node.id, source.portKey);
          if (!isTypeAssignable(output.dataType, StringType))
            invalid('INPUT_TYPE_MISMATCH', node.id, key);
        }
      } else {
        if (!acceptsConstant(key, binding.value)) invalid('INPUT_VALUE_INVALID', node.id, key);
        constants[key] = binding.value;
      }
    }
    for (const port of ports.values()) {
      if (
        !Object.hasOwn(node.inputs, port.key) &&
        !connected.has(port.key) &&
        !acceptsMissing(port.key)
      )
        invalid('INPUT_SOURCE_MISSING', node.id, port.key);
    }
    // 全部实际输入在发布时已知时，连同跨字段 refine / 默认值按 Runtime 同一 Schema 校验。
    if (!composite && !dynamic && !nodeType.inputSchema.safeParse(constants).success)
      invalid('INPUT_VALUE_INVALID', node.id);
  }
}
