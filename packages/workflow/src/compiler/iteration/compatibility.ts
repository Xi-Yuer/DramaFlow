import type { RunnableConfig } from '@langchain/core/runnables';

export class IterationRuntimeCompatibilityError extends Error {
  readonly code = 'ITERATION_LANGGRAPH_CONCURRENCY_UNSUPPORTED';
  constructor() {
    super('LangGraph.js 1.5.0 的 Iteration 不支持 maxConcurrency=1');
    this.name = 'IterationRuntimeCompatibilityError';
  }
}
export function assertIterationCompatibility(config: RunnableConfig): void {
  if (config.maxConcurrency === 1) throw new IterationRuntimeCompatibilityError();
}
