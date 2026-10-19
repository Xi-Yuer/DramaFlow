import {
  nodeTypeIdSchema,
  nodeTypeVersionSchema,
  type NodeTypeManifest,
} from '@dramaflow/contracts';
import { z } from 'zod';
import type { NodeType, NodeDeclaration } from './type.js';
import { assertNodeSchemas, parseNodeManifest, type NodeSchemas } from './schemas.js';
import type { NodeOperation } from './operation.js';
import type { NodeExecutionContext } from '../runtime/node-executor.js';
export class NodeRegistrationError extends Error {
  constructor(
    public readonly code: 'duplicate_type' | 'unavailable_type',
    message: string,
  ) {
    super(message);
    this.name = 'NodeRegistrationError';
  }
}
function typeKey(type: string, version: number): string {
  nodeTypeIdSchema.parse(type);
  nodeTypeVersionSchema.parse(version);
  return JSON.stringify([type, version]);
}

function freezeManifest(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeManifest(child);
  Object.freeze(value);
}

function lockManifest(nodeType: NodeDeclaration, manifest: NodeTypeManifest): NodeTypeManifest {
  const property = Object.getOwnPropertyDescriptor(nodeType, 'manifest');
  if (property?.configurable === false) {
    if (!('value' in property) || property.writable !== false)
      throw new TypeError('节点实现的 manifest 必须是稳定的数据字段');
    freezeManifest(nodeType.manifest);
    return nodeType.manifest;
  }
  freezeManifest(manifest);
  Object.defineProperty(nodeType, 'manifest', {
    value: manifest,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  return manifest;
}

export class NodeRegistry {
  private readonly types = new Map<string, NodeDeclaration>();
  constructor(types: readonly NodeDeclaration[] = []) {
    for (const nodeType of types) this.register(nodeType);
  }
  register(nodeType: NodeDeclaration): void {
    const manifest = parseNodeManifest(nodeType.manifest);
    assertNodeSchemas(manifest, nodeType);
    if ((manifest.executionKind === 'action') !== (typeof nodeType.execute === 'function'))
      throw new Error('action 必须提供 execute，其他执行种类使用独立编译策略');
    const key = typeKey(manifest.type, manifest.version);
    if (this.types.has(key))
      throw new NodeRegistrationError('duplicate_type', '节点类型版本已注册');
    this.types.set(key, {
      manifest: lockManifest(nodeType, manifest),
      inputSchema: nodeType.inputSchema,
      outputSchema: nodeType.outputSchema,
      configSchema: nodeType.configSchema,
      ...(nodeType.execute ? { execute: nodeType.execute.bind(nodeType) } : {}),
    });
  }
  get(type: string, version: number): NodeDeclaration {
    const nodeType = this.types.get(typeKey(type, version));
    if (!nodeType) throw new NodeRegistrationError('unavailable_type', '节点类型版本不可用');
    return { ...nodeType, manifest: parseNodeManifest(nodeType.manifest) };
  }
  getAction(type: string, version: number): NodeType {
    const entry = this.get(type, version);
    if (entry.manifest.executionKind !== 'action' || !entry.execute)
      throw new Error('该类型不是普通操作节点');
    return { ...entry, execute: entry.execute };
  }
  listManifests(): NodeTypeManifest[] {
    return [...this.types.values()].map((nodeType) => parseNodeManifest(nodeType.manifest));
  }
}

// 显式普通操作工厂；不编译图、不解析绑定、不存储产物。
export function createOperationNodeType<
  I extends z.ZodObject,
  O extends z.ZodObject,
  C extends z.ZodObject,
>(
  input: NodeTypeManifest,
  schemas: NodeSchemas<I, O, C>,
  operation: NodeOperation<z.output<I>, z.output<C>>,
) {
  const manifest = parseNodeManifest(input);
  assertNodeSchemas(manifest, schemas);
  if (manifest.executionKind !== 'action') throw new Error('普通操作只支持 action');
  return {
    manifest,
    ...schemas,
    async execute(inputs: z.output<I>, config: z.output<C>, context: NodeExecutionContext) {
      return operation({ inputs, config }, context.runnableConfig);
    },
  };
}
