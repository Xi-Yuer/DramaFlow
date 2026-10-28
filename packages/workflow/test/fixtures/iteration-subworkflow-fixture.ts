import { NumberType, StringType } from '@dramaflow/contracts';
import { z } from 'zod';
import { vi } from 'vitest';
import { interrupt } from '@langchain/langgraph';
import * as graphCompiler from '../../src/compiler/graph/graph-compiler.js';
import { SUBWORKFLOW_FRAME, subworkflowFrameSchema } from '../../src/compiler/subworkflow/state.js';
import { nestedCompositeFixture } from './nested-composite-fixture.js';

export const texts = ['alpha', 'beta', 'gamma'];
export const expected = ['result-0', 'result-1', 'result-2'];
export const array = { kind: 'array' as const, itemType: StringType };

// 在已有原生入口暂停，发生于 Action audit 之前；不增加暂停 NodeType 或业务执行 attempt。
export function pauseSubworkflowInput(text: string) {
  const compile = graphCompiler.compileGraph;
  return vi.spyOn(graphCompiler, 'compileGraph').mockImplementation((context) => {
    const entry = context.entry;
    if (entry && context.plan.definitionLocation.path.at(-1)?.graphKey === 'graph') {
      compile({
        ...context,
        entry: {
          ...entry,
          execute: async (state, config) => {
            const frame = subworkflowFrameSchema.parse(Reflect.get(state, SUBWORKFLOW_FRAME));
            if (
              frame.state.inputs.text?.storage === 'inline' &&
              frame.state.inputs.text.value === text
            )
              interrupt({ kind: 'test_only_before_action', item: text });
            return entry.execute(state, config);
          },
        },
      });
    } else compile(context);
  });
}

export function iterationSubworkflowFixture() {
  const f = nestedCompositeFixture();
  f.run.inputs.items = { storage: 'inline', type: array, value: texts };
  const loop = f.definition.nodes[0]!;
  if (loop.composite?.kind !== 'iteration') throw new Error('测试必须使用 Iteration');
  const body = loop.composite.body;
  body.inputs.push({ name: 'index', type: NumberType, required: true });
  loop.composite.bodyInputMapping.push({ target: 'index', source: { type: 'current_index' } });
  f.parent.inputs.index = { type: 'workflow_input', key: 'index' };
  f.child.inputs.push({ name: 'index', type: NumberType, required: true });
  const action = f.child.nodes[0]!;
  action.id = 'action';
  action.inputs.index = { type: 'workflow_input', key: 'index' };
  action.config.template = 'result-{{index}}';
  f.child.outputs[0]!.source = { nodeId: 'action', outputKey: 'text' };
  const execute = f.execute.getMockImplementation()!;
  const finished: string[] = [];
  let active = 0,
    peak = 0;
  f.execute.mockImplementation(async (raw, config, context) => {
    const input = z.object({ text: z.string() }).parse(raw);
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) =>
        setTimeout(resolve, input.text === 'alpha' ? 60 : input.text === 'beta' ? 20 : 1),
      );
      const output = await execute(raw, config, context);
      finished.push(input.text);
      return output;
    } finally {
      active--;
    }
  });
  return { ...f, body, finished, peak: () => peak };
}
