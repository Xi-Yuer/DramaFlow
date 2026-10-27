import {
  StringType,
  type NodeTypeManifest,
  type PendingHumanReview,
  type WorkflowRunResponse,
} from '@dramaflow/contracts';

export const humanReviewManifest: NodeTypeManifest = {
  type: 'flow.human_review',
  version: 1,
  executionKind: 'interaction',
  metadata: {
    name: '人工审批',
    category: 'flow',
    description: '审核文本并返回通过或拒绝结果',
  },
  inputs: [{ key: 'content', name: '待审核内容', dataType: StringType, required: true }],
  outputs: [
    { key: 'content', name: '审核内容', dataType: StringType },
    { key: 'action', name: '审批决策', dataType: StringType },
    { key: 'feedback', name: '修改意见', dataType: StringType },
  ],
  config: [{ key: 'instruction', name: '审核说明', type: 'string', required: false }],
};
export const pendingReview: PendingHumanReview = {
  interruptId: 'opaque-review-secret-1',
  waitingRevision: 17,
  node: { id: 'review-1', name: '角色设定审核' },
  content: '主角站在窗前。\n下一行文本 <script>alert(1)</script>',
  instruction: '请确认角色设定是否符合要求',
  submissionStatus: 'pending',
};
export const waitingRun: WorkflowRunResponse = {
  id: 'run-1',
  workflowId: 'workflow-1',
  workflowVersionId: 'version-immutable',
  invocationKey: 'invocation-1',
  status: 'waiting',
  inputs: {},
  createdAt: '2026-10-23T00:00:00.000Z',
};
