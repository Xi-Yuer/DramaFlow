import { z } from 'zod';
import { workflowIdentifierSchema, workflowPortNameSchema } from './metadata.js';

const dataEdgeEndpointSchema = z
  .object({ nodeId: workflowIdentifierSchema, portKey: workflowPortNameSchema })
  .strict();

export const dataEdgeDefinitionSchema = z
  .object({
    id: workflowIdentifierSchema,
    kind: z.literal('data'),
    source: dataEdgeEndpointSchema,
    target: dataEdgeEndpointSchema,
  })
  .strict();

// 目前只定义数据边；后续边种类需明确协议后再扩展此联合。
export const workflowEdgeSchema = z.discriminatedUnion('kind', [dataEdgeDefinitionSchema]);

export type DataEdgeDefinition = z.infer<typeof dataEdgeDefinitionSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
