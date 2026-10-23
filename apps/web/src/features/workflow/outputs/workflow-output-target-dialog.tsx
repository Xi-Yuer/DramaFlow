'use client';
import { Button, Modal, Space } from 'antd';
import type { WorkflowDefinition } from '@dramaflow/contracts';

// 拖线只提出编辑意图，用户明确决定新建输出或加入某个现有输出。
export function WorkflowOutputTargetDialog({
  outputs,
  disabled,
  onCreate,
  onAppend,
  onCancel,
}: {
  outputs: WorkflowDefinition['outputs'];
  disabled: boolean;
  onCreate(): void;
  onAppend(name: string): void;
  onCancel(): void;
}) {
  return (
    <Modal open title="选择输出归属" footer={null} onCancel={onCancel}>
      <p>新建独立输出，或将此来源加入已有输出的候选。候选结果须恰好存在一个。</p>
      <Space orientation="vertical" style={{ width: '100%' }}>
        <Button block disabled={disabled} onClick={onCreate}>
          新建独立输出
        </Button>
        {outputs.map((output) => (
          <Button block key={output.name} disabled={disabled} onClick={() => onAppend(output.name)}>
            加入 {output.name} 的候选
          </Button>
        ))}
      </Space>
    </Modal>
  );
}
