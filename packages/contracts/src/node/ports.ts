import { NumberType } from '../data/builtin-types.js';
import { isTypeAssignable } from '../data/compatibility.js';
import type { DataType } from '../data/type.js';
import type { NodeDefinition } from './definition.js';
import type { InputPortDefinition, OutputPortDefinition, NodeTypeManifest } from './manifest.js';
import { isIterationNodeManifest } from './iteration.js';

export interface ResolvedNodePorts {
  readonly inputs: readonly InputPortDefinition[];
  readonly outputs: readonly OutputPortDefinition[];
}
export class CompositeDefinitionError extends Error {
  constructor(
    readonly code:
      | 'ITERATION_DEFINITION_REQUIRED'
      | 'ITERATION_ITEM_TYPE_UNRESOLVED'
      | 'ITERATION_INPUT_DUPLICATE'
      | 'BODY_INPUT_UNKNOWN'
      | 'BODY_INPUT_DUPLICATE'
      | 'BODY_INPUT_REQUIRED'
      | 'BODY_SOURCE_UNKNOWN'
      | 'BODY_INPUT_TYPE_MISMATCH'
      | 'BODY_SOURCE_OPTIONAL',
    readonly portKey?: string,
  ) {
    super(`Iteration 边界无效：${code}`);
    this.name = 'CompositeDefinitionError';
  }
}

// 静态 Manifest 是普通节点端口权威；正式 composite 结合受校验的实例推导。
export function resolveNodePorts(
  node: NodeDefinition,
  manifest: NodeTypeManifest,
): ResolvedNodePorts {
  if (node.type !== manifest.type || node.typeVersion !== manifest.version)
    throw new Error('节点与端口声明版本不匹配');
  if (!isIterationNodeManifest(manifest))
    return { inputs: manifest.inputs, outputs: manifest.outputs };
  const composite = node.composite;
  if (!composite) throw new CompositeDefinitionError('ITERATION_DEFINITION_REQUIRED');
  const inputs: InputPortDefinition[] = [
    {
      key: 'items',
      name: '集合',
      dataType: { kind: 'array', itemType: composite.itemType },
      required: true,
    },
    ...composite.invariantInputs.map((input) => ({
      key: input.name,
      name: input.name,
      dataType: input.type,
      required: input.required,
    })),
  ];
  const names = new Set<string>();
  for (const input of inputs) {
    if (names.has(input.key))
      throw new CompositeDefinitionError('ITERATION_INPUT_DUPLICATE', input.key);
    names.add(input.key);
  }
  return {
    inputs,
    outputs: composite.body.outputs.map((output) => ({
      key: output.name,
      name: output.name,
      dataType: { kind: 'array', itemType: output.type },
    })),
  };
}

export function validateIterationInputMapping(
  node: NodeDefinition,
  ports: ResolvedNodePorts,
): void {
  const composite = node.composite;
  if (!composite) throw new CompositeDefinitionError('ITERATION_DEFINITION_REQUIRED');
  if (composite.itemType.kind === 'any')
    throw new CompositeDefinitionError('ITERATION_ITEM_TYPE_UNRESOLVED', 'items');
  const targets = new Map(composite.body.inputs.map((input) => [input.name, input]));
  const inputs = new Map(ports.inputs.map((input) => [input.key, input]));
  const seen = new Set<string>();
  for (const mapping of composite.bodyInputMapping) {
    const target = targets.get(mapping.target);
    if (!target) throw new CompositeDefinitionError('BODY_INPUT_UNKNOWN', mapping.target);
    if (seen.has(mapping.target))
      throw new CompositeDefinitionError('BODY_INPUT_DUPLICATE', mapping.target);
    seen.add(mapping.target);
    let type: DataType;
    const source = mapping.source;
    if (source.type === 'current_item') type = composite.itemType;
    else if (source.type === 'current_index') type = NumberType;
    else {
      const input = inputs.get(source.key);
      if (!input) throw new CompositeDefinitionError('BODY_SOURCE_UNKNOWN', source.key);
      if (target.required && input.required !== true)
        throw new CompositeDefinitionError('BODY_SOURCE_OPTIONAL', source.key);
      type = input.dataType;
    }
    if (!isTypeAssignable(type, target.type))
      throw new CompositeDefinitionError('BODY_INPUT_TYPE_MISMATCH', target.name);
  }
  for (const target of targets.values())
    if (target.required && !seen.has(target.name))
      throw new CompositeDefinitionError('BODY_INPUT_REQUIRED', target.name);
}
