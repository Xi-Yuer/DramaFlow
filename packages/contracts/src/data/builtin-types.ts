import type { AnyDataType, NamedDataType, PrimitiveDataType } from './type.js';

export const AnyType = Object.freeze({ kind: 'any' } satisfies AnyDataType);
export const StringType = Object.freeze({
  kind: 'primitive',
  name: 'string',
} satisfies PrimitiveDataType);
export const NumberType = Object.freeze({
  kind: 'primitive',
  name: 'number',
} satisfies PrimitiveDataType);
export const BooleanType = Object.freeze({
  kind: 'primitive',
  name: 'boolean',
} satisfies PrimitiveDataType);
export const NullType = Object.freeze({
  kind: 'primitive',
  name: 'null',
} satisfies PrimitiveDataType);
export const JsonType = Object.freeze({
  kind: 'named',
  name: 'system.json',
} satisfies NamedDataType);
export const FileType = Object.freeze({
  kind: 'named',
  name: 'media.file',
} satisfies NamedDataType);
export const ImageType = Object.freeze({
  kind: 'named',
  name: 'media.image',
} satisfies NamedDataType);
export const VideoType = Object.freeze({
  kind: 'named',
  name: 'media.video',
} satisfies NamedDataType);
export const AudioType = Object.freeze({
  kind: 'named',
  name: 'media.audio',
} satisfies NamedDataType);
export const DocumentType = Object.freeze({
  kind: 'named',
  name: 'media.document',
} satisfies NamedDataType);
