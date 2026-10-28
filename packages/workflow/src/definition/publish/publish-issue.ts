import type { GraphDefinitionPath } from '@dramaflow/contracts';
import type { CompositeDefinitionError } from '@dramaflow/contracts';

export type IfCapabilityIssueCode =
  | 'IF_TOPOLOGY_UNSUPPORTED'
  | 'CONDITIONAL_WORKFLOW_OUTPUT_UNSUPPORTED'
  | 'IF_CONVERGENCE_UNSUPPORTED'
  | 'IF_CONVERGENCE_INPUT_UNSUPPORTED'
  | 'IF_NESTED_UNSUPPORTED'
  | 'IF_REGION_INTERSECTION_UNSUPPORTED'
  | 'IF_BRANCH_DEPENDENCY_UNSUPPORTED';

const ifCapabilityMessages = new Map<string, string>([
  ['IF_TOPOLOGY_UNSUPPORTED', '当前 Compiler 要求 If 的 true / false 各有一个 Action 入口'],
  [
    'CONDITIONAL_WORKFLOW_OUTPUT_UNSUPPORTED',
    '当前 Compiler 要求候选分别覆盖同一 If 的 true / false region；单来源须必定执行',
  ],
  [
    'IF_CONVERGENCE_UNSUPPORTED',
    '当前 Compiler 要求唯一汇聚边界完整覆盖两侧分支末端，不能交叉或绕行',
  ],
  [
    'IF_CONVERGENCE_INPUT_UNSUPPORTED',
    '汇聚输入须由候选绑定分别覆盖同一 If 的 true / false 分支；单来源不能直接读取互斥分支',
  ],
  ['IF_NESTED_UNSUPPORTED', '当前版本暂不支持嵌套 If'],
  ['IF_REGION_INTERSECTION_UNSUPPORTED', '当前版本暂不支持不同 If 的分支区域交叉'],
  ['IF_BRANCH_DEPENDENCY_UNSUPPORTED', '分支输入必须来自本分支或所属 If 之前保证完成的祖先'],
]);

export function ifCapabilityMessage(code: string): string | undefined {
  return ifCapabilityMessages.get(code);
}

export type WorkflowPublishIssueCode =
  | CompositeDefinitionError['code']
  | 'ITERATION_BODY_CAPABILITY_UNSUPPORTED'
  | 'ITERATION_BODY_EMPTY'
  | 'SUBWORKFLOW_GRAPH_CAPABILITY_UNSUPPORTED'
  | 'SUBWORKFLOW_GRAPH_CANDIDATE_UNSUPPORTED'
  | 'HUMAN_REVIEW_TOPOLOGY_UNSUPPORTED'
  | 'NODE_TYPE_UNAVAILABLE'
  | 'NODE_EXECUTION_KIND_UNSUPPORTED'
  | 'NODE_ID_INVALID'
  | 'NODE_CONFIG_INVALID'
  | 'INPUT_PORT_NOT_FOUND'
  | 'OUTPUT_PORT_NOT_FOUND'
  | 'INPUT_SOURCE_MISSING'
  | 'INPUT_SOURCE_OPTIONAL'
  | 'INPUT_VALUE_INVALID'
  | 'INPUT_TYPE_MISMATCH'
  | 'WORKFLOW_OUTPUT_TYPE_MISMATCH'
  | 'NAMED_CONTROL_PORT_UNSUPPORTED'
  | 'CONTROL_OUTPUT_PORT_REQUIRED'
  | 'CONTROL_OUTPUT_BRANCH_MISSING'
  | 'ASSET_BINDING_UNSUPPORTED'
  | 'OUTPUT_STORAGE_UNSUPPORTED'
  | IfCapabilityIssueCode;

const publishIssueMessages = new Map<WorkflowPublishIssueCode, string>([
  ['SUBWORKFLOW_GRAPH_CAPABILITY_UNSUPPORTED', 'SubWorkflow v1 子图仅允许普通 Action DAG'],
  [
    'SUBWORKFLOW_GRAPH_CANDIDATE_UNSUPPORTED',
    'SubWorkflow v1 子图不支持 Candidate；它需要已证明互斥的控制分支',
  ],
  [
    'ITERATION_BODY_CAPABILITY_UNSUPPORTED',
    'Iteration v1 body 仅允许普通 Action 或 flow.subworkflow@1',
  ],
  ['ITERATION_BODY_EMPTY', 'Iteration body 至少需要一个 Action 节点'],
  [
    'HUMAN_REVIEW_TOPOLOGY_UNSUPPORTED',
    '当前 Human Review 仅支持分支区域外的串行审核，不支持并行待审批',
  ],
  ['NODE_EXECUTION_KIND_UNSUPPORTED', '当前 Compiler 尚不支持该节点执行种类'],
]);

const DEFAULT_PUBLISH_ISSUE_MESSAGE = '工作流不满足静态发布条件';

function publishIssueMessage(code: WorkflowPublishIssueCode): string {
  return (
    publishIssueMessages.get(code) ?? ifCapabilityMessage(code) ?? DEFAULT_PUBLISH_ISSUE_MESSAGE
  );
}

export class WorkflowPublishValidationError extends Error {
  constructor(
    readonly code: WorkflowPublishIssueCode,
    readonly nodeId: string,
    readonly portKey?: string,
    readonly definitionPath?: GraphDefinitionPath,
  ) {
    super(publishIssueMessage(code));
    this.name = 'WorkflowPublishValidationError';
  }
}

export function invalid(code: WorkflowPublishIssueCode, nodeId: string, portKey?: string): never {
  throw new WorkflowPublishValidationError(code, nodeId, portKey);
}
