import { dataTypeSchema, type DataType } from './type.js';

function assignable(source: DataType, target: DataType): boolean {
  if (target.kind === 'any') return true;
  // 源 union 的每一种可能都必须能赋给目标，不能只因其中一项相同就放行。
  if (source.kind === 'union') return source.types.every((type) => assignable(type, target));
  if (target.kind === 'union') return target.types.some((type) => assignable(source, type));
  if (source.kind === 'any') return false;
  if (source.kind === 'primitive')
    return target.kind === 'primitive' && source.name === target.name;
  if (source.kind === 'named') return target.kind === 'named' && source.name === target.name;
  if (source.kind === 'array')
    return target.kind === 'array' && assignable(source.itemType, target.itemType);
  return (
    target.kind === 'object' &&
    Object.entries(target.properties).every(
      ([key, type]) =>
        Object.hasOwn(source.properties, key) && assignable(source.properties[key]!, type),
    )
  );
}

export function isTypeAssignable(source: DataType, target: DataType): boolean {
  return assignable(dataTypeSchema.parse(source), dataTypeSchema.parse(target));
}
