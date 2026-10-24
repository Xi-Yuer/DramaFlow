import {
  Annotation,
  StateGraph,
  Send,
  START,
  END,
  MemorySaver,
  openSaver,
  versions,
} from './dependencies.ts';

// 最小复现不包含 wrapper、subgraph、业务 reducer、重试、DramaFlow Runtime。
// node repro-max-concurrency.ts 1 memory
// node repro-max-concurrency.ts 1 postgres（需由主实验提供隔离库连接）
export async function reproduce(maxConcurrency: number, storage: 'memory' | 'postgres') {
  const executed: number[] = [];
  const State = Annotation.Root({
    items: Annotation<number[]>(),
    values: Annotation<number[]>({
      reducer: (left, right) => [...left, ...right],
      default: () => [],
    }),
  });
  const saver = storage === 'postgres' ? openSaver() : new MemorySaver();
  const graph = new StateGraph(State)
    .addNode('dispatch', () => ({}))
    .addNode('item', (state: { index: number }) => {
      executed.push(state.index);
      return { values: [state.index] };
    })
    .addNode('collect', () => ({}))
    .addEdge(START, 'dispatch')
    .addConditionalEdges(
      'dispatch',
      (state) => state.items.map((index) => new Send('item', { index })),
      ['item'],
    )
    .addEdge('item', 'collect')
    .addEdge('collect', END)
    .compile({ checkpointer: saver });
  const config = {
    configurable: {
      thread_id: `iteration-experiment-repro-${storage}-${maxConcurrency}-${crypto.randomUUID()}`,
    },
    maxConcurrency,
    recursionLimit: 6,
    signal: AbortSignal.timeout(2000),
  };
  let outcome: unknown;
  try {
    try {
      outcome = {
        status: 'returned',
        value: await graph.invoke({ items: [0, 1], values: [] }, config),
      };
    } catch (error) {
      outcome = {
        status: 'threw',
        error:
          error instanceof Error ? { name: error.name, message: error.message } : String(error),
      };
    }
    const snapshot = await graph.getState(config);
    return {
      versions,
      storage,
      maxConcurrency,
      threadId: config.configurable.thread_id,
      executed,
      outcome,
      next: snapshot.next,
      tasks: snapshot.tasks.map((task) => ({
        id: task.id,
        name: task.name,
        error: task.error,
        interrupts: task.interrupts,
      })),
      values: snapshot.values as unknown,
    };
  } finally {
    if (storage === 'postgres') await (saver as ReturnType<typeof openSaver>).end();
  }
}

if (process.argv[1]?.endsWith('repro-max-concurrency.ts')) {
  const concurrency = Number(process.argv[2] ?? 1);
  if (![1, 2, 5].includes(concurrency)) throw new Error('仅支持 1 / 2 / 5');
  const storage = process.argv[3] ?? 'memory';
  if (storage !== 'memory' && storage !== 'postgres') throw new Error('仅支持 memory / postgres');
  console.log(JSON.stringify(await reproduce(concurrency, storage), null, 2));
}
