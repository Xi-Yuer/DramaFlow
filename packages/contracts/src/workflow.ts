import { z } from 'zod';

const identifierSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), '标识不能包含首尾空白');

export const workflowPortNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, '输入输出名称须以英文字母开头，仅包含字母、数字和下划线')
  .refine(
    (value) => !['constructor', 'prototype'].includes(value),
    '输入输出名称不能使用保留属性名',
  );

export const workflowOutputSourceSchema = z
  .object({ nodeId: identifierSchema, outputKey: workflowPortNameSchema })
  .strict();

export const workflowMetadataSchema = z
  .object({
    id: identifierSchema,
    projectId: identifierSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const workflowVersionMetadataSchema = z
  .object({
    id: identifierSchema,
    workflowId: identifierSchema,
    version: z.number().int().positive(),
    publishedAt: z.iso.datetime(),
  })
  .strict();

export const workflowRunStatusSchema = z.enum([
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);

// 仅校验运行元数据；输入输出值必须另外依据版本契约校验。
export const workflowRunMetadataSchema = z
  .object({
    id: identifierSchema,
    workflowId: identifierSchema,
    workflowVersionId: identifierSchema,
    status: workflowRunStatusSchema,
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
  })
  .strict();

export type WorkflowMetadata = z.infer<typeof workflowMetadataSchema>;
export type WorkflowVersionMetadata = z.infer<typeof workflowVersionMetadataSchema>;
export type WorkflowRunMetadata = z.infer<typeof workflowRunMetadataSchema>;
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;
export type WorkflowOutputSource = z.infer<typeof workflowOutputSourceSchema>;

// Node、Edge、DataType 必须由调用方提供真实 Schema，没有宽松的默认协议。
export function createWorkflowSchemas<
  DataTypeSchema extends z.ZodType,
  NodeSchema extends z.ZodType<{ id: string }>,
  EdgeSchema extends z.ZodType,
>(schemas: { dataType: DataTypeSchema; node: NodeSchema; edge: EdgeSchema }) {
  const inputSchema = z.object({ name: workflowPortNameSchema, type: schemas.dataType }).strict();
  const outputSchema = inputSchema.extend({ source: workflowOutputSourceSchema });
  const definitionSchema = z
    .object({
      inputs: z.array(inputSchema),
      nodes: z.array(schemas.node),
      edges: z.array(schemas.edge),
      outputs: z.array(outputSchema),
    })
    .strict()
    .superRefine((definition, context) => {
      for (const [field, values] of [
        ['inputs', definition.inputs.map((input) => input.name)],
        ['nodes', definition.nodes.map((node) => node.id)],
        ['outputs', definition.outputs.map((output) => output.name)],
      ] as const) {
        const seen = new Set<string>();
        values.forEach((value, index) => {
          if (seen.has(value)) {
            context.addIssue({
              code: 'custom',
              path: [field, index, field === 'nodes' ? 'id' : 'name'],
              message: '名称或标识不能重复',
            });
          }
          seen.add(value);
        });
      }
      const nodeIds = new Set(definition.nodes.map((node) => node.id));
      definition.outputs.forEach((output, index) => {
        if (!nodeIds.has(output.source.nodeId)) {
          context.addIssue({
            code: 'custom',
            path: ['outputs', index, 'source', 'nodeId'],
            message: '工作流输出引用了不存在的节点',
          });
        }
      });
    });
  return {
    inputSchema,
    outputSchema,
    definitionSchema,
    workflowSchema: workflowMetadataSchema.extend({ draft: definitionSchema }),
    versionSchema: workflowVersionMetadataSchema.extend({ definition: definitionSchema }),
  };
}
