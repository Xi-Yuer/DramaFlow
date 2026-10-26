import { z } from 'zod';
import { graphDraftDefinitionSchema, type GraphDefinition } from '../graph/definition.js';
import type { NodeTypeManifest } from './manifest.js';

// 同一不可变版本内的固定单次调用；父 Node inputs 即子图同名输入绑定。
export interface SubworkflowCompositeDefinition {
  kind: 'subworkflow';
  graph: GraphDefinition;
}
export const subworkflowCompositeDefinitionFields = () => ({
  kind: z.literal('subworkflow'),
  graph: z.lazy(() => graphDraftDefinitionSchema),
});
export const subworkflowCompositeDefinitionSchema: z.ZodType<SubworkflowCompositeDefinition> =
  z.lazy(() => z.object(subworkflowCompositeDefinitionFields()).strict());

export function isSubworkflowNodeManifest(manifest: NodeTypeManifest): boolean {
  return (
    manifest.type === 'flow.subworkflow' &&
    manifest.version === 1 &&
    manifest.executionKind === 'composite' &&
    manifest.portDerivation === 'subworkflow'
  );
}
