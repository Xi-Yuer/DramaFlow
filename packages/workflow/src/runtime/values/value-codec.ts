import type { RuntimeValueDecodeContext } from './runtime-value-codec.js';

export interface RuntimeValueContext extends RuntimeValueDecodeContext {
  readonly nodeRunId?: string;
}
