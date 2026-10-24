import {
  containsMediaDataType,
  containsInlineMediaValue,
  dataTypeSchema,
  isTypeAssignable,
  runtimeValueSchema,
  type ArrayDataType,
  type DataType,
  type RuntimeValue,
} from '@dramaflow/contracts';
import type { RuntimeValueCodec, RuntimeValueDecodeContext } from './runtime-value-codec.js';

export class RuntimeCollectionError extends Error {
  constructor(
    readonly code:
      | 'NOT_ARRAY'
      | 'INVALID_CONTAINER'
      | 'INDEX_OUT_OF_BOUNDS'
      | 'DUPLICATE_INDEX'
      | 'MISSING_INDEX'
      | 'ELEMENT_TYPE_MISMATCH'
      | 'MEDIA_REFERENCE_REQUIRED',
  ) {
    super(`集合运行值错误：${code}`);
    this.name = 'RuntimeCollectionError';
  }
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function fixedValue(value: RuntimeValue): RuntimeValue {
  // Schema parse 复制 JSON，随后冻结；不冻结或修改调用方的原对象。
  return freezeJson(runtimeValueSchema.parse(value));
}
function checkIndex(index: number, length: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length)
    throw new RuntimeCollectionError('INDEX_OUT_OF_BOUNDS');
}
function sameType(left: DataType, right: DataType): boolean {
  // Schema 不含运行对象；按键排序后比较，防止窄元素类型在 inline 优化中丢失。
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
        .join(',')}}`;
    return JSON.stringify(value);
  };
  return canonical(left) === canonical(right);
}

export class RuntimeCollectionSnapshot {
  readonly length: number;
  readonly type: ArrayDataType;
  readonly #elements: readonly RuntimeValue[];

  private constructor(type: ArrayDataType, elements: readonly RuntimeValue[]) {
    this.type = freezeJson({ kind: 'array', itemType: dataTypeSchema.parse(type.itemType) });
    this.#elements = Object.freeze(elements.map(fixedValue));
    this.length = this.#elements.length;
    Object.freeze(this);
  }

  static async create(
    value: RuntimeValue,
    codec: Pick<RuntimeValueCodec, 'decode'>,
    context: RuntimeValueDecodeContext,
  ): Promise<RuntimeCollectionSnapshot> {
    // 固定来源后再 await，调用方修改来源不影响本次读取。
    const source = fixedValue(value);
    if (source.type.kind !== 'array') throw new RuntimeCollectionError('NOT_ARRAY');
    if (source.storage === 'collection')
      return new RuntimeCollectionSnapshot(source.type, source.elements);
    if (
      containsMediaDataType(source.type.itemType) &&
      (source.storage !== 'inline' || containsInlineMediaValue(source.type, source.value))
    )
      throw new RuntimeCollectionError('MEDIA_REFERENCE_REQUIRED');
    const raw = source.storage === 'inline' ? source.value : await codec.decode(source, context);
    if (!Array.isArray(raw)) throw new RuntimeCollectionError('INVALID_CONTAINER');
    // 整体 reference 指向业务 JSON 数组，绝不将 envelope-shaped JSON 猜成引用。
    const itemType = source.type.itemType;
    const elements = raw.map((item): RuntimeValue => ({
      storage: 'inline',
      type: itemType,
      value: item,
    }));
    return new RuntimeCollectionSnapshot(source.type, elements);
  }

  // 持久化这个纯 JSON 运行表示；恢复后 create 不再读取原始 reference 容器。
  toRuntimeValue(): RuntimeValue {
    return fixedValue({ storage: 'collection', type: this.type, elements: [...this.#elements] });
  }

  get(index: number): RuntimeValue {
    checkIndex(index, this.length);
    return this.#elements[index]!;
  }
}

export class OrderedRuntimeCollectionBuilder {
  readonly #type: ArrayDataType;
  readonly #length: number;
  readonly #elements = new Map<number, RuntimeValue>();

  constructor(itemType: DataType, length: number) {
    if (!Number.isSafeInteger(length) || length < 0)
      throw new RuntimeCollectionError('INDEX_OUT_OF_BOUNDS');
    this.#type = freezeJson({ kind: 'array', itemType: dataTypeSchema.parse(itemType) });
    this.#length = length;
  }

  add(index: number, value: RuntimeValue): void {
    checkIndex(index, this.#length);
    if (this.#elements.has(index)) throw new RuntimeCollectionError('DUPLICATE_INDEX');
    const element = fixedValue(value);
    if (element.storage === 'inline' && containsInlineMediaValue(element.type, element.value))
      throw new RuntimeCollectionError('MEDIA_REFERENCE_REQUIRED');
    if (!isTypeAssignable(element.type, this.#type.itemType))
      throw new RuntimeCollectionError('ELEMENT_TYPE_MISMATCH');
    this.#elements.set(index, element);
  }

  build(): RuntimeValue {
    if (this.#elements.size !== this.#length) throw new RuntimeCollectionError('MISSING_INDEX');
    const elements = Array.from({ length: this.#length }, (_, index) => this.#elements.get(index)!);
    if (
      elements.every(
        (element) => element.storage === 'inline' && sameType(element.type, this.#type.itemType),
      )
    ) {
      return fixedValue({
        storage: 'inline',
        type: this.#type,
        value: elements.map((element) => {
          if (element.storage !== 'inline') throw new Error('集合内联条件不成立');
          return element.value;
        }),
      });
    }
    return fixedValue({ storage: 'collection', type: this.#type, elements });
  }
}
