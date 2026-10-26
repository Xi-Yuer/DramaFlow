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

const controlEdgeEndpointSchema = z
  .object({ nodeId: workflowIdentifierSchema, portKey: workflowPortNameSchema.optional() })
  .strict();

export const controlEdgeDefinitionSchema = z
  .object({
    id: workflowIdentifierSchema,
    kind: z.literal('control'),
    source: controlEdgeEndpointSchema,
    target: controlEdgeEndpointSchema,
  })
  .strict();

export const workflowEdgeSchema = z.discriminatedUnion('kind', [
  dataEdgeDefinitionSchema,
  controlEdgeDefinitionSchema,
]);

export type DataEdgeDefinition = z.infer<typeof dataEdgeDefinitionSchema>;
export type ControlEdgeDefinition = z.infer<typeof controlEdgeDefinitionSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
