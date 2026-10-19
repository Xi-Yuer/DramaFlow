import { dataTypeSchema, type DataType } from '@dramaflow/contracts';

function matches(source: DataType, target: DataType): boolean {
  // any 只放宽编辑器静态连线检查；实际值仍必须通过服务端 Zod。
  if (source.kind === 'any' || target.kind === 'any') return true;
  if (source.kind === 'array') {
    return target.kind === 'array' && matches(source.item, target.item);
  }
  if (source.kind === 'domain') {
    return target.kind === 'domain' && source.name === target.name;
  }
  return source.kind === target.kind;
}

// 当前只支持显式类型的结构匹配，不做值校验、媒体转换或隐式类型提升。
export function isDataTypeAssignable(source: DataType, target: DataType): boolean {
  return matches(dataTypeSchema.parse(source), dataTypeSchema.parse(target));
}
