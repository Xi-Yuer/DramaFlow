import { describe, expect, it } from 'vitest';
import { isNodeCatalogEntryVisible, type NodeCatalogEntry } from '@dramaflow/contracts';
import {
  NodeRegistry,
  createTextGenerationNodeType,
  createFormatTextNodeType,
  createIfNodeType,
  createIterationNodeType,
  createSubworkflowNodeType,
  createHumanReviewNodeType,
} from '@dramaflow/workflow';
import { NodeCatalog, createBuiltinNodeCatalogEntries } from '../src/index.js';
function registry() {
  return new NodeRegistry([
    createTextGenerationNodeType(),
    createFormatTextNodeType(),
    createIfNodeType(),
    createIterationNodeType(),
    createSubworkflowNodeType(),
    createHumanReviewNodeType(),
  ]);
}
describe('独立产品 NodeCatalog', () => {
  it('新增 Runtime 注册不自动暴露；正式 format / composite 条目为 internal', () => {
    const runtime = registry();
    expect(new NodeCatalog([], runtime).list()).toEqual([]);
    const entries = new NodeCatalog(createBuiltinNodeCatalogEntries(), runtime).list();
    expect(
      entries.filter((entry) => isNodeCatalogEntryVisible(entry)).map(({ target }) => target.type),
    ).toEqual(['ai.text_generate', 'flow.human_review']);
    expect(entries.find(({ target }) => target.type === 'data.format_text')?.exposure).toBe(
      'internal',
    );
    expect(runtime.getAction('data.format_text', 1).execute).toBeTypeOf('function');
    expect(runtime.listManifests()).toHaveLength(6);
  });
  it('独立 Entry ID 可共用 target，装配与响应隔离来源数据', () => {
    const first = createBuiltinNodeCatalogEntries()[0]!;
    const source = [first, { ...first, id: 'alternative', metadata: { name: '另一测试条目' } }];
    const catalog = new NodeCatalog(source, registry());
    first.metadata.name = '来源修改';
    const result = catalog.list();
    result[0]!.creation.config = { injected: true };
    expect(catalog.list()[0]!.metadata.name).toBe('文本生成');
    expect(catalog.list()[0]!.creation.config).toBeUndefined();
    expect(catalog.list()[1]!.target).toEqual(first.target);
  });
  it('拒绝重复 ID、缺失目标版本和与目标不匹配的 composite', () => {
    const runtime = registry(),
      first = createBuiltinNodeCatalogEntries()[0]!;
    expect(() => new NodeCatalog([first, first], runtime)).toThrow('重复 Entry');
    expect(
      () => new NodeCatalog([{ ...first, target: { ...first.target, version: 999 } }], runtime),
    ).toThrow('不可用');
    const wrong: NodeCatalogEntry = {
      ...first,
      creation: {
        composite: {
          kind: 'subworkflow',
          graph: { inputs: [], nodes: [], edges: [], outputs: [] },
        },
      },
    };
    expect(() => new NodeCatalog([wrong], runtime)).toThrow('composite kind');
  });
});
