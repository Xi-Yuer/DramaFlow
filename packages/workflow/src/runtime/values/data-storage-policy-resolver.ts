import type { DataStoragePolicy, DataType } from '@dramaflow/contracts';

export type ResolvedDataStoragePolicy = Exclude<DataStoragePolicy, 'auto'>;

export interface DataStoragePolicyResolver {
  resolve(type: DataType, value: unknown): ResolvedDataStoragePolicy;
}

const namedPolicies: ReadonlyMap<string, ResolvedDataStoragePolicy> = new Map([
  ['system.json', 'inline'],
  ['story.character', 'inline'],
  ['story.scene', 'inline'],
  ['media.file', 'reference'],
  ['media.image', 'reference'],
  ['media.video', 'reference'],
  ['media.audio', 'reference'],
  ['media.document', 'reference'],
]);

export class DataStoragePolicyResolutionError extends Error {
  readonly code = 'DATA_STORAGE_POLICY_NOT_FOUND';

  constructor(public readonly type: DataType) {
    super(`数据类型尚未声明自动存储策略：${type.kind === 'named' ? type.name : type.kind}`);
    this.name = 'DataStoragePolicyResolutionError';
  }
}

export class DefaultDataStoragePolicyResolver implements DataStoragePolicyResolver {
  private readonly policies: ReadonlyMap<string, ResolvedDataStoragePolicy>;

  constructor(additionalPolicies: ReadonlyMap<string, ResolvedDataStoragePolicy> = new Map()) {
    this.policies = new Map([...namedPolicies, ...additionalPolicies]);
  }

  resolve(type: DataType, _value: unknown): ResolvedDataStoragePolicy {
    if (type.kind === 'primitive') return 'inline';
    if (type.kind === 'named') {
      const policy = this.policies.get(type.name);
      if (policy !== undefined) return policy;
    }
    // any / 结构类型也要求显式策略或另行注入规则，避免把嵌套媒体误放进 State。
    throw new DataStoragePolicyResolutionError(type);
  }
}
