import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import {
  RunnableLambda,
  type RunnableConfig,
  type RunnableInterface,
} from '@langchain/core/runnables';
import {
  jsonObjectSchema,
  workflowDefinitionSchema,
  workflowDependencies,
  type WorkflowDefinition,
  type JsonObject,
} from '@dramaflow/contracts';
import { NodeRegistry, type NodeExecutor, type NodeExecutionInput } from './registry.js';

const State = Annotation.Root({
  results: Annotation<Record<string, JsonObject>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
});
/** 将任意 LangChain Runnable 接入节点；提供者、模型与凭证仍由插件负责。 */
export function executorFromRunnable(
  runnable: RunnableInterface<NodeExecutionInput, JsonObject>,
): NodeExecutor {
  return async (input, config) => jsonObjectSchema.parse(await runnable.invoke(input, config));
}
/** 当前仅编译静态 DAG。条件路由、暂停、持久化 checkpoint 与外部副作用后续独立接入。 */
export function compileWorkflow(rawDefinition: WorkflowDefinition, registry: NodeRegistry) {
  const definition = workflowDefinitionSchema.parse(rawDefinition);
  const issues = registry.validate(definition);
  if (issues.length) throw new Error(issues.map((i) => i.message).join('；'));
  if (!definition.nodes.length) throw new Error('空画布不能执行');
  // 编译时冻结定义和执行器，调用方之后的草稿/注册表修改不影响已编译图。
  const registrations = new Map(
    definition.nodes.map((node) => {
      const registration = registry.get(node);
      if (!registration.executor) throw new Error(`节点尚未提供执行能力：${node.title}`);
      return [node.id, registration];
    }),
  );
  const builder = new StateGraph<typeof State, typeof State.State, typeof State.Update, string>(
    State,
  );
  const dependencies = workflowDependencies(definition);
  for (const node of definition.nodes) {
    const registration = registrations.get(node.id)!;
    const execute = registration.executor!;
    const runnable = RunnableLambda.from(
      async (state: typeof State.State, config?: RunnableConfig) => {
        const inputs: JsonObject = {};
        for (const binding of definition.bindings.filter((b) => b.target.nodeId === node.id)) {
          const value = state.results[binding.source.nodeId]?.[binding.source.port];
          if (value !== undefined) inputs[binding.target.port] = value;
        }
        for (const port of registration.definition.inputs) {
          if (port.required && inputs[port.id] === undefined)
            throw new Error(`节点 ${node.title} 缺少必需输入：${port.label}`);
          if (inputs[port.id] !== undefined)
            validatePort(port.kind, inputs[port.id], `${node.title}.${port.id}`);
        }
        const output = jsonObjectSchema.parse(await execute({ node, inputs }, config ?? {}));
        const declared = new Set(registration.definition.outputs.map((p) => p.id));
        for (const key of Object.keys(output))
          if (!declared.has(key)) throw new Error(`节点 ${node.title} 返回未声明输出：${key}`);
        for (const port of registration.definition.outputs) {
          if (port.required && output[port.id] === undefined)
            throw new Error(`节点 ${node.title} 未返回必需输出：${port.label}`);
          if (output[port.id] !== undefined)
            validatePort(port.kind, output[port.id], `${node.title}.${port.id}`);
        }
        return { results: { [node.id]: output } };
      },
    );
    builder.addNode(node.id, runnable);
  }
  for (const [id, deps] of dependencies) {
    // 数组源边是静态 barrier，避免不同路径长度的并行汇合提前或重复运行。
    if (deps.size) builder.addEdge([...deps], id);
    else builder.addEdge(START, id);
    if (![...dependencies.values()].some((set) => set.has(id))) builder.addEdge(id, END);
  }
  return builder.compile();
}
function validatePort(kind: string, value: unknown, label: string) {
  if (kind === 'json') return;
  if (kind === 'asset') {
    if (
      typeof value === 'object' &&
      value !== null &&
      'assetId' in value &&
      typeof value.assetId === 'string' &&
      'version' in value &&
      Number.isInteger(value.version)
    )
      return;
  } else if (
    typeof value ===
    ({ text: 'string', number: 'number', boolean: 'boolean' } as Record<string, string>)[kind]
  )
    return;
  throw new Error(`端口数据类型错误：${label}（${kind}）`);
}
