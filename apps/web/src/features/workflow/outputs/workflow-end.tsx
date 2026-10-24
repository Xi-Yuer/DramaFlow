'use client';
import { createContext, useContext } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Button, Form, Input, Modal, Select } from 'antd';
import {
  workflowPortNameSchema,
  workflowOutputSources,
  type NodeTypeManifest,
  type WorkflowDefinition,
  type WorkflowOutputSource,
} from '@dramaflow/contracts';
import { resolveWorkflowNodePorts } from '../ports/resolve-workflow-node-ports';
import {
  END_INPUT_HANDLE,
  nextWorkflowOutputName,
  type WorkflowEndNode,
  type WorkflowOutputEdit,
} from './workflow-outputs';
import styles from './workflow-end.module.css';

export const WorkflowOutputActions = createContext<{
  disabled: boolean;
  onConfigure: (name?: string) => void;
  onRemove: (name: string) => void;
  onRemoveCandidate?: (name: string, source: WorkflowOutputSource) => void;
} | null>(null);

export function WorkflowEnd({ data, selected, isConnectable }: NodeProps<WorkflowEndNode>) {
  const actions = useContext(WorkflowOutputActions);
  if (!actions) throw new Error('结束边界必须放在 WorkflowOutputActions 中');
  return (
    <section
      className={`${styles.end} ${selected ? styles.selected : ''}`}
      aria-label="结束：工作流输出"
    >
      <Handle
        type="target"
        id={END_INPUT_HANDLE}
        position={Position.Left}
        isConnectable={isConnectable}
        aria-label="工作流输出来源"
      />
      <header>
        <strong>结束</strong>
        <span>工作流输出</span>
      </header>
      {data.outputs.length === 0 ? (
        <p className={styles.hint}>从节点输出拖线到此处，或添加输出。</p>
      ) : (
        <ul className="nodrag nowheel">
          {data.outputs.map((output) => (
            <li key={output.name}>
              <div>
                <strong>{output.name}</strong>
                {workflowOutputSources(output).map((source) => (
                  <span key={JSON.stringify(source)}>
                    {source.nodeId}.{source.outputKey}
                    {output.sources !== undefined ? (
                      <Button
                        size="small"
                        type="text"
                        disabled={actions.disabled}
                        aria-label={`移除候选 ${output.name} ${source.nodeId}.${source.outputKey}`}
                        onClick={() => actions.onRemoveCandidate?.(output.name, source)}
                      >
                        移除
                      </Button>
                    ) : null}
                  </span>
                ))}
                {output.sources !== undefined && output.sources.length < 2 ? (
                  <span role="status">候选来源不足，请补齐后再发布</span>
                ) : null}
              </div>
              <Button
                type="text"
                size="small"
                disabled={actions.disabled}
                onClick={() => actions.onConfigure(output.name)}
                aria-label={`编辑输出 ${output.name}`}
              >
                编辑
              </Button>
              <Button
                type="text"
                size="small"
                danger
                disabled={actions.disabled}
                onClick={() => actions.onRemove(output.name)}
                aria-label={`删除输出 ${output.name}`}
              >
                删除
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        className="nodrag"
        size="small"
        disabled={actions.disabled}
        onClick={() => actions.onConfigure()}
      >
        添加输出
      </Button>
    </section>
  );
}

type OutputForm = { name: string; nodeId: string; outputKey: string };
export function WorkflowOutputDialog({
  definition,
  manifests,
  previousName,
  disabled,
  onCancel,
  onSave,
}: {
  definition: WorkflowDefinition;
  manifests: readonly NodeTypeManifest[];
  previousName?: string;
  disabled: boolean;
  onCancel: () => void;
  onSave: (value: WorkflowOutputEdit) => void;
}) {
  const [form] = Form.useForm<OutputForm>();
  const nodeId = Form.useWatch('nodeId', form);
  const previous = definition.outputs.find((output) => output.name === previousName);
  const nodes = definition.nodes.map((node) => {
    const manifest = manifests.find(
      (item) => item.type === node.type && item.version === node.typeVersion,
    );
    return {
      node,
      outputs: manifest ? resolveWorkflowNodePorts(node, manifest).outputs : [],
    };
  });
  const ports = nodes.find((item) => item.node.id === nodeId)?.outputs ?? [];
  return (
    <Modal
      open
      title={previousName ? '编辑工作流输出' : '添加工作流输出'}
      okText="确定"
      cancelText="取消"
      onCancel={onCancel}
      onOk={() => form.submit()}
      okButtonProps={{ disabled }}
    >
      <Form
        form={form}
        layout="vertical"
        disabled={disabled}
        initialValues={
          previous
            ? {
                name: previous.name,
                nodeId: previous.source?.nodeId,
                outputKey: previous.source?.outputKey,
              }
            : { name: nextWorkflowOutputName(definition) }
        }
        onFinish={(value: OutputForm) =>
          onSave(
            previous?.sources !== undefined
              ? { name: value.name, sources: previous.sources }
              : { name: value.name, source: { nodeId: value.nodeId, outputKey: value.outputKey } },
          )
        }
      >
        <Form.Item
          name="name"
          label="输出名称"
          rules={[
            {
              validator: async (_, value: unknown) => {
                const parsed = workflowPortNameSchema.safeParse(value);
                if (!parsed.success)
                  throw new Error(
                    '名称须以英文字母开头，仅包含字母、数字和下划线，且不能使用保留名称',
                  );
                if (
                  definition.outputs.some(
                    (output) => output.name === parsed.data && output.name !== previousName,
                  )
                )
                  throw new Error('工作流输出名称不能重复');
              },
            },
          ]}
        >
          <Input placeholder="例如 result、summary" />
        </Form.Item>
        {previous?.sources !== undefined ? (
          <div>
            <p>候选来源（恰好一个产生结果）</p>
            {previous.sources.map((source) => (
              <p key={JSON.stringify(source)}>
                {source.nodeId}.{source.outputKey}
              </p>
            ))}
            <p>从业务输出拖线到结束边界可加入候选；在结束边界移除单条来源。</p>
          </div>
        ) : (
          <>
            <Form.Item
              name="nodeId"
              label="来源节点"
              rules={[{ required: true, message: '请选择来源节点' }]}
            >
              <Select
                options={nodes.map(({ node, outputs }) => ({
                  value: node.id,
                  label: `${node.name} · ${node.id}`,
                  disabled: outputs.length === 0,
                }))}
                onChange={() => form.setFieldValue('outputKey', undefined)}
              />
            </Form.Item>
            <Form.Item
              name="outputKey"
              label="来源输出端口"
              rules={[
                { required: true, message: '请选择输出端口' },
                {
                  validator: async (_, value: unknown) => {
                    if (value && !ports.some((port) => port.key === value))
                      throw new Error('来源端口不可用，请重新选择节点和端口');
                  },
                },
              ]}
            >
              <Select
                options={ports.map((port) => ({
                  value: port.key,
                  label: `${port.name} · ${port.key}`,
                }))}
              />
            </Form.Item>
          </>
        )}
        <p className={styles.hint}>
          输出类型由所选端口自动确定。保存草稿后，需单独发布才会用于新运行。
        </p>
      </Form>
    </Modal>
  );
}
