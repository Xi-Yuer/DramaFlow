import type { JsonObject, WorkflowNode } from '@dramaflow/contracts';
import type { OperationRequest } from '../types.js';
import { nodeConfigSchemas } from '../catalog.js';
import { WorkflowInputError } from '../inputs.js';

export function operationRequest(
  node: WorkflowNode,
  state: { runId: string; attemptId: string },
  input: JsonObject,
  signal?: AbortSignal,
  itemId?: string,
): OperationRequest {
  const config =
    node.type === 'batch'
      ? nodeConfigSchemas.batch.parse(node.config)
      : nodeConfigSchemas.text.parse(node.config);
  const prompt = typeof input.prompt === 'string' ? input.prompt : config.prompt;
  if (!prompt.trim() && node.type !== 'batch')
    throw new WorkflowInputError('PROMPT_REQUIRED', '生成节点需要非空需求');
  const capability =
    node.type === 'batch'
      ? nodeConfigSchemas.batch.parse(node.config).capability
      : node.type === 'image'
        ? 'image.generate'
        : node.type === 'video'
          ? 'video.generate'
          : 'text.generate';
  return {
    operationId: `${state.runId}:${state.attemptId}:${node.id}:${itemId ?? 'main'}`,
    runId: state.runId,
    nodeId: node.id,
    attemptId: state.attemptId,
    model: config.model,
    capability,
    parameters: config.parameters,
    input: {
      ...input,
      prompt,
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    },
    ...(signal ? { signal } : {}),
    ...(itemId ? { itemId } : {}),
  };
}
