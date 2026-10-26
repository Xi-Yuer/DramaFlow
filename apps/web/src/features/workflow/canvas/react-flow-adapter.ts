// 稳定入口：转换、投影与领域连线修改分别维护，调用方无需依赖内部文件布局。
export type {
  WorkflowNodeData,
  WorkflowNode,
  WorkflowEdgeData,
  WorkflowEdge,
} from './adapter/types';
export {
  toReactFlowNode,
  fromReactFlowNode,
  canvasNodeDefinition,
  toReactFlowNodes,
  applyWorkflowNodePositions,
} from './adapter/node-adapter';
export {
  controlEdgeToReactFlowEdge,
  toReactFlowEdge,
  fromReactFlowEdge,
  toReactFlowEdges,
} from './adapter/edge-adapter';
export {
  type ConnectWorkflowOptions,
  sourcesForDataConnection,
  staticBindingForDataConnection,
  connectWorkflowNodes,
  disconnectWorkflowEdge,
  reconnectWorkflowEdge,
} from './adapter/workflow-connections';
