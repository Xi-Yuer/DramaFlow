import { StringType, dataTypeSchema, type NodeDefinition } from '@dramaflow/contracts';
import {
  parseInput,
  parsePortName,
  uniqueName,
  type GraphInputPatch,
} from '../../inputs/definitions/input-validation';
import { ITERATION_ITEMS_KEY, requireComposite, withComposite } from './composite';
import { dropIncompatibleMappings } from './body-input-mapping';

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
