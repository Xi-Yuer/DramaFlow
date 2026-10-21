import { z } from 'zod';
import {
  providerPluginDescriptionSchema,
  type ProviderPluginDescription,
} from '@dramaflow/contracts';
import {
  CapabilityError,
  externalCapabilityError,
  type CapabilityErrorCode,
} from './capability-error.js';
import type {
  InvokeCapabilityInput,
  ProviderCapability,
  ProviderPlugin,
} from './provider-plugin.js';

const pluginIdSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(?:[.-][a-z][a-z0-9_]*)*$/);
const capabilityTypeSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);
const versionSchema = z.number().int().positive();
const jsonObjectSchema = z.record(z.string(), z.json());

function parse<T>(schema: z.ZodType<T>, value: unknown, code: CapabilityErrorCode): T {
  try {
    return schema.parse(value);
  } catch {
    // ZodIssue 可能包含输入/凭证内容；不把原始验证异常带出此边界。
    throw new CapabilityError(code);
  }
}

function parseObject(schema: z.ZodObject, value: unknown, code: CapabilityErrorCode) {
  const input = parse(jsonObjectSchema, value, code);
  return parse(jsonObjectSchema, parse(schema, input, code), code);
}

export class PluginRegistry {
  private readonly plugins = new Map<string, ProviderPlugin>();

  constructor(plugins: readonly ProviderPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: ProviderPlugin): void {
    parse(pluginIdSchema, plugin.id, 'PLUGIN_REGISTRATION_INVALID');
    parse(versionSchema, plugin.version, 'PLUGIN_REGISTRATION_INVALID');
    if (
      !(plugin.configSchema instanceof z.ZodObject) ||
      !(plugin.credentialsSchema instanceof z.ZodObject)
    )
      throw new CapabilityError('PLUGIN_REGISTRATION_INVALID');
    const seen = new Set<string>();
    const capabilities = plugin.capabilities.map((capability) => {
      parse(capabilityTypeSchema, capability.type, 'PLUGIN_REGISTRATION_INVALID');
      if (
        seen.has(capability.type) ||
        !(capability.inputSchema instanceof z.ZodType) ||
        !(capability.outputSchema instanceof z.ZodType) ||
        !(capability.modelSettingsSchema instanceof z.ZodObject) ||
        typeof capability.invoke !== 'function'
      )
        throw new CapabilityError('PLUGIN_REGISTRATION_INVALID');
      seen.add(capability.type);
      return Object.freeze({
        ...(capability.metadata ? { metadata: Object.freeze({ ...capability.metadata }) } : {}),
        type: capability.type,
        inputSchema: capability.inputSchema,
        outputSchema: capability.outputSchema,
        modelSettingsSchema: capability.modelSettingsSchema,
        invoke: capability.invoke.bind(capability),
      });
    });
    const key = JSON.stringify([plugin.id, plugin.version]);
    if (this.plugins.has(key)) throw new CapabilityError('PLUGIN_ALREADY_REGISTERED');
    this.plugins.set(
      key,
      Object.freeze({
        ...(plugin.management ? { management: Object.freeze({ ...plugin.management }) } : {}),
        id: plugin.id,
        version: plugin.version,
        configSchema: plugin.configSchema,
        credentialsSchema: plugin.credentialsSchema,
        capabilities: Object.freeze(capabilities),
      }),
    );
  }

  get(pluginId: string, version: number): ProviderPlugin {
    if (!pluginIdSchema.safeParse(pluginId).success || !versionSchema.safeParse(version).success)
      throw new CapabilityError('PLUGIN_NOT_AVAILABLE');
    const plugin = this.plugins.get(JSON.stringify([pluginId, version]));
    if (!plugin) throw new CapabilityError('PLUGIN_NOT_AVAILABLE');
    return plugin;
  }

  getCapability(pluginId: string, version: number, type: string): ProviderCapability {
    const capability = this.get(pluginId, version).capabilities.find(
      (candidate) => candidate.type === type,
    );
    if (!capability) throw new CapabilityError('CAPABILITY_NOT_AVAILABLE');
    return capability;
  }

  getConfigurable(pluginId: string, version: number): ProviderPlugin {
    const plugin = this.get(pluginId, version);
    if (!plugin.management) throw new CapabilityError('PLUGIN_NOT_AVAILABLE');
    return plugin;
  }

  listConfigurable(): ProviderPluginDescription[] {
    return [...this.plugins.values()]
      .filter((plugin) => plugin.management)
      .map((plugin) => {
        const credentials = z.toJSONSchema(plugin.credentialsSchema, { io: 'input' });
        const required = new Set(credentials.required ?? []);
        return providerPluginDescriptionSchema.parse({
          id: plugin.id,
          version: plugin.version,
          ...plugin.management,
          configurationSchema: z.toJSONSchema(plugin.configSchema, { io: 'input' }),
          credentialFields: Object.entries(credentials.properties ?? {}).map(([key, value]) => ({
            key,
            required: required.has(key),
            ...(typeof value === 'object' && typeof value.minLength === 'number'
              ? { minLength: value.minLength }
              : {}),
            ...(typeof value === 'object' && typeof value.maxLength === 'number'
              ? { maxLength: value.maxLength }
              : {}),
          })),
          capabilities: plugin.capabilities.map((capability) => ({
            type: capability.type,
            name: capability.metadata?.name ?? capability.type,
            ...(capability.metadata?.description
              ? { description: capability.metadata.description }
              : {}),
            modelSettingsSchema: z.toJSONSchema(capability.modelSettingsSchema, { io: 'input' }),
          })),
        });
      })
      .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
  }

  async invoke(request: InvokeCapabilityInput): Promise<unknown> {
    const plugin = this.get(request.pluginId, request.pluginVersion);
    const capability = this.getCapability(
      request.pluginId,
      request.pluginVersion,
      request.capability,
    );
    const configuration = parseObject(
      plugin.configSchema,
      request.configuration,
      'CAPABILITY_CONFIGURATION_INVALID',
    );
    const credentials = parseObject(
      plugin.credentialsSchema,
      request.credentials,
      'CAPABILITY_CREDENTIALS_INVALID',
    );
    const settings = parseObject(
      capability.modelSettingsSchema,
      request.settings,
      'CAPABILITY_SETTINGS_INVALID',
    );
    const model = parse(
      z.string().trim().min(1).max(200),
      request.model,
      'CAPABILITY_MODEL_INVALID',
    );
    const input = parse(capability.inputSchema, request.input, 'CAPABILITY_INPUT_INVALID');
    let result: unknown;
    try {
      result = await capability.invoke(input, {
        configuration,
        credentials,
        model,
        settings,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      if (error instanceof CapabilityError)
        throw new CapabilityError(error.code, {
          status: error.status,
          outcome: error.outcome,
        });
      throw externalCapabilityError(error);
    }
    return parse(capability.outputSchema, result, 'CAPABILITY_OUTPUT_INVALID');
  }
}
