import { z } from 'zod';

export const workflowIdentifierSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), '标识不能包含首尾空白');

const identifierSchema = workflowIdentifierSchema;

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

// 仅校验运行元数据；threadId 是显式根 thread 标识，不从 id 自动推断。
// 输入输出值必须另外依据版本契约校验。
export const workflowRunMetadataSchema = z
  .object({
    id: identifierSchema,
    workflowId: identifierSchema,
    workflowVersionId: identifierSchema,
    threadId: identifierSchema,
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

// 只统一来源枚举，不包含路由、优先级或值选择语义。
export function workflowOutputSources(
  output:
    | { source: WorkflowOutputSource; sources?: never }
    | { source?: never; sources: readonly WorkflowOutputSource[] },
): readonly WorkflowOutputSource[] {
  return output.source === undefined ? output.sources : [output.source];
}

// Node、Edge、DataType 必须由调用方提供真实 Schema，没有宽松的默认协议。
export function createWorkflowSchemas<
  DataTypeSchema extends z.ZodType,
  NodeSchema extends z.ZodType<{ id: string }>,
  EdgeSchema extends z.ZodType,
>(schemas: { dataType: DataTypeSchema; node: NodeSchema; edge: EdgeSchema }) {
  const portFields = { name: workflowPortNameSchema, type: schemas.dataType };
  // 当前定义必须显式声明输入存在性语义。
  const inputSchema = z.object({ ...portFields, required: z.boolean() }).strict();
  const draftOutputSchema = z
    .union([
      z
        .object({
          ...portFields,
          source: workflowOutputSourceSchema,
          sources: z.never().optional(),
        })
        .strict(),
      z
        .object({
          ...portFields,
          source: z.never().optional(),
          sources: z.array(workflowOutputSourceSchema),
        })
        .strict(),
    ])
    .superRefine((output, context) => {
      const seen = new Set<string>();
      workflowOutputSources(output).forEach((source, index) => {
        const key = JSON.stringify([source.nodeId, source.outputKey]);
        if (seen.has(key))
          context.addIssue({
            code: 'custom',
            path: ['sources', index],
            message: '工作流输出候选来源不能重复',
          });
        seen.add(key);
      });
    });
  const outputSchema = draftOutputSchema.superRefine((output, context) => {
    if (output.sources !== undefined && output.sources.length < 2)
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: '多候选工作流输出至少需要两个来源',
      });
  });
  const draftDefinitionSchema = z
    .object({
      inputs: z.array(inputSchema),
      nodes: z.array(schemas.node),
      edges: z.array(schemas.edge),
      outputs: z.array(draftOutputSchema),
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
        workflowOutputSources(output).forEach((source, sourceIndex) => {
          if (!nodeIds.has(source.nodeId)) {
            context.addIssue({
              code: 'custom',
              path: [
                'outputs',
                index,
                ...(output.sources === undefined ? ['source'] : ['sources', sourceIndex]),
                'nodeId',
              ],
              message: '工作流输出引用了不存在的节点',
            });
          }
        });
      });
    });
  const definitionSchema = draftDefinitionSchema.superRefine((definition, context) => {
    definition.outputs.forEach((output, index) => {
      const parsed = outputSchema.safeParse(output);
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          context.addIssue({ ...issue, path: ['outputs', index, ...issue.path] });
    });
  });
  return {
    inputSchema,
    outputSchema,
    definitionSchema,
    draftDefinitionSchema,
    workflowSchema: workflowMetadataSchema.extend({ draft: draftDefinitionSchema }),
    versionSchema: workflowVersionMetadataSchema.extend({ definition: definitionSchema }),
  };
}
