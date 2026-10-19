import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  applyNodePreset,
  executeNode,
  inputBindingFromEdge,
  parseNodeDefinition,
  type NodeTypeDefinition,
} from '../src/index.js';

// 显式测试契约与纯函数，不注册 LLM、供应商适配器或生产 Preset。
const contract = {
  type: 'llm',
  preset: 'storyboard-generator',
  inputSchema: z.object({
    script: z.string().min(1),
    characters: z.array(z.string()),
    style: z.string().optional(),
  }),
  outputSchema: z.object({ shots: z.array(z.object({ text: z.string() }).strict()) }),
  configSchema: z
    .object({ prompt: z.string().min(1), temperature: z.number().min(0).max(2) })
    .refine((config) => config.prompt.trim().length > 0, '提示词不能为空白'),
} satisfies NodeTypeDefinition;

function definition() {
  return {
    id: 'storyboard',
    type: 'llm',
    preset: 'storyboard-generator',
    name: '生成分镜',
    inputs: [
      { target: 'script', source: { nodeId: 'script', outputKey: 'text' } },
      { target: 'characters', source: { nodeId: 'characters', outputKey: 'items' } },
    ],
    config: { prompt: '分镜提示词', temperature: 0.5 },
  };
}

const values = {
  inputs: { script: '剧本', characters: ['角色甲'] },
  config: { prompt: '提示词', temperature: 0.5 },
};

describe('节点类型、实例和 Preset', () => {
  it('依据有效类型契约校验实例配置和目标端口', () => {
    expect(parseNodeDefinition(contract, definition()).inputs).toHaveLength(2);
    expect(() =>
      parseNodeDefinition(contract, {
        ...definition(),
        inputs: [{ target: 'unknown', source: { nodeId: 'a', outputKey: 'text' } }],
      }),
    ).toThrow(expect.objectContaining({ code: 'unknown_input' }));
  });

  it('类型或 Preset 不匹配时拒绝使用其他有效契约', () => {
    for (const node of [
      { ...definition(), type: 'http' },
      { ...definition(), preset: 'advertisement' },
    ]) {
      expect(() => parseNodeDefinition(contract, node)).toThrow(
        expect.objectContaining({ code: 'contract_mismatch' }),
      );
    }
  });

  it('显式应用 Preset 配置，保留实例覆盖，并避免修改原对象', () => {
    const node = { ...definition(), config: { temperature: 1 } };
    const preset = {
      id: 'storyboard-generator',
      type: 'llm',
      name: '生成分镜',
      config: { prompt: 'Preset 提示词', temperature: 0.2 },
    };
    const applied = applyNodePreset(contract, node, preset);
    expect(applied.config).toEqual({ prompt: 'Preset 提示词', temperature: 1 });
    expect(node.config).toEqual({ temperature: 1 });
    expect(preset.config.temperature).toBe(0.2);
    expect(() => applyNodePreset(contract, node, { ...preset, type: 'http' })).toThrow(
      expect.objectContaining({ code: 'preset_mismatch' }),
    );
  });

  it('拒绝未声明配置并保留 Schema 的对象级校验', () => {
    for (const config of [
      { ...values.config, apiKey: 'test-only' },
      { ...values.config, prompt: '   ' },
    ])
      expect(() => parseNodeDefinition(contract, { ...definition(), config })).toThrow(z.ZodError);
  });

  it('可以从 Edge 提取数据映射，而不触发节点或修改原连线', () => {
    const edge = {
      id: 'e1',
      sourceNodeId: 'script',
      sourceHandle: 'text',
      targetNodeId: 'storyboard',
      targetHandle: 'script',
    };
    expect(inputBindingFromEdge(edge)).toEqual({
      target: 'script',
      source: { nodeId: 'script', outputKey: 'text' },
    });
    expect(edge.id).toBe('e1');
  });
});

describe('Input → Execute → Output 调用边界', () => {
  it('执行器只收到已组装输入和配置，结果经过输出契约校验', async () => {
    const executor = vi.fn(({ inputs }: { inputs: { script: string; characters: string[] } }) => ({
      shots: [{ text: `${inputs.script}：${inputs.characters.join('、')}` }],
    }));
    const result = await executeNode(contract, values, executor);
    expect(result).toEqual({ shots: [{ text: '剧本：角色甲' }] });
    expect(Object.keys(executor.mock.calls[0]![0])).toEqual(['inputs', 'config']);
  });

  it('缺失必填输入时不调用执行器，也不自动拼装上游数据', async () => {
    const executor = vi.fn();
    await expect(
      executeNode(contract, { ...values, inputs: { script: '剧本' } }, executor),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(executor).not.toHaveBeenCalled();
  });

  it('拒绝额外状态、未声明输入和非法配置，均不产生执行副作用', async () => {
    const executor = vi.fn();
    for (const parameters of [
      { ...values, state: { allNodes: [] } },
      { ...values, inputs: { ...values.inputs, unrelated: '其他数据' } },
      { ...values, config: { ...values.config, temperature: 3 } },
    ])
      await expect(executeNode(contract, parameters, executor)).rejects.toBeInstanceOf(z.ZodError);
    expect(executor).not.toHaveBeenCalled();
  });

  it('错误输出和非 JSON 输出不能作为成功结果返回', async () => {
    for (const result of [
      { shots: 'not-array' },
      { shots: [], hidden: 'undeclared' },
      { shots: [{ text: new Date() }] },
    ]) {
      await expect(executeNode(contract, values, () => result)).rejects.toBeInstanceOf(z.ZodError);
    }
  });

  it('执行器异常原样传播，不隐藏失败或自行重试', async () => {
    const error = new Error('受理结果不明');
    const executor = vi.fn(() => {
      throw error;
    });
    await expect(executeNode(contract, values, executor)).rejects.toBe(error);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('执行期间修改输入不污染调用方，返回结果也不共享执行器的可变对象', async () => {
    const input = structuredClone(values);
    const produced = { shots: [{ text: '原始结果' }] };
    const result = await executeNode(contract, input, ({ inputs }) => {
      inputs.characters.push('新角色');
      return produced;
    });
    produced.shots[0]!.text = '后来修改';
    expect(input.inputs.characters).toEqual(['角色甲']);
    expect(result.shots[0]?.text).toBe('原始结果');
  });

  it('同一 Runtime type 和执行函数可以服务不同有效 Preset 契约', async () => {
    const base = {
      type: 'llm',
      outputSchema: z.object({ text: z.string() }),
      configSchema: z.object({}),
    };
    const story = { ...base, preset: 'story', inputSchema: z.object({ subject: z.string() }) };
    const advertisement = {
      ...base,
      preset: 'advertisement',
      inputSchema: z.object({ product: z.string() }),
    };
    const executor = ({ inputs }: { inputs: Record<string, unknown> }) => ({
      text: Object.values(inputs).join(' / '),
    });
    expect(
      await executeNode(story, { inputs: { subject: '故事主题' }, config: {} }, executor),
    ).toEqual({ text: '故事主题' });
    expect(
      await executeNode(advertisement, { inputs: { product: '商品' }, config: {} }, executor),
    ).toEqual({ text: '商品' });
  });
});
