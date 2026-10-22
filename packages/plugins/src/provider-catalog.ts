import {
  providerCatalogItemSchema,
  providerDefinitionIdSchema,
  type ProviderCatalogItem,
} from '@dramaflow/contracts';
import { z } from 'zod';
import { CapabilityError } from './capability-error.js';
import { credentialFieldsFromSchema, PluginRegistry } from './plugin-registry.js';
import type { ProviderPlugin } from './provider-plugin.js';

const jsonObjectSchema = z.record(z.string(), z.json());
const emptyUserConfigurationSchema = z.object({}).strict();

export const OPENAI_PROVIDER_ID = 'openai';
export const ANTHROPIC_PROVIDER_ID = 'anthropic';
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com/v1';

export class ProviderCatalogError extends Error {
  constructor(
    readonly code:
      'PROVIDER_DEFINITION_NOT_AVAILABLE' | 'PROVIDER_DEFINITION_CONFIGURATION_INVALID',
  ) {
    super('Provider 定义不可用或配置无效');
    this.name = 'ProviderCatalogError';
  }
}

export interface ProviderDefinitionInput {
  readonly id: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly pluginId: string;
  readonly pluginVersion: number;
  readonly capabilities: readonly string[];
  readonly implementationConfiguration: Readonly<Record<string, unknown>>;
  readonly configurationSchema: z.ZodObject;
}

interface ProviderDefinition extends ProviderDefinitionInput {
  readonly implementationConfiguration: Readonly<Record<string, unknown>>;
}

export interface MaterializedProvider {
  readonly providerDefinitionId: string;
  readonly pluginId: string;
  readonly pluginVersion: number;
  readonly configuration: z.infer<typeof jsonObjectSchema>;
  readonly credentials: Record<string, string>;
}

function failRegistration(): never {
  throw new CapabilityError('PLUGIN_REGISTRATION_INVALID');
}

export class ProviderCatalog {
  private readonly definitions = new Map<string, ProviderDefinition>();

  constructor(
    private readonly plugins: PluginRegistry,
    definitions: readonly ProviderDefinitionInput[],
  ) {
    for (const definition of definitions) this.register(definition);
  }

  private register(input: ProviderDefinitionInput): void {
    if (!providerDefinitionIdSchema.safeParse(input.id).success || this.definitions.has(input.id))
      failRegistration();
    if (
      input.displayName.trim().length === 0 ||
      input.displayName.length > 80 ||
      input.capabilities.length === 0 ||
      !(input.configurationSchema instanceof z.ZodObject)
    )
      failRegistration();
    const plugin = this.plugins.getConfigurable(input.pluginId, input.pluginVersion);
    const declared = new Set(plugin.capabilities.map((capability) => capability.type));
    if (input.capabilities.some((capability) => !declared.has(capability))) failRegistration();
    let implementationConfiguration: z.infer<typeof jsonObjectSchema>;
    try {
      implementationConfiguration = jsonObjectSchema.parse(
        plugin.configSchema.parse(input.implementationConfiguration),
      );
    } catch {
      failRegistration();
    }
    const userKeys = new Set(Object.keys(input.configurationSchema.shape));
    if (Object.keys(implementationConfiguration).some((key) => userKeys.has(key)))
      failRegistration();
    this.definitions.set(input.id, {
      ...input,
      displayName: input.displayName.trim(),
      capabilities: [...input.capabilities],
      implementationConfiguration,
    });
  }

  get(id: string): ProviderDefinition {
    if (!providerDefinitionIdSchema.safeParse(id).success)
      throw new ProviderCatalogError('PROVIDER_DEFINITION_NOT_AVAILABLE');
    const definition = this.definitions.get(id);
    if (!definition?.available) throw new ProviderCatalogError('PROVIDER_DEFINITION_NOT_AVAILABLE');
    return definition;
  }

  materialize(
    id: string,
    input: { readonly configuration?: unknown; readonly credentials: unknown },
  ): MaterializedProvider {
    const definition = this.get(id);
    const plugin = this.pluginFor(definition);
    try {
      const userConfiguration = definition.configurationSchema.parse(input.configuration ?? {});
      const configuration = jsonObjectSchema.parse(
        plugin.configSchema.parse({
          ...userConfiguration,
          ...definition.implementationConfiguration,
        }),
      );
      const credentials = z
        .record(z.string(), z.string())
        .parse(plugin.credentialsSchema.parse(input.credentials));
      return {
        providerDefinitionId: definition.id,
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        configuration,
        credentials,
      };
    } catch (error) {
      if (error instanceof ProviderCatalogError) throw error;
      throw new ProviderCatalogError('PROVIDER_DEFINITION_CONFIGURATION_INVALID');
    }
  }

  list(): ProviderCatalogItem[] {
    return [...this.definitions.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((definition) => this.describe(definition));
  }

  private pluginFor(definition: ProviderDefinition): ProviderPlugin {
    return this.plugins.getConfigurable(definition.pluginId, definition.pluginVersion);
  }

  private describe(definition: ProviderDefinition): ProviderCatalogItem {
    const plugin = this.pluginFor(definition);
    return providerCatalogItemSchema.parse({
      id: definition.id,
      displayName: definition.displayName,
      available: definition.available,
      capabilities: definition.capabilities.map((type) => {
        const capability = plugin.capabilities.find((item) => item.type === type);
        return { type, name: capability?.metadata?.name ?? type };
      }),
      credentialFields: credentialFieldsFromSchema(plugin.credentialsSchema),
      configurationSchema: z.toJSONSchema(definition.configurationSchema, { io: 'input' }),
    });
  }
}

export function createOfficialProviderCatalog(plugins: PluginRegistry): ProviderCatalog {
  return new ProviderCatalog(plugins, [
    {
      id: OPENAI_PROVIDER_ID,
      displayName: 'OpenAI',
      available: true,
      pluginId: 'text_generation',
      pluginVersion: 1,
      capabilities: ['text.generate'],
      implementationConfiguration: { provider: 'openai', baseURL: OPENAI_API_BASE_URL },
      configurationSchema: emptyUserConfigurationSchema,
    },
    {
      id: ANTHROPIC_PROVIDER_ID,
      displayName: 'Anthropic',
      available: true,
      pluginId: 'text_generation',
      pluginVersion: 1,
      capabilities: ['text.generate'],
      implementationConfiguration: { provider: 'anthropic', baseURL: ANTHROPIC_API_BASE_URL },
      configurationSchema: emptyUserConfigurationSchema,
    },
  ]);
}
