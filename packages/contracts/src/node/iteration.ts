import { z } from 'zod';
import { dataTypeSchema, type DataType } from '../data/type.js';
import {
  graphDraftDefinitionSchema,
  graphInputDefinitionSchema,
  type GraphDefinition,
  type GraphInputDefinition,
} from '../graph/definition.js';
import { workflowPortNameSchema } from '../workflow/metadata.js';

// 这是 composite 的调用映射来源，不扩充节点的 StaticInputBinding。
export const iterationBodyInputSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('current_item') }).strict(),
  z.object({ type: z.literal('current_index') }).strict(),
  z.object({ type: z.literal('iteration_input'), key: workflowPortNameSchema }).strict(),
]);
export const iterationBodyInputMappingSchema = z
  .object({
    target: workflowPortNameSchema,
    source: iterationBodyInputSourceSchema,
  })
  .strict();
export type IterationBodyInputMapping = z.infer<typeof iterationBodyInputMappingSchema>;
export interface IterationCompositeDefinition {
  kind: 'iteration';
  itemType: DataType;
  invariantInputs: GraphInputDefinition[];
  body: GraphDefinition;
  bodyInputMapping: IterationBodyInputMapping[];
}
// Draft 保留可编辑的不完整映射 / body；完整性和 capability 属于 Publish。
export const iterationCompositeDefinitionSchema: z.ZodType<IterationCompositeDefinition> = z.lazy(
  () =>
    z
      .object({
        kind: z.literal('iteration'),
        itemType: dataTypeSchema,
        invariantInputs: z.array(graphInputDefinitionSchema),
        body: graphDraftDefinitionSchema,
        bodyInputMapping: z.array(iterationBodyInputMappingSchema),
      })
      .strict(),
);

export function isIterationNodeManifest(
  manifest: import('./manifest.js').NodeTypeManifest,
): boolean {
  return (
    manifest.type === 'flow.iteration' &&
    manifest.version === 1 &&
    manifest.executionKind === 'composite' &&
    manifest.portDerivation === 'iteration'
  );
}
