import {
  NodeExecutionError,
  ReferenceResolutionError,
  WorkflowRunNotWaitingError,
  WorkflowRunNotPendingError,
  WorkflowRunRecordingError,
} from '@dramaflow/workflow';
import { describe, expect, it } from 'vitest';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { workflowRuntimeHttpError } from './workflow-runtime-http-error.js';

describe('Runtime HTTP 错误边界', () => {
  it('领域修订冲突保持 409，Checkpoint unavailable 保持 503，均只返回白名单说明', () => {
    const revision = workflowRuntimeHttpError(
      new ConflictException({
        code: 'WORKFLOW_REVISION_CONFLICT',
        message: 'private',
      }),
      'WORKFLOW_RUN_NOT_FOUND',
    );
    expect(revision.getStatus()).toBe(409);
    expect(revision.getResponse()).toMatchObject({
      code: 'WORKFLOW_REVISION_CONFLICT',
    });
    const checkpoint = workflowRuntimeHttpError(
      new ServiceUnavailableException({
        code: 'WORKFLOW_CHECKPOINT_UNAVAILABLE',
        message: 'private database error',
      }),
      'WORKFLOW_RUN_NOT_FOUND',
    );
    expect(checkpoint.getStatus()).toBe(503);
    expect(checkpoint.getResponse()).toMatchObject({
      code: 'WORKFLOW_CHECKPOINT_UNAVAILABLE',
    });
    expect(
      JSON.stringify([revision.getResponse(), checkpoint.getResponse()]),
    ).not.toContain('private');
  });
  it('waiting claim 冲突映射为 409，保留稳定码且不返回原异常', () => {
    const mapped = workflowRuntimeHttpError(
      new WorkflowRunNotWaitingError('private-run'),
      'WORKFLOW_RUN_NOT_FOUND',
    );
    expect(mapped.getStatus()).toBe(409);
    expect(mapped.getResponse()).toMatchObject({
      code: 'WORKFLOW_RUN_NOT_WAITING',
    });
    expect(JSON.stringify(mapped.getResponse())).not.toContain('private-run');
  });

  it('重复首次执行映射为 pending 冲突，不泄漏内部运行身份', () => {
    const mapped = workflowRuntimeHttpError(
      new WorkflowRunNotPendingError('private-run'),
      'WORKFLOW_RUN_NOT_FOUND',
    );
    expect(mapped.getStatus()).toBe(409);
    expect(mapped.getResponse()).toMatchObject({
      code: 'WORKFLOW_RUN_NOT_PENDING',
      message: '工作流运行当前不在 pending 状态',
    });
    expect(JSON.stringify(mapped.getResponse())).not.toContain('private-run');
  });

  it('节点异常保留阶段码，引用 / Writer 配置错误从 cause 链安全映射为 503', () => {
    const secret = new Error('s3-secret / signed-url / provider-response');
    const execution = workflowRuntimeHttpError(
      new NodeExecutionError('node', 'type', 'execute', secret),
      'WORKFLOW_RUN_NOT_FOUND',
    );
    expect(execution.getStatus()).toBe(500);
    expect(execution.getResponse()).toMatchObject({
      code: 'NODE_EXECUTION_FAILED',
    });
    for (const code of [
      'REFERENCE_RUNTIME_NOT_CONFIGURED',
      'ARTIFACT_WRITER_NOT_CONFIGURED',
    ]) {
      const cause = Object.assign(new Error('private configuration detail'), {
        code,
      });
      const wrapped = new NodeExecutionError(
        'node',
        'type',
        'decode_input',
        new ReferenceResolutionError(
          { kind: 'artifact', id: 'private-artifact' },
          { cause },
        ),
      );
      const mapped = workflowRuntimeHttpError(
        wrapped,
        'WORKFLOW_RUN_NOT_FOUND',
      );
      expect(mapped.getStatus()).toBe(503);
      expect(mapped.getResponse()).toMatchObject({ code });
      expect(JSON.stringify(mapped.getResponse())).not.toMatch(
        /private|stack|cause|signed-url/,
      );
    }
  });

  it('记录服务失败和未知异常不泄漏内容；循环 cause 不会导致无限遍历', () => {
    const error = new Error('private infrastructure message');
    Object.defineProperty(error, 'cause', { value: error });
    const mapped = workflowRuntimeHttpError(error, 'WORKFLOW_RUN_NOT_FOUND');
    expect(mapped.getStatus()).toBe(500);
    expect(mapped.getResponse()).toMatchObject({
      code: 'WORKFLOW_RUNTIME_FAILED',
    });
    const recording = workflowRuntimeHttpError(
      new WorkflowRunRecordingError('run', error, error),
      'WORKFLOW_RUN_NOT_FOUND',
    );
    expect(recording.getStatus()).toBe(503);
    expect(recording.getResponse()).toMatchObject({
      code: 'WORKFLOW_RUN_RECORDING_FAILED',
    });
    expect(JSON.stringify(recording.getResponse())).not.toMatch(
      /private|cause|stack/,
    );
  });
});
