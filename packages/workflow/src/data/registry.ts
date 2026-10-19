import {
  dataTypeManifestSchema,
  dataTypeSchema,
  type DataType,
  type DataTypeManifest,
} from '@dramaflow/contracts';
import { z } from 'zod';

export interface DataTypeDefinition<Value = unknown> {
  readonly manifest: DataTypeManifest;
  readonly schema: z.ZodType<Value>;
}

// Named 类型的真实值契约仅在服务端存在，公开列表只返回 Manifest 副本。
export class DataTypeRegistry {
  private readonly definitions = new Map<string, DataTypeDefinition>();
  register(definition: DataTypeDefinition): void {
    const manifest = dataTypeManifestSchema.parse(definition.manifest);
    if (this.definitions.has(manifest.name)) throw new Error('数据类型已注册');
    this.definitions.set(manifest.name, { manifest, schema: definition.schema });
  }
  get(name: string): DataTypeDefinition {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`数据类型不可用：${name}`);
    return {
      manifest: dataTypeManifestSchema.parse(definition.manifest),
      schema: definition.schema,
    };
  }
  listManifests(): DataTypeManifest[] {
    return [...this.definitions.values()].map((definition) =>
      dataTypeManifestSchema.parse(definition.manifest),
    );
  }
  schemaFor(input: DataType): z.ZodType {
    const type = dataTypeSchema.parse(input);
    switch (type.kind) {
      case 'any':
        return z.json();
      case 'primitive':
        switch (type.name) {
          case 'string':
            return z.string();
          case 'number':
            return z.number().finite();
          case 'boolean':
            return z.boolean();
          case 'null':
            return z.null();
        }
        break;
      case 'named':
        return this.get(type.name).schema;
      case 'array':
        return z.array(this.schemaFor(type.itemType));
      case 'object':
        return z
          .object(
            Object.fromEntries(
              Object.entries(type.properties).map(([key, value]) => [key, this.schemaFor(value)]),
            ),
          )
          .passthrough();
      case 'union':
        return z.union(type.types.map((value) => this.schemaFor(value)));
    }
  }
  parse(type: DataType, input: unknown): z.JSONType {
    const parsed = this.schemaFor(type).parse(z.json().parse(input));
    return z.json().parse(parsed);
  }
}
