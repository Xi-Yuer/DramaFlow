import {
  nodeDefinitionSchema,
  nodeTypeIdSchema,
  nodeTypeVersionSchema,
  type NodeDefinition,
  type NodeTypeManifest,
} from '@dramaflow/contracts';
import type { GraphNodeReturnValue, LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import { invokeNodeOperation, parseNodeDefinition, type NodeOperation } from './node.js';
import { assertNodeSchemas, parseNodeManifest, type NodeSchemas } from './node-type.js';

// State/Binding 模型尚未确定；这些泛型接口只适配本节点，不提供 Graph builder 或调度器。
export type LangGraphNode<State extends object, Update extends object> = (
  state: State,
  runnableConfig: LangGraphRunnableConfig<Record<string, unknown>>,
) => GraphNodeReturnValue<Update>;

export interface CompileContext<State extends object, Update extends object> {
  readInputs(
    state: State,
    definition: NodeDefinition,
    runnableConfig: LangGraphRunnableConfig<Record<string, unknown>>,
  ): unknown;
  writeOutputs(
    definition: NodeDefinition,
    outputs: Readonly<Record<string, z.JSONType>>,
    runnableConfig: LangGraphRunnableConfig<Record<string, unknown>>,
  ): Update;
}

export interface NodeCompiler<State extends object, Update extends object> {
  compile(
    definition: NodeDefinition,
    context: CompileContext<State, Update>,
  ): LangGraphNode<State, Update>;
}

export interface NodeType<
  State extends object,
  Update extends object,
  InputSchema extends z.ZodObject = z.ZodObject,
  OutputSchema extends z.ZodObject = z.ZodObject,
  ConfigSchema extends z.ZodObject = z.ZodObject,
>
  extends NodeCompiler<State, Update>, NodeSchemas<InputSchema, OutputSchema, ConfigSchema> {
  readonly manifest: NodeTypeManifest;
}

export class NodeCompilationError extends Error {
  constructor(
    public readonly code: 'duplicate_type' | 'unavailable_type',
    message: string,
  ) {
    super(message);
    this.name = 'NodeCompilationError';
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

// 注册后将实现读取的 manifest 固定为只读快照，同时保留类实例的 this / 私有依赖。
function lockManifest<State extends object, Update extends object>(
  nodeType: NodeType<State, Update>,
  manifest: NodeTypeManifest,
): NodeTypeManifest {
  const property = Object.getOwnPropertyDescriptor(nodeType, 'manifest');
  if (property?.configurable === false) {
    if (!('value' in property) || property.writable !== false) {
      throw new TypeError('节点实现的 manifest 必须是稳定的数据字段');
    }
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

export class NodeRegistry<State extends object, Update extends object> {
  private readonly types = new Map<string, NodeType<State, Update>>();
  constructor(types: readonly NodeType<State, Update>[] = []) {
    for (const nodeType of types) this.register(nodeType);
  }
  register(nodeType: NodeType<State, Update>): void {
    const manifest = parseNodeManifest(nodeType.manifest);
    assertNodeSchemas(manifest, nodeType);
    const key = typeKey(manifest.type, manifest.version);
    if (this.types.has(key)) throw new NodeCompilationError('duplicate_type', '节点类型版本已注册');
    this.types.set(key, {
      manifest: lockManifest(nodeType, manifest),
      inputSchema: nodeType.inputSchema,
      outputSchema: nodeType.outputSchema,
      configSchema: nodeType.configSchema,
      compile: nodeType.compile.bind(nodeType),
    });
  }
  get(type: string, version: number): NodeType<State, Update> {
    const nodeType = this.types.get(typeKey(type, version));
    if (!nodeType) throw new NodeCompilationError('unavailable_type', '节点类型版本不可用');
    return { ...nodeType, manifest: parseNodeManifest(nodeType.manifest) };
  }
  listManifests(): NodeTypeManifest[] {
    return [...this.types.values()].map((nodeType) => parseNodeManifest(nodeType.manifest));
  }
  compile(input: unknown, context: CompileContext<State, Update>): LangGraphNode<State, Update> {
    const definition = nodeDefinitionSchema.parse(input);
    return this.get(definition.type, definition.typeVersion).compile(definition, context);
  }
}

// 保留已验证的普通值操作适配；不会解析 Binding、选择插件或实现 WorkflowState。
export function createOperationNodeType<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodObject,
  ConfigSchema extends z.ZodObject,
>(
  manifestInput: NodeTypeManifest,
  schemas: NodeSchemas<InputSchema, OutputSchema, ConfigSchema>,
  operation: NodeOperation<z.output<InputSchema>, z.output<ConfigSchema>>,
) {
  const manifest = Object.freeze(parseNodeManifest(manifestInput));
  assertNodeSchemas(manifest, schemas);
  const contract = { type: manifest.type, version: manifest.version, ...schemas };
  return {
    manifest,
    inputSchema: schemas.inputSchema,
    outputSchema: schemas.outputSchema,
    configSchema: schemas.configSchema,
    compile<State extends object, Update extends object>(
      definition: NodeDefinition,
      context: CompileContext<State, Update>,
    ): LangGraphNode<State, Update> {
      const node = parseNodeDefinition(contract, definition);
      return async (state, runnableConfig) => {
        const outputs = await invokeNodeOperation(
          contract,
          { inputs: context.readInputs(state, node, runnableConfig), config: node.config },
          operation,
          runnableConfig,
        );
        return context.writeOutputs(
          node,
          z.record(z.string(), z.json()).parse(outputs),
          runnableConfig,
        );
      };
    },
  };
}
