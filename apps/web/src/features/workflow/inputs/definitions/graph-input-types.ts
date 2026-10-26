import {
  BooleanType,
  NumberType,
  StringType,
  dataTypeSchema,
  type DataType,
} from '@dramaflow/contracts';

const stringList = { kind: 'array' as const, itemType: StringType };
const numberList = { kind: 'array' as const, itemType: NumberType };

export const graphInputTypeChoices: readonly { id: string; label: string; type: DataType }[] = [
  { id: 'string', label: '文本', type: StringType },
  { id: 'number', label: '数字', type: NumberType },
  { id: 'boolean', label: '布尔', type: BooleanType },
  { id: 'string[]', label: '文本列表', type: stringList },
  { id: 'number[]', label: '数字列表', type: numberList },
];

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
