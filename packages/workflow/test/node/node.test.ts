import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  applyNodePreset,
  invokeNodeOperation,
  parseNodeDefinition,
  type NodeContract,
} from '../../src/index.js';

// 显式测试契约与纯函数，不注册 LLM、供应商适配器或生产 Preset。
const contract = {
  type: 'ai.llm',
  version: 1,
  inputSchema: z.object({
    script: z.string().min(1),
    characters: z.array(z.string()),
    style: z.string().optional(),
  }),
  outputSchema: z.object({ shots: z.array(z.object({ text: z.string() }).strict()) }),
  configSchema: z
    .object({ prompt: z.string().min(1), temperature: z.number().min(0).max(2) })
    .refine((config) => config.prompt.trim().length > 0, '提示词不能为空白'),
} satisfies NodeContract;

function definition() {
  return {
    id: 'storyboard',
    type: 'ai.llm',
    typeVersion: 1,
    preset: 'storyboard-generator',
    name: '生成分镜',
    inputs: {
      script: { type: 'workflow_input', key: 'script' },
      characters: { type: 'workflow_input', key: 'characters' },
    },
    ui: { position: { x: 0, y: 0 } },
    config: { prompt: '分镜提示词', temperature: 0.5 },
  };
}

const values = {
  inputs: { script: '剧本', characters: ['角色甲'] },
  config: { prompt: '提示词', temperature: 0.5 },
};

describe('节点类型、实例和 Preset', () => {
  it('依据有效类型契约校验实例配置和目标端口', () => {
    expect(Object.keys(parseNodeDefinition(contract, definition()).inputs)).toHaveLength(2);
    expect(() =>
      parseNodeDefinition(contract, {
        ...definition(),
        inputs: { unknown: { type: 'workflow_input', key: 'text' } },
      }),
    ).toThrow(expect.objectContaining({ code: 'unknown_input' }));
  });

  it('类型或类型版本不匹配时拒绝使用其他有效契约', () => {
    for (const node of [
      { ...definition(), type: 'net.http' },
      { ...definition(), typeVersion: 2 },
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
      type: 'ai.llm',
      typeVersion: 1,
      name: '生成分镜',
      config: { prompt: 'Preset 提示词', temperature: 0.2 },
    };
    const applied = applyNodePreset(contract, node, preset);
    expect(applied.config).toEqual({ prompt: 'Preset 提示词', temperature: 1 });
    expect(node.config).toEqual({ temperature: 1 });
    expect(preset.config.temperature).toBe(0.2);
    expect(() => applyNodePreset(contract, node, { ...preset, type: 'net.http' })).toThrow(
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

  it('多来源绑定只保存描述，不在实例校验时解析值或读取资产', () => {
    const node = {
      ...definition(),
      inputs: {
        script: { type: 'constant', value: '用户文本' },
        characters: { type: 'asset', assetId: 'test-asset', versionId: 'asset-version-1' },
        style: { type: 'workflow_input', key: 'style' },
      },
    };
    expect(parseNodeDefinition(contract, node).inputs).toEqual(node.inputs);
  });
});

describe('Input → Execute → Output 调用边界', () => {
  it('执行器只收到已组装输入和配置，结果经过输出契约校验', async () => {
    const executor = vi.fn(({ inputs }: { inputs: { script: string; characters: string[] } }) => ({
      shots: [{ text: `${inputs.script}：${inputs.characters.join('、')}` }],
    }));
    const result = await invokeNodeOperation(contract, values, executor);
    expect(result).toEqual({ shots: [{ text: '剧本：角色甲' }] });
    expect(Object.keys(executor.mock.calls[0]![0])).toEqual(['inputs', 'config']);
  });

  it('缺失必填输入时不调用执行器，也不自动拼装上游数据', async () => {
    const executor = vi.fn();
    await expect(
      invokeNodeOperation(contract, { ...values, inputs: { script: '剧本' } }, executor),
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
      await expect(invokeNodeOperation(contract, parameters, executor)).rejects.toBeInstanceOf(
        z.ZodError,
      );
    expect(executor).not.toHaveBeenCalled();
  });

  it('错误输出和非 JSON 输出不能作为成功结果返回', async () => {
    for (const result of [
      { shots: 'not-array' },
      { shots: [], hidden: 'undeclared' },
      { shots: [{ text: new Date() }] },
    ]) {
      await expect(invokeNodeOperation(contract, values, () => result)).rejects.toBeInstanceOf(
        z.ZodError,
      );
    }
  });

  it('执行器异常原样传播，不隐藏失败或自行重试', async () => {
    const error = new Error('受理结果不明');
    const executor = vi.fn(() => {
      throw error;
    });
    await expect(invokeNodeOperation(contract, values, executor)).rejects.toBe(error);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('执行期间修改输入不污染调用方，返回结果也不共享执行器的可变对象', async () => {
    const input = structuredClone(values);
    const produced = { shots: [{ text: '原始结果' }] };
    const result = await invokeNodeOperation(contract, input, ({ inputs }) => {
      inputs.characters.push('新角色');
      return produced;
    });
    produced.shots[0]!.text = '后来修改';
    expect(input.inputs.characters).toEqual(['角色甲']);
    expect(result.shots[0]?.text).toBe('原始结果');
  });

  it('同一值契约和执行函数可以接收不同输入，不建立 Preset 执行身份', async () => {
    const base = {
      type: 'ai.llm',
      version: 1,
      outputSchema: z.object({ text: z.string() }),
      configSchema: z.object({}),
    };
    const story = { ...base, inputSchema: z.object({ subject: z.string() }) };
    const advertisement = {
      ...base,
      inputSchema: z.object({ product: z.string() }),
    };
    const executor = ({ inputs }: { inputs: Record<string, unknown> }) => ({
      text: Object.values(inputs).join(' / '),
    });
    expect(
      await invokeNodeOperation(story, { inputs: { subject: '故事主题' }, config: {} }, executor),
    ).toEqual({ text: '故事主题' });
    expect(
      await invokeNodeOperation(
        advertisement,
        { inputs: { product: '商品' }, config: {} },
        executor,
      ),
    ).toEqual({ text: '商品' });
  });
});
