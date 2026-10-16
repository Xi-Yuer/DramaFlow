import { Annotation, END, Send, START, StateGraph } from '@langchain/langgraph';
import { jsonObjectSchema } from '@dramaflow/contracts';
import type { JsonObject, JsonValue, WorkflowNode } from '@dramaflow/contracts';
import type { RuntimeHost } from '../types.js';
import { nodeConfigSchemas } from '../catalog.js';
import { WorkflowInputError, WorkflowCanceledError } from '../inputs.js';
import { operationRequest } from './generation.js';

export function createBatchGraph(node: WorkflowNode, host: RuntimeHost) {
  const config = nodeConfigSchemas.batch.parse(node.config);
  const BatchState = Annotation.Root({
    runId: Annotation<string>,
    attemptId: Annotation<string>,
    items: Annotation<JsonValue[]>,
    item: Annotation<JsonValue>,
    itemId: Annotation<string>,
    results: Annotation<Record<string, JsonObject>>({
      reducer: (left, right) => ({ ...left, ...right }),
      default: () => ({}),
    }),
    output: Annotation<JsonValue[]>,
  });
  const graph = new StateGraph(BatchState)
    .addNode('prepare', (state) => {
      if (state.items.length > config.maxItems)
        throw new WorkflowInputError(
          'BATCH_LIMIT_EXCEEDED',
          `批量输入不得超过 ${config.maxItems} 项`,
        );
      return {};
    })
    .addNode('executeItem', async (state, runtimeConfig) => {
      if (await host.isCancelled(state.runId)) throw new WorkflowCanceledError();
      const request = operationRequest(
        node,
        state,
        { item: state.item },
        runtimeConfig.signal,
        state.itemId,
      );
      const result = jsonObjectSchema.parse(await host.executeOperation(request));
      return { results: { [state.itemId]: result } };
    })
    .addNode('collect', (state) => ({
      output: state.items.map((_, index) => {
        const result = state.results[String(index)];
        if (!result)
          throw new WorkflowInputError('BATCH_RESULT_MISSING', `批量条目 ${index} 缺少结果`);
        return result;
      }),
    }))
    .addEdge(START, 'prepare')
    .addConditionalEdges('prepare', (state) =>
      state.items.length === 0
        ? 'collect'
        : state.items.map(
            (item, index) =>
              new Send('executeItem', {
                runId: state.runId,
                attemptId: state.attemptId,
                item,
                itemId: String(index),
              }),
          ),
    )
    .addEdge('executeItem', 'collect')
    .addEdge('collect', END);
  return graph.compile();
}
