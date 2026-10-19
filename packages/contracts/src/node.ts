import { z } from 'zod';
import {
  workflowIdentifierSchema,
  workflowOutputSourceSchema,
  workflowPortNameSchema,
} from './workflow.js';

export const inputBindingSchema = z
  .object({ target: workflowPortNameSchema, source: workflowOutputSourceSchema })
  .strict();

export const nodeDefinitionSchema = z
  .object({
    id: workflowIdentifierSchema,
    type: workflowIdentifierSchema,
    name: z.string().trim().min(1).max(80),
    inputs: z.array(inputBindingSchema),
    config: z.record(z.string(), z.json()),
    preset: workflowIdentifierSchema.optional(),
    ui: z
      .object({
        position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((node, context) => {
    const targets = new Set<string>();
    node.inputs.forEach((binding, index) => {
      if (targets.has(binding.target)) {
        context.addIssue({
          code: 'custom',
          path: ['inputs', index, 'target'],
          message: '同一输入端口不能重复绑定；集合输入需使用明确的集合契约',
        });
      }
      targets.add(binding.target);
    });
  });

// 保留连线的完整端口映射；是否激活节点与如何读取数据仍是不同语义。
export const edgeDefinitionSchema = z
  .object({
    id: workflowIdentifierSchema,
    sourceNodeId: workflowIdentifierSchema,
    sourceHandle: workflowPortNameSchema,
    targetNodeId: workflowIdentifierSchema,
    targetHandle: workflowPortNameSchema,
  })
  .strict();

export const nodePresetSchema = z
  .object({
    id: workflowIdentifierSchema,
    type: workflowIdentifierSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().optional(),
    config: z.record(z.string(), z.json()),
  })
  .strict();

export const nodeRunStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'waiting',
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);

export const nodeRunErrorSchema = z
  .object({ code: workflowIdentifierSchema, message: z.string() })
  .strict();

// 仅校验记录结构，不隐式执行状态转换或将原始 Error / 供应商响应写入记录。
export const nodeRunSchema = z
  .object({
    id: workflowIdentifierSchema,
    workflowRunId: workflowIdentifierSchema,
    nodeId: workflowIdentifierSchema,
    status: nodeRunStatusSchema,
    inputs: z.record(z.string(), z.json()),
    outputs: z.record(z.string(), z.json()).optional(),
    error: nodeRunErrorSchema.optional(),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
  })
  .strict();

export type InputBinding = z.infer<typeof inputBindingSchema>;
export type NodeDefinition = z.infer<typeof nodeDefinitionSchema>;
export type EdgeDefinition = z.infer<typeof edgeDefinitionSchema>;
export type NodePreset = z.infer<typeof nodePresetSchema>;
export type NodeRun = z.infer<typeof nodeRunSchema>;
export type NodeRunStatus = z.infer<typeof nodeRunStatusSchema>;
