'use client';
import { App, Radio, Space } from 'antd';
import {
  workflowOutputSources,
  type NodeTypeManifest,
  type WorkflowDefinition,
  type WorkflowOutputSource,
} from '@dramaflow/contracts';
import type { Connection, ReactFlowProps } from '@xyflow/react';
import {
  isBodyInputConnection,
  projectBodyInputBoundary,
} from '../../iteration/body-input-boundary';
import { bindGraphInput } from '../../inputs/bindings/graph-input-bindings';
import {
  END_INPUT_HANDLE,
  projectWorkflowEnd,
  removeWorkflowOutputCandidate,
} from '../../outputs/workflow-outputs';
import { resolveWorkflowNodePorts } from '../../ports/resolve-workflow-node-ports';
import { areWorkflowHandlesCompatible } from '../adapter/workflow-handles';
import {
  connectWorkflowNodes,
  disconnectWorkflowEdge,
  reconnectWorkflowEdge,
  staticBindingForDataConnection,
  sourcesForDataConnection,
  type ConnectWorkflowOptions,
} from '../adapter/workflow-connections';
import type { CanvasNode, CanvasEdge, WorkflowCanvasProps } from '../view/canvas-types';

export function useCanvasConnections({
  workflow,
  manifests,
  locked,
  atRoot,
  end,
  inputBoundary,
  requestOutputSource,
  onEdit,
}: {
  workflow: WorkflowDefinition;
  manifests: readonly NodeTypeManifest[];
  locked: boolean;
  atRoot: boolean;
  end: ReturnType<typeof projectWorkflowEnd>;
  inputBoundary: ReturnType<typeof projectBodyInputBoundary>;
  requestOutputSource: (source: WorkflowOutputSource) => void;
  onEdit: WorkflowCanvasProps['onEdit'];
}) {
  const { modal } = App.useApp();
  function commitDataConnection(
    connection: Connection,
    apply: (current: WorkflowDefinition, options: ConnectWorkflowOptions) => WorkflowDefinition,
    previousEdge?: CanvasEdge,
  ) {
    // 重连的原关系不属于新目标的占用来源，确认与提交基于相同的断连后视图。
    const available = previousEdge ? disconnectWorkflowEdge(workflow, previousEdge) : workflow;
    const sources = sourcesForDataConnection(available, connection);
    if (
      sources.some(
        (source) =>
          source.nodeId === connection.source && source.portKey === connection.sourceHandle,
      )
    )
      return;
    if (
      sources.length ||
      staticBindingForDataConnection(available, connection)?.type === 'candidate'
    ) {
      let addCandidate = false;
      modal.confirm({
        title: '该输入已有数据来源',
        content: (
          <Space orientation="vertical">
            <Radio.Group
              defaultValue="replace"
              onChange={(event) => {
                addCandidate = event.target.value === 'candidate';
              }}
            >
              <Space orientation="vertical">
                <Radio value="replace">替换现有来源</Radio>
                <Radio value="candidate" disabled={sources.length >= 2}>
                  添加为候选来源
                </Radio>
              </Space>
            </Radio.Group>
            <span>
              {sources.length >= 2
                ? '当前候选输入最多支持两个来源，请先删除一个来源再添加。'
                : '候选输入使用实际执行分支产生的值，分支是否合法由发布时验证。'}
            </span>
          </Space>
        ),
        okText: '确认',
        cancelText: '取消',
        onOk: () =>
          onEdit((current) =>
            apply(current, addCandidate ? { addCandidate: true } : { replaceBinding: true }),
          ),
      });
      return;
    }
    if (!staticBindingForDataConnection(available, connection)) {
      onEdit((current) => apply(current, {}));
      return;
    }
    modal.confirm({
      title: '该输入已有内容。连接后将改为使用上游节点输出，当前内容将被替换。',
      okText: '确认替换',
      cancelText: '取消',
      okButtonProps: { autoInsertSpace: false },
      cancelButtonProps: { autoInsertSpace: false },
      onOk: () => onEdit((current) => apply(current, { replaceBinding: true })),
    });
  }

  function commitGraphInput(connection: Connection) {
    const boundaryId = inputBoundary?.node.id;
    const inputKey = connection.sourceHandle;
    const portKey = connection.targetHandle;
    const targetId = connection.target;
    if (!boundaryId || connection.source !== boundaryId || !inputKey || !portKey || !targetId)
      return;
    if (!isBodyInputConnection(workflow, manifests, connection, boundaryId)) return;
    const existing = staticBindingForDataConnection(workflow, connection);
    const hasEdge = sourcesForDataConnection(workflow, connection).length > 0;
    if (existing?.type === 'workflow_input' && existing.key === inputKey && !hasEdge) return;
    const apply = (current: WorkflowDefinition) =>
      bindGraphInput(current, manifests, targetId, portKey, inputKey);
    if (!existing && !hasEdge) {
      onEdit(apply);
      return;
    }
    modal.confirm({
      title: `该输入已有内容。连接后将改为使用${atRoot ? '工作流' : ' Body '}输入，当前内容将被替换。`,
      okText: '确认替换',
      cancelText: '取消',
      okButtonProps: { autoInsertSpace: false },
      cancelButtonProps: { autoInsertSpace: false },
      onOk: () => onEdit(apply),
    });
  }

  const onConnect: NonNullable<ReactFlowProps<CanvasNode, CanvasEdge>['onConnect']> = (
    connection,
  ) => {
    if (locked) return;
    if (inputBoundary && connection.source === inputBoundary.node.id) {
      commitGraphInput(connection);
      return;
    }
    if (connection.target === end.node.id) {
      const sourceHandle = connection.sourceHandle;
      if (connection.targetHandle !== END_INPUT_HANDLE || !sourceHandle) return;
      requestOutputSource({ nodeId: connection.source, outputKey: sourceHandle });
      return;
    }
    commitDataConnection(connection, (current, options) =>
      connectWorkflowNodes(current, connection, manifests, options),
    );
  };
  const onReconnect: NonNullable<ReactFlowProps<CanvasNode, CanvasEdge>['onReconnect']> = (
    edge,
    connection,
  ) => {
    if (
      locked ||
      edge.data?.kind === 'workflow-output' ||
      edge.data?.projection !== undefined ||
      connection.target === end.node.id ||
      connection.source === end.node.id ||
      connection.source === inputBoundary?.node.id ||
      connection.target === inputBoundary?.node.id
    )
      return;
    commitDataConnection(
      connection,
      (current, options) => reconnectWorkflowEdge(current, edge, connection, manifests, options),
      edge,
    );
  };
  const onEdgesDelete: NonNullable<ReactFlowProps<CanvasNode, CanvasEdge>['onEdgesDelete']> = (
    deleted,
  ) => {
    if (locked) return;
    onEdit((current) =>
      deleted.reduce((definition, edge) => {
        if (edge.data?.kind !== 'workflow-output') return disconnectWorkflowEdge(definition, edge);
        const outputName = edge.data.outputName;
        const output = definition.outputs.find((output) => output.name === outputName);
        return output &&
          workflowOutputSources(output).some(
            (source) => source.nodeId === edge.source && source.outputKey === edge.sourceHandle,
          )
          ? removeWorkflowOutputCandidate(definition, output.name, {
              nodeId: edge.source,
              outputKey: edge.sourceHandle!,
            })
          : definition;
      }, current),
    );
  };
  const isValidConnection: NonNullable<
    ReactFlowProps<CanvasNode, CanvasEdge>['isValidConnection']
  > = (connection) => {
    if (connection.source === end.node.id) return false;
    if (
      inputBoundary &&
      (connection.source === inputBoundary.node.id || connection.target === inputBoundary.node.id)
    ) {
      return isBodyInputConnection(workflow, manifests, connection, inputBoundary.node.id);
    }
    if (connection.target === end.node.id) {
      const node = workflow.nodes.find((node) => node.id === connection.source);
      const manifest = manifests.find(
        (item) => item.type === node?.type && item.version === node.typeVersion,
      );
      return (
        connection.targetHandle === END_INPUT_HANDLE &&
        !!node &&
        !!manifest &&
        resolveWorkflowNodePorts(node, manifest).outputs.some(
          (port) => port.key === connection.sourceHandle,
        )
      );
    }
    return areWorkflowHandlesCompatible(connection.sourceHandle, connection.targetHandle);
  };
  return { onConnect, onReconnect, onEdgesDelete, isValidConnection };
}
