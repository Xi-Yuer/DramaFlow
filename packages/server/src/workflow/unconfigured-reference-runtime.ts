import type { ArtifactWriter, DataReferenceResolver } from '@dramaflow/workflow';

export class WorkflowRuntimeNotConfiguredError extends Error {
  constructor(
    public readonly code: 'REFERENCE_RUNTIME_NOT_CONFIGURED' | 'ARTIFACT_WRITER_NOT_CONFIGURED',
  ) {
    super(
      code === 'REFERENCE_RUNTIME_NOT_CONFIGURED'
        ? '尚未配置运行时引用解析服务'
        : '尚未配置 Artifact 写入服务',
    );
    this.name = 'WorkflowRuntimeNotConfiguredError';
  }
}

// 明确拒绝尚未接入的能力，不解析内容、不返回占位结果，也不回退到 inline。
export class UnconfiguredDataReferenceResolver implements DataReferenceResolver {
  async resolve(): Promise<never> {
    throw new WorkflowRuntimeNotConfiguredError('REFERENCE_RUNTIME_NOT_CONFIGURED');
  }
}

export class UnconfiguredArtifactWriter implements ArtifactWriter {
  async write(): Promise<never> {
    throw new WorkflowRuntimeNotConfiguredError('ARTIFACT_WRITER_NOT_CONFIGURED');
  }
}
