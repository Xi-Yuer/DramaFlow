// @vitest-environment happy-dom
import { ConfigProvider } from 'antd';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeTypeManifestSchema } from '@dramaflow/contracts';
import { NodePicker } from '../src/features/workflow/node-catalog/node-picker';

const manifest = (type: string, exposure?: 'public' | 'advanced' | 'internal') =>
  nodeTypeManifestSchema.parse({
    type,
    version: 1,
    executionKind: 'action',
    metadata: {
      name: type,
      category: 'data',
      ...(exposure ? { catalog: { exposure, category: 'data' } } : {}),
    },
    inputs: [],
    outputs: [],
    config: [],
  });

afterEach(cleanup);

describe('普通 Node Picker 产品暴露', () => {
  it('按 metadata 显示 public 并创建精确版本，隐藏 advanced / internal / 未声明类型', async () => {
    const publicNode = manifest('test.visible', 'public');
    const onSelect = vi.fn();
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <NodePicker
          manifests={[
            publicNode,
            manifest('test.advanced', 'advanced'),
            manifest('test.primitive', 'internal'),
            manifest('test.undeclared'),
          ]}
          disabled={false}
          onSelect={onSelect}
        />
      </ConfigProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
    const option = await screen.findByRole('button', { name: '添加 test.visible · v1' });
    expect(screen.getByText('数据处理 · v1')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /添加 test\.(advanced|primitive|undeclared)/ }),
    ).toBeNull();
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(publicNode);
  });

  it('完整目录没有普通节点时禁用添加入口', () => {
    render(
      <NodePicker
        manifests={[manifest('test.hidden', 'internal')]}
        disabled={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '添加节点' })).toHaveProperty('disabled', true);
  });
});
