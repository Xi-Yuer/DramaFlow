import type {
  Capability,
  HumanResponse,
  JsonObject,
  ModelBinding,
  NodeResult,
  NodeType,
  RunEventType,
  WorkflowDefinition,
} from '@dramaflow/contracts';
import type { BaseCheckpointSaver } from '@langchain/langgraph';

export interface OperationRequest {
  operationId: string;
  runId: string;
  nodeId: string;
  attemptId: string;
  itemId?: string;
  model: ModelBinding;
  capability: Capability;
  /** Only the explicitly bound inputs and authored prompt; never the full graph state. */
  input: JsonObject;
  parameters: JsonObject;
  signal?: AbortSignal;
}

export interface NodeRecord {
  runId: string;
  nodeId: string;
  attemptId: string;
  result: NodeResult;
}
export interface HumanTaskRequest {
  runId: string;
  nodeId: string;
  attemptId: string;
  interruptId: string;
  payload: JsonObject;
}
export interface RuntimeEvent {
  runId: string;
  nodeId?: string;
  type: RunEventType;
  data: JsonObject;
}

export interface RuntimeHost {
  /** The host owns credential access, operation persistence/idempotency, provider calls and asset storage. */
  executeOperation(request: OperationRequest): Promise<JsonObject>;
  recordNodeResult(record: NodeRecord): Promise<void>;
  createHumanTask(request: HumanTaskRequest): Promise<void>;
  isCancelled(runId: string): Promise<boolean>;
  onEvent?(event: RuntimeEvent): Promise<void>;
}

export interface RuntimeOptions {
  definition: WorkflowDefinition;
  host: RuntimeHost;
  checkpointer: BaseCheckpointSaver;
  maxConcurrency?: number;
}

export interface InvokeOptions {
  runId: string;
  attemptId: string;
  inputs: JsonObject;
  signal?: AbortSignal;
  /** Frozen results reused for a user-created generation branch. Never mutate the original run. */
  reusedResults?: Record<string, NodeResult>;
  executeNodeIds?: string[];
}

export interface ResumeOptions {
  runId: string;
  attemptId: string;
  interruptId: string;
  response: HumanResponse;
  signal?: AbortSignal;
}

export interface RuntimeResult {
  status: 'succeeded' | 'failed' | 'waiting' | 'canceled';
  nodeResults: Record<string, NodeResult>;
  outputCollections: Record<string, JsonObject>;
  interrupts: { id: string; nodeId: string; payload: JsonObject }[];
}

export interface ParsedNodeConfig {
  type: NodeType;
  config: JsonObject;
}
