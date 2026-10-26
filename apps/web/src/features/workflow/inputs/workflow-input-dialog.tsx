'use client';

import { useState } from 'react';
import { Alert, Button, Modal } from 'antd';
import type { NodeTypeManifest, WorkflowDefinition } from '@dramaflow/contracts';
import { GraphInputEditor } from '../iteration/graph-input-editor';
import {
  addGraphInput,
  removeGraphInput,
  updateGraphInput,
} from '../iteration/iteration-body-inputs';

export function WorkflowInputDialog({
  definition,
  manifests,
  disabled,
  onEdit,
  onClose,
}: {
  definition: WorkflowDefinition;
  manifests: readonly NodeTypeManifest[];
  disabled: boolean;
  onEdit: (apply: (current: WorkflowDefinition) => WorkflowDefinition) => void;
  onClose: () => void;
}) {
  const [message, setMessage] = useState<string | null>(null);

  function commit(recipe: (current: WorkflowDefinition) => WorkflowDefinition) {
    if (disabled) return false;
    try {
      const next = recipe(definition);
      onEdit(() => next);
      setMessage(null);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法更新工作流输入');
      return false;
    }
  }

  return (
    <Modal
      open
      title="工作流输入"
      onCancel={onClose}
      footer={
        <Button autoInsertSpace={false} onClick={onClose}>
          完成
        </Button>
      }
    >
      <p>修改会更新当前草稿，需点击保存后持久化。从输入边界拖线连接节点端口。</p>
      {message ? <Alert type="warning" title={message} showIcon /> : null}
      <GraphInputEditor
        label="工作流输入"
        inputs={definition.inputs}
        disabled={disabled}
        empty="尚未声明工作流输入。"
        onAdd={() => commit(addGraphInput)}
        onRemove={(name) => commit((current) => removeGraphInput(current, name))}
        onRename={(name, next) =>
          commit((current) => updateGraphInput(current, name, { name: next }, manifests))
        }
        onType={(name, type) =>
          commit((current) => updateGraphInput(current, name, { type }, manifests))
        }
        onRequired={(name, required) =>
          commit((current) => updateGraphInput(current, name, { required }, manifests))
        }
      />
    </Modal>
  );
}
