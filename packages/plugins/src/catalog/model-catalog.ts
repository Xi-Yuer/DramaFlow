import {
  modelCatalogItemSchema,
  modelCatalogModelIdSchema,
  type ModelCatalogItem,
} from '@dramaflow/contracts';
import { CapabilityError } from '../plugin/capability-error.js';
import { ANTHROPIC_PROVIDER_ID, OPENAI_PROVIDER_ID, ProviderCatalog } from './provider-catalog.js';

export interface ModelDefinitionInput {
  readonly id: string;
  readonly displayName: string;
  readonly providerDefinitionId: string;
  readonly capabilities: readonly string[];
}

interface ModelDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly providerDefinitionId: string;
  readonly capabilities: readonly string[];
}

function failRegistration(): never {
  throw new CapabilityError('PLUGIN_REGISTRATION_INVALID');
}

export class ModelCatalog {
  private readonly definitions: ModelDefinition[] = [];

  constructor(
    private readonly providers: ProviderCatalog,
    definitions: readonly ModelDefinitionInput[],
  ) {
    const seen = new Set<string>();
    for (const definition of definitions) this.register(definition, seen);
  }

  private register(input: ModelDefinitionInput, seen: Set<string>): void {
    const id = modelCatalogModelIdSchema.safeParse(input.id);
    const displayName = input.displayName.trim();
    if (!id.success || displayName.length === 0 || displayName.length > 80) failRegistration();
    if (
      input.capabilities.length === 0 ||
      new Set(input.capabilities).size !== input.capabilities.length
    )
      failRegistration();
    const key = `${input.providerDefinitionId}\0${id.data}`;
    if (seen.has(key)) failRegistration();
    let allowed: ReadonlySet<string>;
    try {
      allowed = new Set(this.providers.get(input.providerDefinitionId).capabilities);
    } catch {
      failRegistration();
    }
    if (input.capabilities.some((capability) => !allowed.has(capability))) failRegistration();
    seen.add(key);
    this.definitions.push({
      id: id.data,
      displayName,
      providerDefinitionId: input.providerDefinitionId,
      capabilities: [...input.capabilities],
    });
  }

  list(capability?: string): ModelCatalogItem[] {
    return this.definitions
      .filter(
        (definition) => capability === undefined || definition.capabilities.includes(capability),
      )
      .sort(
        (left, right) =>
          left.providerDefinitionId.localeCompare(right.providerDefinitionId) ||
          left.id.localeCompare(right.id),
      )
      .map((definition) => this.describe(definition));
  }

  private describe(definition: ModelDefinition): ModelCatalogItem {
    const provider = this.providers
      .list()
      .find((item) => item.id === definition.providerDefinitionId);
    return modelCatalogItemSchema.parse({
      id: definition.id,
      displayName: definition.displayName,
      providerDefinitionId: definition.providerDefinitionId,
      capabilities: definition.capabilities.map((type) => ({
        type,
        name: provider?.capabilities.find((item) => item.type === type)?.name ?? type,
      })),
    });
  }
}

export function createOfficialModelCatalog(providers: ProviderCatalog): ModelCatalog {
  return new ModelCatalog(providers, [
    {
      id: 'gpt-4o',
      displayName: 'GPT-4o',
      providerDefinitionId: OPENAI_PROVIDER_ID,
      capabilities: ['text.generate'],
    },
    {
      id: 'claude-sonnet-4-20250514',
      displayName: 'Claude Sonnet 4',
      providerDefinitionId: ANTHROPIC_PROVIDER_ID,
      capabilities: ['text.generate'],
    },
  ]);
}
