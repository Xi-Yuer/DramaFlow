import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Annotation, StateGraph, Send, START, END, interrupt } from './dependencies.ts';
import type { BaseCheckpointSaver, LangGraphRunnableConfig } from './dependencies.ts';

export interface Item {
  index: number;
  value: number;
}
export interface Result {
  index: number;
  outerIndex: number;
  value: number;
  decision?: string;
}
export interface Event {
  event: string;
  at: string;
  pid: number;
  index: number;
  outerIndex: number;
  node?: string;
  startedAt?: string;
  finishedAt?: string;
  activeCount?: number;
  peakActiveCount?: number;
  taskId?: string;
  checkpointNs?: string;
  nodeAttempt?: number;
  threadId?: string;
  decision?: string;
}

export class Recorder {
  private active = 0;
  private peak = 0;
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  write(
    event: string,
    item: { index: number; outerIndex: number },
    config: LangGraphRunnableConfig,
    extra: Partial<Event> = {},
  ) {
    const info = config.executionInfo;
    const entry: Event = {
      event,
      at: new Date().toISOString(),
      pid: process.pid,
      index: item.index,
      outerIndex: item.outerIndex,
      taskId: info?.taskId,
      checkpointNs: info?.checkpointNs,
      nodeAttempt: info?.nodeAttempt,
      threadId: info?.threadId,
      activeCount: this.active,
      peakActiveCount: this.peak,
      ...extra,
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }
  enter(item: { index: number; outerIndex: number }, config: LangGraphRunnableConfig) {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    this.write('body_started', item, config, {
      startedAt: new Date().toISOString(),
      activeCount: this.active,
      peakActiveCount: this.peak,
    });
  }
  leave(item: { index: number; outerIndex: number }, config: LangGraphRunnableConfig) {
    this.active--;
    this.write('body_finished_or_interrupted', item, config, {
      finishedAt: new Date().toISOString(),
      activeCount: this.active,
      peakActiveCount: this.peak,
    });
  }
}

function mergeResults(left: Result[], right: Result[]) {
  const keys = new Set(left.map((item) => `${item.outerIndex}/${item.index}`));
  for (const item of right) {
    const key = `${item.outerIndex}/${item.index}`;
    if (keys.has(key)) throw new Error(`重复 item 结果：${key}`);
    keys.add(key);
  }
  return [...left, ...right];
}

const Body = Annotation.Root({
  index: Annotation<number>(),
  value: Annotation<number>(),
  outerIndex: Annotation<number>(),
  intermediate: Annotation<number>(),
  result: Annotation<number>(),
  decision: Annotation<string>(),
});
const MapState = Annotation.Root({
  items: Annotation<Item[]>(),
  outerIndex: Annotation<number>(),
  results: Annotation<Result[]>({ reducer: mergeResults, default: () => [] }),
  ordered: Annotation<Result[]>(),
});
export type MapInput = { items: Item[]; outerIndex: number; results: Result[] };

export function createMapGraph(recorder: Recorder, review: boolean, saver?: BaseCheckpointSaver) {
  const builder = new StateGraph(Body)
    .addNode('stepA', async (state, config) => {
      const startedAt = new Date().toISOString();
      recorder.write('node_started', state, config, { node: 'stepA', startedAt });
      // 反向 delay 使完成顺序与输入顺序不同；模拟副作用单独持久记录，不放在 review 节点内。
      await delay(4 + (9 - (state.index % 10)) * 2);
      recorder.write('stepA_effect', state, config, { node: 'stepA' });
      recorder.write('node_finished', state, config, {
        node: 'stepA',
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      return { intermediate: state.value * 2 };
    })
    .addNode('stepB', async (state, config) => {
      const startedAt = new Date().toISOString();
      recorder.write('node_started', state, config, { node: 'stepB', startedAt });
      await delay(2 + (state.index % 3) * 2);
      recorder.write('node_finished', state, config, {
        node: 'stepB',
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      return { result: state.intermediate + 1 };
    })
    .addEdge(START, 'stepA');
  if (review) {
    builder
      .addNode('review', (state, config) => {
        recorder.write('review_enter', state, config, { node: 'review' });
        const answer = interrupt<unknown>({
          kind: 'runtime_experiment',
          index: state.index,
          outerIndex: state.outerIndex,
          value: state.value,
          taskId: config.executionInfo?.taskId,
          checkpointNs: config.executionInfo?.checkpointNs,
          nodeAttempt: config.executionInfo?.nodeAttempt,
        });
        if (typeof answer !== 'string') throw new Error('实验决策必须为字符串');
        recorder.write('review_resumed', state, config, { node: 'review', decision: answer });
        return { decision: answer };
      })
      .addEdge('stepA', 'review')
      .addEdge('review', 'stepB');
  } else builder.addEdge('stepA', 'stepB');
  const body = builder.addEdge('stepB', END).compile();
  return new StateGraph(MapState)
    .addNode('dispatch', () => ({}))
    .addNode(
      'body',
      async (state, config) => {
        recorder.enter(state, config);
        try {
          const output = await body.invoke(state, config);
          const result: Result = {
            index: state.index,
            outerIndex: state.outerIndex,
            value: output.result,
            ...(review ? { decision: output.decision } : {}),
          };
          recorder.write('item_completed', state, config);
          return { results: [result] };
        } finally {
          recorder.leave(state, config);
        }
      },
      { input: Body, subgraphs: [body] },
    )
    .addNode('collect', (state, config) => {
      recorder.write('collect', { index: -1, outerIndex: state.outerIndex }, config);
      return { ordered: [...state.results].sort((a, b) => a.index - b.index) };
    })
    .addEdge(START, 'dispatch')
    .addConditionalEdges(
      'dispatch',
      (state) =>
        state.items.length
          ? state.items.map((item) => new Send('body', { ...item, outerIndex: state.outerIndex }))
          : 'collect',
      ['body', 'collect'],
    )
    .addEdge('body', 'collect')
    .addEdge('collect', END)
    .compile(saver ? { checkpointer: saver } : {});
}

export function createNestedGraph(recorder: Recorder, saver: BaseCheckpointSaver) {
  const inner = createMapGraph(recorder, true);
  return new StateGraph(MapState)
    .addNode('dispatch', () => ({}))
    .addNode(
      'outerBody',
      async (state, config) => {
        recorder.write('outer_enter', { index: -1, outerIndex: state.outerIndex }, config);
        const output = await inner.invoke(state, config);
        return { results: output.ordered };
      },
      { subgraphs: [inner] },
    )
    .addNode('collect', (state) => ({
      ordered: [...state.results].sort((a, b) => a.outerIndex - b.outerIndex || a.index - b.index),
    }))
    .addEdge(START, 'dispatch')
    .addConditionalEdges(
      'dispatch',
      (state) =>
        state.items.map(
          (outer) =>
            new Send('outerBody', {
              items: [
                { index: 0, value: outer.value * 10 },
                { index: 1, value: outer.value * 10 + 1 },
              ],
              outerIndex: outer.index,
              results: [],
            }),
        ),
      ['outerBody'],
    )
    .addEdge('outerBody', 'collect')
    .addEdge('collect', END)
    .compile({ checkpointer: saver });
}
