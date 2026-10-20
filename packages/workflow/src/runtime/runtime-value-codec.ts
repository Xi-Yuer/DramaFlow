import type { RuntimeValue } from '@dramaflow/contracts';
import { ReferenceResolutionError, type DataReferenceResolver } from './data-reference-resolver.js';

export interface RuntimeValueDecodeContext {
  readonly projectId: string;
  readonly workflowRunId: string;
}

export interface RuntimeValueCodec {
  decode(value: RuntimeValue, context: RuntimeValueDecodeContext): Promise<unknown>;
  decodeRecord(
    values: Readonly<Record<string, RuntimeValue>>,
    context: RuntimeValueDecodeContext,
  ): Promise<Record<string, unknown>>;
}

export class DefaultRuntimeValueCodec implements RuntimeValueCodec {
  constructor(private readonly referenceResolver: DataReferenceResolver) {}

  async decode(value: RuntimeValue, context: RuntimeValueDecodeContext): Promise<unknown> {
    if (value.storage === 'inline') return value.value;

    try {
      return await this.referenceResolver.resolve(value.reference, context);
    } catch (error) {
      if (error instanceof ReferenceResolutionError) throw error;
      throw new ReferenceResolutionError(value.reference, { cause: error });
    }
  }

  async decodeRecord(
    values: Readonly<Record<string, RuntimeValue>>,
    context: RuntimeValueDecodeContext,
  ): Promise<Record<string, unknown>> {
    const entries = await Promise.all(
      Object.entries(values).map(
        async ([key, value]) => [key, await this.decode(value, context)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }
}
