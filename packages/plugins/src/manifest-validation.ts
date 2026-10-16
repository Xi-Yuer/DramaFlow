import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { jsonObjectSchema } from '@dramaflow/contracts';
import type { Capability, JsonObject, JsonSchema, PluginManifest } from '@dramaflow/contracts';

export interface ManifestValidation {
  valid: boolean;
  value?: JsonObject;
  issues: { path: string; message: string }[];
}

const ajv = new Ajv2020({ allErrors: true, useDefaults: true, strict: true });
// ajv-formats publishes a CommonJS callable with an explicit default property.
addFormats.default(ajv);
const validators = new Map<string, ValidateFunction>();

function validate(schema: JsonSchema, input: unknown): ManifestValidation {
  const parsed = jsonObjectSchema.safeParse(input);
  if (!parsed.success)
    return { valid: false, issues: [{ path: '', message: '参数必须为 JSON 对象' }] };
  const value = structuredClone(parsed.data);
  const key = JSON.stringify(schema);
  let validator = validators.get(key);
  if (!validator) {
    validator = ajv.compile(schema);
    if (validators.size >= 100) validators.clear();
    validators.set(key, validator);
  }
  const valid = validator(value);
  return valid
    ? { valid: true, value, issues: [] }
    : {
        valid: false,
        issues: (validator.errors ?? []).map((error) => ({
          path: error.instancePath,
          message: error.message ?? '不符合参数约束',
        })),
      };
}

/** Browser-safe validation follows each plugin's published JSON Schema, with no adapter or secret loading. */
export function validateManifestParameters(
  manifest: PluginManifest,
  capability: Capability,
  parameters: unknown,
): ManifestValidation {
  const schema = manifest.parametersSchema[capability];
  if (!manifest.capabilities.includes(capability) || !schema)
    return { valid: false, issues: [{ path: '', message: '插件未提供此能力的参数协议' }] };
  return validate(schema, parameters);
}

export function validateManifestConnection(
  manifest: PluginManifest,
  configuration: unknown,
): ManifestValidation {
  return validate(manifest.connectionSchema, configuration);
}
