import {
  NumberType,
  isTypeAssignable,
  iterationBodyInputMappingSchema,
  type DataType,
  type IterationBodyInputMapping,
  type IterationCompositeDefinition,
  type NodeDefinition,
} from '@dramaflow/contracts';
import { fail } from '../../inputs/definitions/input-validation';
import { ITERATION_ITEMS_KEY, requireComposite, withComposite } from './composite';

export type BodyInputSourceOption = {
  id: string;
  source: IterationBodyInputMapping['source'];
  dataType: DataType;
  label: string;
};

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

export function dropIncompatibleMappings(
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
