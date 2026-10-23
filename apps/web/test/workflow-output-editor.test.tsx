// @vitest-environment happy-dom
import { App, ConfigProvider } from 'antd';
import { ReactFlowProvider } from '@xyflow/react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkflowEnd,
  WorkflowOutputActions,
  WorkflowOutputDialog,
} from '../src/features/workflow/outputs/workflow-end';
import {
  addWorkflowOutput,
  appendWorkflowOutputCandidate,
  removeWorkflowOutputCandidate,
  projectWorkflowEnd,
} from '../src/features/workflow/outputs/workflow-outputs';
import { definition, manifest } from './fixtures/workflow-output';

afterEach(cleanup);
describe('结束边界与输出配置', () => {
  it('多候选编辑只改名称，保留候选；不足的候选仍可保存编辑', async () => {
    const single = addWorkflowOutput(definition(), { nodeId: 'b', outputKey: 'text' }, [manifest]);
    const multiple = appendWorkflowOutputCandidate(
      single,
      'result',
      { nodeId: 'a', outputKey: 'text' },
      [manifest],
    );
    const save = vi.fn();
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <App>
          <WorkflowOutputDialog
            definition={multiple}
            manifests={[manifest]}
            previousName="result"
            disabled={false}
            onCancel={() => {}}
            onSave={save}
          />
        </App>
      </ConfigProvider>,
    );
    expect(screen.getByText('b.text')).toBeTruthy();
    expect(screen.getByText('a.text')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: '来源节点' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '输出名称' }), {
      target: { value: 'selected' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确 定' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        name: 'selected',
        sources: multiple.outputs[0]!.sources,
      }),
    );
  });
  it('End 显示候选并逐项移除；不足提示与原输出名称仍保留', () => {
    const multiple = appendWorkflowOutputCandidate(
      addWorkflowOutput(definition(), { nodeId: 'b', outputKey: 'text' }, [manifest]),
      'result',
      { nodeId: 'a', outputKey: 'text' },
      [manifest],
    );
    const workflow = removeWorkflowOutputCandidate(multiple, 'result', {
      nodeId: 'a',
      outputKey: 'text',
    });
    const node = projectWorkflowEnd(workflow).node;
    const remove = vi.fn();
    render(
      <ReactFlowProvider>
        <WorkflowOutputActions.Provider
          value={{
            disabled: false,
            onConfigure: () => {},
            onRemove: () => {},
            onRemoveCandidate: remove,
          }}
        >
          <WorkflowEnd
            id={node.id}
            type="workflowEnd"
            data={node.data}
            selected={false}
            dragging={false}
            zIndex={0}
            selectable
            deletable={false}
            draggable
            isConnectable
            positionAbsoluteX={0}
            positionAbsoluteY={0}
          />
        </WorkflowOutputActions.Provider>
      </ReactFlowProvider>,
    );
    expect(screen.getByText('候选来源不足，请补齐后再发布')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '移除候选 result b.text' }));
    expect(remove).toHaveBeenCalledWith('result', { nodeId: 'b', outputKey: 'text' });
  });
  it('空边界提供添加入口；现有 outputs 恢复名称和来源，删除/编辑使用同一声明', () => {
    const workflow = addWorkflowOutput(definition(), { nodeId: 'b', outputKey: 'text' }, [
      manifest,
    ]);
    const onRemove = vi.fn(),
      onConfigure = vi.fn();
    const node = projectWorkflowEnd(workflow).node;
    render(
      <ConfigProvider>
        <App>
          <ReactFlowProvider>
            <WorkflowOutputActions.Provider value={{ disabled: false, onRemove, onConfigure }}>
              <WorkflowEnd
                id={node.id}
                data={node.data}
                type="workflowEnd"
                selected={false}
                dragging={false}
                zIndex={0}
                selectable
                deletable={false}
                draggable
                isConnectable
                positionAbsoluteX={0}
                positionAbsoluteY={0}
              />
            </WorkflowOutputActions.Provider>
          </ReactFlowProvider>
        </App>
      </ConfigProvider>,
    );
    expect(screen.getByText('result')).toBeTruthy();
    expect(screen.getByText('b.text')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '编辑输出 result' }));
    expect(onConfigure).toHaveBeenCalledWith('result');
    fireEvent.click(screen.getByRole('button', { name: '删除输出 result' }));
    expect(onRemove).toHaveBeenCalledWith('result');
    fireEvent.click(screen.getByRole('button', { name: '添加输出' }));
    expect(onConfigure).toHaveBeenLastCalledWith();
  });
  it('已有声明可重命名，不允许空名称或重复；保留所选节点和端口', async () => {
    const first = addWorkflowOutput(definition(), { nodeId: 'b', outputKey: 'text' }, [manifest]);
    const workflow = addWorkflowOutput(first, { nodeId: 'a', outputKey: 'text' }, [manifest]);
    const save = vi.fn();
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <App>
          <WorkflowOutputDialog
            definition={workflow}
            manifests={[manifest]}
            previousName="result"
            disabled={false}
            onCancel={() => {}}
            onSave={save}
          />
        </App>
      </ConfigProvider>,
    );
    const name = screen.getByRole('textbox', { name: '输出名称' });
    fireEvent.change(name, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '确 定' }));
    await waitFor(() => expect(screen.getAllByText(/名称须以英文字母/).length).toBeGreaterThan(0));
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: 'result_2' } });
    fireEvent.click(screen.getByRole('button', { name: '确 定' }));
    await waitFor(() =>
      expect(screen.getAllByText('工作流输出名称不能重复').length).toBeGreaterThan(0),
    );
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: 'summary' } });
    fireEvent.click(screen.getByRole('button', { name: '确 定' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        name: 'summary',
        source: { nodeId: 'b', outputKey: 'text' },
      }),
    );
  });
  it('从空声明添加输出，选择节点和实际端口', async () => {
    const save = vi.fn();
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <App>
          <WorkflowOutputDialog
            definition={definition()}
            manifests={[manifest]}
            disabled={false}
            onCancel={() => {}}
            onSave={save}
          />
        </App>
      </ConfigProvider>,
    );
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '来源节点' }));
    fireEvent.click(await screen.findByText('b · b'));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '来源输出端口' }));
    fireEvent.click(await screen.findByText('视频 · video'));
    fireEvent.click(screen.getByRole('button', { name: '确 定' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        name: 'result',
        source: { nodeId: 'b', outputKey: 'video' },
      }),
    );
  });
});
