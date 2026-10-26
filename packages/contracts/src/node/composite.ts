import { z } from 'zod';
import {
  iterationCompositeDefinitionFields,
  type IterationCompositeDefinition,
} from './iteration.js';
import {
  subworkflowCompositeDefinitionFields,
  type SubworkflowCompositeDefinition,
} from './subworkflow.js';

export type CompositeDefinition = IterationCompositeDefinition | SubworkflowCompositeDefinition;
// Lazy schemas 保留递归 GraphDefinition；分支自身以 kind 判别且拒绝混用字段。
export const compositeDefinitionSchema: z.ZodType<CompositeDefinition> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object(iterationCompositeDefinitionFields()).strict(),
    z.object(subworkflowCompositeDefinitionFields()).strict(),
  ]),
);
