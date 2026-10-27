import { NumberType, type RuntimeValue, type WorkflowDefinition } from '@dramaflow/contracts';
import type { WorkflowCheckpointerService } from '@dramaflow/server';
import { WorkflowStateAnnotation, type WorkflowCompiler } from '@dramaflow/workflow';
import { Command, END, interrupt, START, StateGraph } from '@langchain/langgraph';

export function persistentTestDefinition(): WorkflowDefinition {
  return {
    inputs: [{ name: 'seed', type: NumberType, required: true }],
    nodes: ['prepare', 'native_wait', 'finish'].map((id, index) => ({
      id,
      type: `test.${id}`,
      typeVersion: 1,
      name: id,
      inputs: {},
      config: {},
      ui: { position: { x: index * 200, y: 0 } },
    })),
    edges: [
      {
        id: 'prepare-wait',
        kind: 'control',
        source: { nodeId: 'prepare' },
        target: { nodeId: 'native_wait' },
      },
      {
        id: 'wait-finish',
        kind: 'control',
        source: { nodeId: 'native_wait' },
        target: { nodeId: 'finish' },
      },
    ],
    outputs: [
      {
        name: 'answer',
        type: NumberType,
        source: { nodeId: 'finish', outputKey: 'result' },
      },
    ],
  };
}

function numberValue(value: RuntimeValue | undefined): number {
  if (!value || value.storage !== 'inline' || typeof value.value !== 'number')
    throw new Error('测试 checkpoint 数值缺失');
  return value.value;
}

// 只验证原生中断 / 恢复，不实现生产 interaction 策略，也不在普通 Action 中主动 interrupt。
// 普通 Action 的 DefaultWorkflowCompiler 另由 workflow-runner.e2e-spec 使用同一生产 Provider 验证。
export function persistentTestCompiler(
  checkpointer: WorkflowCheckpointerService,
  onInvoke: (event: { threadId: string; resume: boolean }) => Promise<void>,
): WorkflowCompiler {
  return {
    async compile() {
      const graph = new StateGraph(WorkflowStateAnnotation)
        .addNode('prepare', (state) => {
          if (state.outputs.prepare) throw new Error('恢复时重复执行了已完成节点');
          return {
            outputs: {
              prepare: {
                value: {
                  storage: 'inline' as const,
                  type: NumberType,
                  value: numberValue(state.inputs.seed) + 1,
                },
              },
            },
          };
        })
        .addNode('native_wait', () => {
          const value = interrupt<unknown, unknown>({ prompt: '提供测试增量' });
          if (typeof value !== 'number') throw new Error('测试 resume 必须是数字');
          return {
            outputs: {
              native_wait: {
                value: { storage: 'inline' as const, type: NumberType, value },
              },
            },
          };
        })
        .addNode('finish', (state) => ({
          outputs: {
            finish: {
              result: {
                storage: 'inline' as const,
                type: NumberType,
                value:
                  numberValue(state.outputs.prepare?.value) +
                  numberValue(state.outputs.native_wait?.value),
              },
            },
          },
        }))
        .addEdge(START, 'prepare')
        .addEdge('prepare', 'native_wait')
        .addEdge('native_wait', 'finish')
        .addEdge('finish', END)
        .compile({ checkpointer: checkpointer.saver });
      return {
        async invoke(input, config) {
          const threadId: unknown = config.configurable?.thread_id;
          if (typeof threadId !== 'string') throw new Error('测试缺少原 thread');
          await onInvoke({ threadId, resume: input instanceof Command });
          return graph.invoke(input, config);
        },
        getState: (config) => graph.getState(config),
      };
    },
  };
}
