import {
  NullType,
  startWorkflowRunRequestSchema,
  type DataType,
  type RuntimeValue,
  type StartWorkflowRunRequest,
  type WorkflowInputDefinition,
  type WorkflowRunResponse,
  type WorkflowRunStatus,
} from '@dramaflow/contracts';
import { ApiError } from '../../../lib/http';

type BasicInputKind = 'string' | 'number' | 'boolean';

export type WorkflowInputEditor =
  | { kind: BasicInputKind; nullable: boolean; type: DataType }
  | { kind: 'array'; itemKind: 'string' | 'number'; nullable: false; type: DataType }
  | { kind: 'unsupported'; nullable: false };

export interface WorkflowInputFormValue {
  provided: boolean;
  explicitNull: boolean;
  value: unknown;
}

export type WorkflowInputFormValues = Record<string, WorkflowInputFormValue>;

export interface WorkflowInputIssue {
  name: string;
  code: 'required' | 'invalid' | 'unsupported';
  message: string;
}

export type WorkflowInputBuildResult =
  { ok: true; inputs: Record<string, RuntimeValue> } | { ok: false; issues: WorkflowInputIssue[] };

function basicType(type: DataType): type is DataType & {
  kind: 'primitive';
  name: BasicInputKind;
} {
  return (
    type.kind === 'primitive' &&
    (type.name === 'string' || type.name === 'number' || type.name === 'boolean')
  );
}

export function workflowInputEditor(type: DataType): WorkflowInputEditor {
  if (basicType(type)) return { kind: type.name, nullable: false, type };
  if (
    type.kind === 'array' &&
    type.itemType.kind === 'primitive' &&
    (type.itemType.name === 'string' || type.itemType.name === 'number')
  ) {
    return { kind: 'array', itemKind: type.itemType.name, nullable: false, type };
  }
  if (type.kind !== 'union' || type.types.length !== 2)
    return { kind: 'unsupported', nullable: false };
  const valueType = type.types.find(basicType);
  const nullTypes = type.types.filter((item) => item.kind === 'primitive' && item.name === 'null');
  return valueType && nullTypes.length === 1
    ? { kind: valueType.name, nullable: true, type: valueType }
    : { kind: 'unsupported', nullable: false };
}

function arrayNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function inlineValue(
  editor: Exclude<WorkflowInputEditor, { kind: 'unsupported' }>,
  value: unknown,
): RuntimeValue | null {
  if (editor.kind === 'string' && typeof value === 'string')
    return { storage: 'inline', type: editor.type, value };
  if (editor.kind === 'number' && typeof value === 'number' && Number.isFinite(value))
    return { storage: 'inline', type: editor.type, value };
  if (editor.kind === 'boolean' && typeof value === 'boolean')
    return { storage: 'inline', type: editor.type, value };
  return null;
}

export function buildWorkflowRunInputs(
  definitions: WorkflowInputDefinition[],
  values: WorkflowInputFormValues,
): WorkflowInputBuildResult {
  const entries: [string, RuntimeValue][] = [];
  const issues: WorkflowInputIssue[] = [];
  for (const definition of definitions) {
    const editor = workflowInputEditor(definition.type);
    if (editor.kind === 'unsupported') {
      issues.push({
        name: definition.name,
        code: 'unsupported',
        message: '不支持当前类型输入',
      });
      continue;
    }
    const field = Object.hasOwn(values, definition.name) ? values[definition.name] : undefined;
    const provided = definition.required || field?.provided === true;
    if (!provided) continue;
    if (!field) {
      issues.push({
        name: definition.name,
        code: 'required',
        message: '请提供必填输入',
      });
      continue;
    }
    if (field.explicitNull) {
      if (!editor.nullable) {
        issues.push({
          name: definition.name,
          code: 'invalid',
          message: '此输入不允许 null',
        });
        continue;
      }
      entries.push([definition.name, { storage: 'inline', type: NullType, value: null }]);
      continue;
    }
    if (editor.kind === 'array') {
      const items: unknown = field.value;
      if (!Array.isArray(items)) {
        issues.push({ name: definition.name, code: 'invalid', message: '请提供有效的列表输入' });
        continue;
      }
      if (definition.required && items.length === 0) {
        issues.push({ name: definition.name, code: 'required', message: '必填列表至少需要一项' });
        continue;
      }
      const serialized: (string | number)[] = [];
      // 不过滤空项或重排列表；任何无效项都阻止整个输入提交。
      for (const [index, item] of items.entries()) {
        const value = editor.itemKind === 'number' ? arrayNumber(item) : item;
        if (
          (editor.itemKind === 'string' && typeof value === 'string' && value.trim() !== '') ||
          (editor.itemKind === 'number' && typeof value === 'number')
        ) {
          serialized.push(value);
        } else {
          issues.push({
            name: definition.name,
            code: 'invalid',
            message: `${definition.name} 第 ${index + 1} 项${editor.itemKind === 'number' ? '请输入有效数字' : '不能为空白'}`,
          });
        }
      }
      entries.push([definition.name, { storage: 'inline', type: editor.type, value: serialized }]);
      continue;
    }
    const runtimeValue = inlineValue(editor, field.value);
    if (!runtimeValue) {
      issues.push({
        name: definition.name,
        code: field.value === undefined ? 'required' : 'invalid',
        message: field.value === undefined ? '请提供必填输入' : `请输入有效的 ${editor.kind} 值`,
      });
      continue;
    }
    entries.push([definition.name, runtimeValue]);
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, inputs: Object.fromEntries(entries) };
}

export interface WorkflowRunIdentity {
  id: string;
  workflowVersionId: string;
  invocationKey: string;
  status: WorkflowRunStatus;
}

export interface WorkflowRunStartError {
  message: string;
  status: number;
  code?: string;
  requestId?: string;
  workflowRunId?: string;
  invocationKey?: string;
}

export interface WorkflowRunState {
  phase: 'idle' | 'submitting' | 'accepted' | 'error';
  request: StartWorkflowRunRequest | null;
  accepted: WorkflowRunIdentity | null;
  error: WorkflowRunStartError | null;
}

interface WorkflowRunOperations {
  createInvocationKey(): string;
  start(request: StartWorkflowRunRequest): Promise<WorkflowRunResponse>;
}

function freezeSnapshot<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeSnapshot(child);
  return Object.freeze(value);
}

function startError(error: unknown): WorkflowRunStartError {
  const details =
    error instanceof ApiError && typeof error.details === 'object' && error.details !== null
      ? (error.details as Record<string, unknown>)
      : null;
  const stringDetail = (key: string) =>
    typeof details?.[key] === 'string' ? details[key] : undefined;
  return {
    message: error instanceof Error ? error.message : '运行请求结果未确认',
    status: error instanceof ApiError ? error.status : 0,
    ...(stringDetail('code') ? { code: stringDetail('code') } : {}),
    ...(stringDetail('requestId') ? { requestId: stringDetail('requestId') } : {}),
    ...(stringDetail('workflowRunId') ? { workflowRunId: stringDetail('workflowRunId') } : {}),
    ...(stringDetail('invocationKey') ? { invocationKey: stringDetail('invocationKey') } : {}),
  };
}

export class WorkflowRunController {
  private state: WorkflowRunState = {
    phase: 'idle',
    request: null,
    accepted: null,
    error: null,
  };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly operations: WorkflowRunOperations) {}

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(change: Partial<WorkflowRunState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  confirm(run: WorkflowRunResponse) {
    if (this.state.phase === 'submitting') return;
    if (
      this.state.request &&
      (this.state.request.invocationKey !== run.invocationKey ||
        this.state.request.workflowVersionId !== run.workflowVersionId)
    )
      return;
    this.update({
      phase: 'accepted',
      accepted: {
        id: run.id,
        workflowVersionId: run.workflowVersionId,
        invocationKey: run.invocationKey,
        status: run.status,
      },
      error: null,
    });
  }

  async startNew(invocation: Omit<StartWorkflowRunRequest, 'invocationKey'>): Promise<void> {
    if (this.state.phase === 'submitting') return;
    const request = freezeSnapshot(
      startWorkflowRunRequestSchema.parse(
        structuredClone({
          ...invocation,
          invocationKey: this.operations.createInvocationKey(),
        }),
      ),
    );
    await this.submit(request);
  }

  async retry(): Promise<void> {
    if (this.state.phase !== 'error' || !this.state.request) return;
    await this.submit(this.state.request);
  }

  private async submit(request: StartWorkflowRunRequest): Promise<void> {
    if (this.state.phase === 'submitting') return;
    this.update({
      phase: 'submitting',
      request,
      accepted: null,
      error: null,
    });
    try {
      const run = await this.operations.start(request);
      if (
        run.workflowVersionId !== request.workflowVersionId ||
        run.invocationKey !== request.invocationKey
      )
        throw new ApiError('返回的运行身份与本次请求不匹配', 200);
      this.update({
        phase: 'accepted',
        accepted: {
          id: run.id,
          workflowVersionId: run.workflowVersionId,
          invocationKey: run.invocationKey,
          status: run.status,
        },
        error: null,
      });
    } catch (error) {
      this.update({
        phase: 'error',
        accepted: null,
        error: startError(error),
      });
    }
  }
}
