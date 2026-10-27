// @vitest-environment happy-dom
import { ConfigProvider } from 'antd';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeCatalogEntrySchema } from '@dramaflow/contracts';
import { NodePicker } from '../../../src/features/workflow/node-catalog/node-picker';

const entry = (id: string, exposure: 'public' | 'advanced' | 'internal') =>
  nodeCatalogEntrySchema.parse({
    id,
    exposure,
    metadata: { name: id },
    category: 'data',
    target: { type: 'test.shared', version: 1 },
    creation: {},
  });
afterEach(cleanup);

describe('普通 Node Picker 产品条目', () => {
  it('独立 Entry 身份展示、选择；多个条目可以共用 target，隐藏 advanced / internal', async () => {
    const publicEntry = entry('visible', 'public'),
      second = entry('alternative', 'public');
    const onSelect = vi.fn();
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <NodePicker
          entries={[
            publicEntry,
            second,
            entry('advanced', 'advanced'),
            entry('primitive', 'internal'),
          ]}
          disabled={false}
          onSelect={onSelect}
        />
      </ConfigProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
    const option = await screen.findByRole('button', { name: '添加 visible · v1' });
    expect(screen.getByRole('button', { name: '添加 alternative · v1' })).toBeTruthy();
    expect(screen.getAllByText('数据处理 · v1')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /添加 (advanced|primitive)/ })).toBeNull();
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(publicEntry);
  });

  it('data.format_text internal 条目不出现在普通 Picker', () => {
    render(
      <NodePicker
        entries={[
          {
            ...entry('text-formatting', 'internal'),
            target: { type: 'data.format_text', version: 1 },
          },
        ]}
        disabled={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '添加节点' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: /添加 text-formatting/ })).toBeNull();
  });
});
