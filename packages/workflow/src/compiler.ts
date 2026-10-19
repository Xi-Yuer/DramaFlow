import {
  nodeDefinitionSchema,
  nodeTypeIdSchema,
  nodeTypeVersionSchema,
  workflowIdentifierSchema,
  type NodeDefinition,
} from '@dramaflow/contracts';
import type { GraphNodeReturnValue, LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import { invokeNodeOperation, parseNodeDefinition, type NodeOperation } from './node.js';
import {
  assertNodePortSchemas,
  parseNodeTypeDefinition,
  type NodeTypeDefinition,
  type NodeValueSchemas,
} from './node-type.js';

// 不预设第四步的 State 结构；使用 LangGraph 的配置及返回值协议，允许原生 Command。
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

export interface NodeType<State extends object, Update extends object> extends NodeCompiler<
  State,
  Update
> {
  readonly definition: NodeTypeDefinition;
  readonly preset?: string;
}

export class NodeCompilationError extends Error {
  constructor(
    public readonly code: 'duplicate_compiler' | 'unavailable_compiler',
    message: string,
  ) {
    super(message);
    this.name = 'NodeCompilationError';
  }
}

function compilerKey(type: string, version: number, preset?: string): string {
  nodeTypeIdSchema.parse(type);
  nodeTypeVersionSchema.parse(version);
  if (preset !== undefined) workflowIdentifierSchema.parse(preset);
  return JSON.stringify([type, version, preset ?? null]);
}

// 显式受信任类型目录；身份只来自 definition，不加载浏览器代码或隐式回退。
export class NodeRegistry<State extends object, Update extends object> {
  private readonly types = new Map<string, NodeType<State, Update>>();

  constructor(types: readonly NodeType<State, Update>[] = []) {
    for (const nodeType of types) this.register(nodeType);
  }

  register(nodeType: NodeType<State, Update>): void {
    const definition = parseNodeTypeDefinition(nodeType.definition);
    const key = compilerKey(definition.type, definition.version, nodeType.preset);
    if (this.types.has(key)) {
      throw new NodeCompilationError('duplicate_compiler', `节点类型重复：${definition.type}`);
    }
    this.types.set(key, {
      definition: Object.freeze(definition),
      preset: nodeType.preset,
      compile: nodeType.compile.bind(nodeType),
    });
  }

  get(type: string, version: number, preset?: string): NodeType<State, Update> {
    const nodeType = this.types.get(compilerKey(type, version, preset));
    if (!nodeType) {
      throw new NodeCompilationError('unavailable_compiler', '节点类型或 Preset 不可用');
    }
    return {
      definition: parseNodeTypeDefinition(nodeType.definition),
      preset: nodeType.preset,
      compile: nodeType.compile,
    };
  }

  compile(
    definitionInput: unknown,
    context: CompileContext<State, Update>,
  ): LangGraphNode<State, Update> {
    const definition = nodeDefinitionSchema.parse(definitionInput);
    return this.get(definition.type, definition.typeVersion, definition.preset).compile(
      definition,
      context,
    );
  }
}

// 普通值操作的适配工厂。控制、审核等编译器可直接返回原生 interrupt / Command 节点。
export function createOperationNodeType<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodObject,
  ConfigSchema extends z.ZodObject,
>(
  definitionInput: NodeTypeDefinition<ConfigSchema>,
  schemas: NodeValueSchemas<InputSchema, OutputSchema> & { preset?: string },
  operation: NodeOperation<z.output<InputSchema>, z.output<ConfigSchema>>,
) {
  const definition = Object.freeze(parseNodeTypeDefinition(definitionInput));
  assertNodePortSchemas(definition, schemas);
  const contract = {
    type: definition.type,
    version: definition.version,
    preset: schemas.preset,
    inputSchema: schemas.inputSchema,
    outputSchema: schemas.outputSchema,
    configSchema: definition.configSchema,
  };
  return {
    definition,
    preset: schemas.preset,
    compile<State extends object, Update extends object>(
      nodeDefinition: NodeDefinition,
      context: CompileContext<State, Update>,
    ): LangGraphNode<State, Update> {
      const node = parseNodeDefinition(contract, nodeDefinition);
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
