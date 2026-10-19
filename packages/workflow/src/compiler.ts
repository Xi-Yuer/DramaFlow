import {
  nodeDefinitionSchema,
  workflowIdentifierSchema,
  type NodeDefinition,
} from '@dramaflow/contracts';
import type { GraphNodeReturnValue, LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import {
  invokeNodeOperation,
  parseNodeDefinition,
  type NodeOperation,
  type NodeTypeDefinition,
} from './node.js';

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
  readonly type: string;
  readonly preset?: string;
  compile(
    definition: NodeDefinition,
    context: CompileContext<State, Update>,
  ): LangGraphNode<State, Update>;
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

function compilerKey(type: string, preset?: string): string {
  workflowIdentifierSchema.parse(type);
  if (preset !== undefined) workflowIdentifierSchema.parse(preset);
  return JSON.stringify([type, preset ?? null]);
}

// 显式受信任编译器目录；不加载浏览器代码，不提供默认类型或 Preset 回退。
export class NodeRegistry<State extends object, Update extends object> {
  private readonly compilers = new Map<string, NodeCompiler<State, Update>>();

  constructor(compilers: readonly NodeCompiler<State, Update>[]) {
    for (const compiler of compilers) {
      const key = compilerKey(compiler.type, compiler.preset);
      if (this.compilers.has(key)) {
        throw new NodeCompilationError('duplicate_compiler', `节点编译器重复：${compiler.type}`);
      }
      this.compilers.set(key, compiler);
    }
  }

  compile(
    definitionInput: unknown,
    context: CompileContext<State, Update>,
  ): LangGraphNode<State, Update> {
    const definition = nodeDefinitionSchema.parse(definitionInput);
    const compiler = this.compilers.get(compilerKey(definition.type, definition.preset));
    if (!compiler) {
      throw new NodeCompilationError('unavailable_compiler', '节点类型或 Preset 编译器不可用');
    }
    return compiler.compile(definition, context);
  }
}

// 普通值操作的适配工厂。控制、审核等编译器可直接返回原生 interrupt / Command 节点。
export function createOperationNodeCompiler<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodObject,
  ConfigSchema extends z.ZodObject,
>(
  contract: NodeTypeDefinition<InputSchema, OutputSchema, ConfigSchema>,
  operation: NodeOperation<z.output<InputSchema>, z.output<ConfigSchema>>,
) {
  return {
    type: contract.type,
    preset: contract.preset,
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
