import type { NodeTypeManifest } from '@dramaflow/contracts';
import type { NodeSchemas } from './schemas.js';
import type { NodeExecutionContext } from '../runtime/node-executor.js';
import type { z } from 'zod';

export interface NodeDeclaration extends NodeSchemas {
  readonly manifest: NodeTypeManifest;
  readonly execute?: NodeType['execute'];
}

export interface NodeType<Input = unknown, Config = unknown, Output = unknown> extends NodeSchemas {
  readonly manifest: NodeTypeManifest;
  readonly inputSchema: z.ZodObject & z.ZodType<Input>;
  readonly configSchema: z.ZodObject & z.ZodType<Config>;
  readonly outputSchema: z.ZodObject & z.ZodType<Output>;
  execute(input: Input, config: Config, context: NodeExecutionContext): Promise<Output>;
}
