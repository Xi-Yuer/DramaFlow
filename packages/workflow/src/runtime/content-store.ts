import type {
  Artifact,
  ArtifactReference,
  Asset,
  AssetReference,
  DataType,
} from '@dramaflow/contracts';
import type { RuntimeValueContext } from './value-codec.js';

// 所有方法都带项目归属；实现必须检查授权及固定版本，禁止只凭 ID 直接读取。
export interface ArtifactStore {
  create(value: unknown, type: DataType, context: RuntimeValueContext): Promise<ArtifactReference>;
  get(reference: ArtifactReference, context: RuntimeValueContext): Promise<Artifact>;
  resolve(reference: ArtifactReference, context: RuntimeValueContext): Promise<unknown>;
}
export interface AssetStore {
  get(reference: AssetReference, context: RuntimeValueContext): Promise<Asset>;
  resolve(reference: AssetReference, context: RuntimeValueContext): Promise<unknown>;
  promote(
    artifact: ArtifactReference,
    name: string,
    context: RuntimeValueContext,
  ): Promise<AssetReference>;
}
