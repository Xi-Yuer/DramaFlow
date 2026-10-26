import {
  StringType,
  dataTypeSchema,
  type DataType,
  type NodeDefinition,
  type NodeTypeManifest,
} from '@dramaflow/contracts';
import {
  parseInput,
  parsePortName,
  uniqueName,
  type GraphInputPatch,
} from '../../inputs/definitions/input-validation';
import {
  rewriteGraphBindings,
  clearIncompatibleBindings,
} from '../../inputs/bindings/graph-input-bindings';
import { requireComposite, withComposite } from './composite';
import { dropIncompatibleMappings } from './body-input-mapping';

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
