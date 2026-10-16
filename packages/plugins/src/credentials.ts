import { z } from 'zod';
import type { CredentialField, PluginManifest } from '@dramaflow/contracts';

function fieldSchema(field: CredentialField) {
  let schema = z.string().trim().max(2000);
  if (field.key === 'baseUrl')
    schema = schema.refine(
      (value) => value === '' || /^https:\/\/\S+$/.test(value),
      '接口地址需要是 https 链接',
    );
  if (field.required) return schema.min(1, `请填写${field.label}`);
  return schema;
}

export function credentialSchema(manifest: PluginManifest) {
  const shape: Record<string, z.ZodType<string>> = {};
  for (const field of manifest.credentialFields) shape[field.key] = fieldSchema(field);
  return z.object(shape).strict();
}

/** 合并本次提交与已保存的凭证。空的密钥字段表示保持原值。 */
export function normalizeCredentials(
  manifest: PluginManifest,
  incoming: Record<string, string>,
  previous: Record<string, string> = {},
) {
  const merged: Record<string, string> = {};
  for (const field of manifest.credentialFields) {
    const value = incoming[field.key];
    const stored = previous[field.key];
    if (field.secret && (value === undefined || value.trim() === '')) {
      merged[field.key] = stored ?? '';
      continue;
    }
    if (value !== undefined && value.trim() !== '') merged[field.key] = value.trim();
    else if (stored) merged[field.key] = stored;
    else if (field.defaultValue) merged[field.key] = field.defaultValue;
    else merged[field.key] = '';
  }
  return credentialSchema(manifest).parse(merged);
}

export function publicCredentials(manifest: PluginManifest, credentials: Record<string, string>) {
  const visible: Record<string, string> = {};
  for (const field of manifest.credentialFields) {
    const value = credentials[field.key];
    if (!field.secret && value) visible[field.key] = value;
  }
  return visible;
}
