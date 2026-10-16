import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { buildContext } from '@dramaflow/context';
import {
  jsonObjectSchema,
  workflowDefinitionSchema,
  type ContextManifest,
  type JsonObject,
} from '@dramaflow/contracts';
import {
  normalizeProviderError,
  validateProviderParameters,
  ProviderError,
  type GeneratedImage,
  type VideoTask,
} from '@dramaflow/plugins';
import type {
  HumanTaskRequest,
  NodeRecord,
  OperationRequest,
  RuntimeEvent,
  RuntimeHost,
} from '@dramaflow/workflow';
import { DatabaseService } from '../infrastructure/database.service.js';
import { PluginsService } from '../plugins/plugins.service.js';
import { AssetsService } from '../assets/assets.service.js';
import { json } from '../infrastructure/validation.js';
import { z } from 'zod';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

@Injectable()
export class RuntimeHostService implements RuntimeHost {
  constructor(
    private readonly db: DatabaseService,
    private readonly plugins: PluginsService,
    private readonly assets: AssetsService,
  ) {}
  async isCancelled(runId: string): Promise<boolean> {
    const run = await this.db.client.run.findUniqueOrThrow({
      where: { id: runId },
      select: { cancelRequestedAt: true, status: true },
    });
    return run.cancelRequestedAt !== null || run.status === 'canceled';
  }
  async onEvent(event: RuntimeEvent): Promise<void> {
    await this.db.client.runEvent.create({
      data: {
        runId: event.runId,
        nodeId: event.nodeId,
        type: event.type,
        data: json(event.data),
      },
    });
  }
  async recordNodeResult(record: NodeRecord): Promise<void> {
    const finished = !['running', 'waiting'].includes(record.result.status);
    await this.db.client.nodeAttempt.upsert({
      where: {
        runId_nodeId_attempt: {
          runId: record.runId,
          nodeId: record.nodeId,
          attempt: 1,
        },
      },
      create: {
        runId: record.runId,
        nodeId: record.nodeId,
        attempt: 1,
        status: record.result.status,
        output: json(record.result),
        ...(finished ? { finishedAt: new Date() } : {}),
      },
      update: {
        status: record.result.status,
        output: json(record.result),
        ...(finished ? { finishedAt: new Date() } : {}),
      },
    });
  }
  async createHumanTask(request: HumanTaskRequest): Promise<void> {
    await this.db.client.humanTask.upsert({
      where: {
        runId_interruptId: {
          runId: request.runId,
          interruptId: request.interruptId,
        },
      },
      create: {
        runId: request.runId,
        nodeId: request.nodeId,
        interruptId: request.interruptId,
        payload: json(request.payload),
      },
      update: {},
    });
  }
  async executeOperation(request: OperationRequest): Promise<JsonObject> {
    const requestSnapshot = {
      model: request.model,
      capability: request.capability,
      input: request.input,
      parameters: request.parameters,
    };
    const requestHash = createHash('sha256')
      .update(canonical(requestSnapshot))
      .digest('hex');
    let operation = await this.db.client.operation.findUnique({
      where: { id: request.operationId },
    });
    if (
      operation &&
      (operation.requestHash !== requestHash ||
        operation.runId !== request.runId)
    )
      throw new ProviderError(
        'INVALID_PARAMETERS',
        '操作标识与已记录请求不一致',
      );
    if (operation?.status === 'succeeded')
      return jsonObjectSchema.parse(
        jsonObjectSchema.parse(operation.result).outputs,
      );
    if (operation?.status === 'failed')
      throw new ProviderError(
        'PROVIDER_REJECTED',
        '先前模型请求已明确失败，请核实后主动重新生成',
      );
    const saved = operation?.result
      ? jsonObjectSchema.parse(operation.result)
      : {};
    if (
      operation?.status === 'outcome_unknown' ||
      (operation?.status === 'submitted' &&
        !saved.providerImages &&
        !operation.externalTaskId)
    ) {
      await this.db.client.operation.update({
        where: { id: request.operationId },
        data: { status: 'outcome_unknown' },
      });
      await this.onEvent({
        runId: request.runId,
        nodeId: request.nodeId,
        type: 'operation.unknown',
        data: { operationId: request.operationId },
      });
      throw new ProviderError(
        'OUTCOME_UNKNOWN',
        '供应商受理状态不明；恢复不会重复提交，请核实后主动重新生成',
        true,
      );
    }
    const run = await this.db.client.run.findUniqueOrThrow({
      where: { id: request.runId },
      include: { version: true },
    });
    const resolved = await this.plugins.resolve(
      run.workspaceId,
      request.model,
      request.capability,
    );
    const parameters = validateProviderParameters(
      resolved.provider,
      request.capability,
      request.parameters,
    );
    const prompt = this.generationPrompt(request);
    let contextManifest: ContextManifest | undefined;
    let messages: { role: 'system' | 'user' | 'assistant'; content: string }[] =
      [];
    if (request.capability === 'text.generate') {
      if (!resolved.provider.generateText)
        throw new ProviderError('UNSUPPORTED_CAPABILITY', '插件不支持文本生成');
      const configuration = z
        .object({
          contextWindow: z.number().int().min(2048),
          maxOutputTokens: z.number().int().positive().optional(),
        })
        .passthrough()
        .parse(resolved.connection.configuration);
      const definition = workflowDefinitionSchema.parse(run.version.definition);
      const target = definition.nodes.find(
        (node) => node.id === request.nodeId,
      );
      if (target && run.regenerateNodeId === request.nodeId)
        target.config = {
          ...target.config,
          ...jsonObjectSchema.parse(run.configOverrides),
        };
      const context = buildContext({
        purpose: 'generation',
        scope: { kind: 'node', nodeId: request.nodeId },
        workflow: {
          id: run.workflowId,
          revision: run.version.sourceRevision,
          versionId: run.versionId,
          definition,
        },
        currentRequest: prompt,
        ...(typeof request.input.systemPrompt === 'string'
          ? { systemPrompt: request.input.systemPrompt }
          : {}),
        messages: [],
        model: {
          contextWindow: configuration.contextWindow,
          maxOutputTokens:
            typeof parameters.maxOutputTokens === 'number'
              ? parameters.maxOutputTokens
              : configuration.maxOutputTokens,
        },
      });
      contextManifest = context.manifest;
      messages = context.messages.map((message) => ({
        role: message.role === 'tool' ? 'user' : message.role,
        content: message.content,
      }));
    }
    if (!operation)
      operation = await this.db.client.operation.create({
        data: {
          id: request.operationId,
          runId: request.runId,
          nodeId: request.nodeId,
          attemptId: request.attemptId,
          requestHash,
          request: json(requestSnapshot),
        },
      });
    if (operation.status === 'prepared') {
      const claimed = await this.db.client.operation.updateMany({
        where: { id: request.operationId, status: 'prepared' },
        data: { status: 'submitted' },
      });
      if (claimed.count !== 1)
        throw new ProviderError(
          'OUTCOME_UNKNOWN',
          '此操作已由其他执行进程受理',
          true,
        );
      await this.onEvent({
        runId: request.runId,
        nodeId: request.nodeId,
        type: 'operation.pending',
        data: { operationId: request.operationId },
      });
    }
    try {
      let outputs: JsonObject;
      let providerRequestId: string | undefined;
      if (request.capability === 'text.generate') {
        if (!resolved.provider.generateText)
          throw new ProviderError(
            'UNSUPPORTED_CAPABILITY',
            '插件不支持文本生成',
          );
        const result = await resolved.provider.generateText(
          {
            modelId: request.model.modelId,
            messages,
            parameters: {
              ...parameters,
              maxOutputTokens: contextManifest!.reservedOutputTokens,
            },
          },
          { ...resolved.context, signal: request.signal },
        );
        providerRequestId = result.providerRequestId;
        outputs = jsonObjectSchema.parse({
          text: result.text,
          ...(result.usage ? { usage: result.usage } : {}),
        });
      } else if (request.capability === 'image.generate') {
        if (!resolved.provider.generateImages)
          throw new ProviderError(
            'UNSUPPORTED_CAPABILITY',
            '插件不支持图片生成',
          );
        let images: GeneratedImage[];
        if (saved.providerImages)
          images = z
            .array(
              z.object({
                mimeType: z.string(),
                base64: z.string().optional(),
                url: z.string().optional(),
                revisedPrompt: z.string().optional(),
              }),
            )
            .parse(saved.providerImages);
        else {
          const result = await resolved.provider.generateImages(
            { modelId: request.model.modelId, prompt, parameters },
            { ...resolved.context, signal: request.signal },
          );
          images = result.images;
          providerRequestId = result.providerRequestId;
          await this.db.client.operation.update({
            where: { id: request.operationId },
            data: {
              result: json({ providerImages: images }),
              providerRequestId,
            },
          });
        }
        outputs = {
          images: await this.materialize(
            request,
            run.workspaceId,
            images.map((image) => ({ ...image, type: 'image' as const })),
          ),
        };
      } else if (request.capability === 'video.generate') {
        if (!resolved.provider.submitVideo || !resolved.provider.pollVideo)
          throw new ProviderError(
            'UNSUPPORTED_CAPABILITY',
            '插件尚未实现视频提交与查询能力',
          );
        let task: VideoTask;
        if (!operation.externalTaskId) {
          task = await resolved.provider.submitVideo(
            {
              modelId: request.model.modelId,
              prompt,
              parameters,
              inputAssets: [],
              idempotencyKey: request.operationId,
            },
            { ...resolved.context, signal: request.signal },
          );
          await this.db.client.operation.update({
            where: { id: request.operationId },
            data: {
              externalTaskId: task.providerTaskId,
              result: json({ videoTask: task }),
            },
          });
        } else {
          try {
            task = await resolved.provider.pollVideo(operation.externalTaskId, {
              ...resolved.context,
              signal: request.signal,
            });
          } catch {
            throw this.recoverable('视频任务已提交，稍后继续查询供应商状态');
          }
          await this.db.client.operation.update({
            where: { id: request.operationId },
            data: { result: json({ videoTask: task }) },
          });
        }
        if (task.status === 'queued' || task.status === 'running') {
          await this.onEvent({
            runId: request.runId,
            nodeId: request.nodeId,
            type: 'operation.pending',
            data: {
              operationId: request.operationId,
              externalTaskId: task.providerTaskId,
              status: task.status,
              ...(task.progress === undefined
                ? {}
                : { progress: task.progress }),
            },
          });
          throw this.recoverable('视频任务进行中，等待再次查询');
        }
        if (task.status !== 'succeeded')
          throw new ProviderError(
            'PROVIDER_REJECTED',
            task.status === 'cancelled'
              ? '供应商视频任务已取消'
              : '供应商视频任务失败',
          );
        if (!task.outputs?.length)
          throw new ProviderError(
            'OUTCOME_UNKNOWN',
            '视频任务成功但缺少产物，请核实供应商记录',
            true,
          );
        outputs = {
          videos: await this.materialize(
            request,
            run.workspaceId,
            task.outputs.map((entry) => ({ ...entry, type: 'video' as const })),
          ),
        };
      } else
        throw new ProviderError(
          'UNSUPPORTED_CAPABILITY',
          '此节点不支持所选能力',
        );
      await this.db.client.operation.update({
        where: { id: request.operationId },
        data: {
          status: 'succeeded',
          result: json({
            outputs,
            ...(contextManifest ? { contextManifest } : {}),
          }),
          providerRequestId,
        },
      });
      return outputs;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'OPERATION_RECOVERABLE'
      )
        throw error;
      const safe = normalizeProviderError(error);
      await this.db.client.operation.update({
        where: { id: request.operationId },
        data: {
          status: safe.outcomeUnknown ? 'outcome_unknown' : 'failed',
          error: { code: safe.code, message: safe.message },
        },
      });
      if (safe.outcomeUnknown)
        await this.onEvent({
          runId: request.runId,
          nodeId: request.nodeId,
          type: 'operation.unknown',
          data: { operationId: request.operationId },
        });
      throw safe;
    }
  }
  private generationPrompt(request: OperationRequest): string {
    const bound = Object.fromEntries(
      Object.entries(request.input).filter(
        ([key]) => !['prompt', 'systemPrompt'].includes(key),
      ),
    );
    return `${z.string().min(1).parse(request.input.prompt)}${Object.keys(bound).length ? `\n\n显式绑定的输入数据（JSON）：\n${JSON.stringify(bound)}` : ''}`;
  }
  private recoverable(message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code: 'OPERATION_RECOVERABLE' });
  }
  private async materialize(
    request: OperationRequest,
    workspaceId: string,
    outputs: {
      mimeType: string;
      base64?: string;
      url?: string;
      type: 'image' | 'video';
    }[],
  ): Promise<JsonObject[]> {
    try {
      return await Promise.all(
        outputs.map(async (output, index) => {
          const assetId = `generated-${createHash('sha256').update(`${request.operationId}:${index}`).digest('hex')}`;
          const asset = await this.assets.save(
            workspaceId,
            `${request.nodeId}-${index + 1}`,
            output.type,
            output.mimeType,
            await this.mediaBytes(output, request.signal),
            {
              operationId: request.operationId,
              runId: request.runId,
              nodeId: request.nodeId,
            },
            assetId,
          );
          return jsonObjectSchema.parse({
            assetId: asset.assetId,
            versionId: asset.versionId,
            type: asset.type,
            mimeType: asset.mimeType,
            name: asset.name ?? '',
          });
        }),
      );
    } catch {
      throw this.recoverable('供应商产物已记录，等待恢复素材下载或存储');
    }
  }
  async cancelOperations(runId: string): Promise<void> {
    const run = await this.db.client.run.findUniqueOrThrow({
      where: { id: runId },
    });
    const operations = await this.db.client.operation.findMany({
      where: { runId, status: 'submitted', externalTaskId: { not: null } },
    });
    for (const operation of operations) {
      try {
        const snapshot = z
          .object({
            model: z.object({
              pluginId: z.string(),
              pluginVersion: z.string(),
              connectionId: z.string(),
              modelId: z.string(),
            }),
          })
          .passthrough()
          .parse(operation.request);
        const resolved = await this.plugins.resolve(
          run.workspaceId,
          snapshot.model,
          'video.generate',
        );
        if (!resolved.provider.cancelVideo || !operation.externalTaskId)
          throw new Error('供应商未提供取消能力');
        const task = await resolved.provider.cancelVideo(
          operation.externalTaskId,
          resolved.context,
        );
        await this.db.client.operation.update({
          where: { id: operation.id },
          data: {
            status: task.status === 'cancelled' ? 'failed' : 'outcome_unknown',
            result: json({ videoTask: task }),
            error: {
              code: 'RUN_CANCELED',
              message:
                task.status === 'cancelled'
                  ? '供应商已确认取消'
                  : '已请求取消，供应商仍可能继续执行',
            },
          },
        });
      } catch {
        await this.db.client.operation.update({
          where: { id: operation.id },
          data: {
            status: 'outcome_unknown',
            error: {
              code: 'CANCEL_UNCONFIRMED',
              message: '本地运行已取消，尚无法确认供应商任务已停止',
            },
          },
        });
      }
    }
  }
  private async mediaBytes(
    media: { base64?: string; url?: string },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (media.base64) return Buffer.from(media.base64, 'base64');
    if (!media.url) throw new Error('供应商产物缺少可读取的内容');
    const url = new URL(media.url);
    const allowed = (process.env.ASSET_DOWNLOAD_ALLOWLIST ?? '')
      .split(',')
      .map((origin) => origin.trim());
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !allowed.includes(url.origin)
    )
      throw new Error('产物下载地址尚未加入 ASSET_DOWNLOAD_ALLOWLIST');
    const response = await fetch(url, {
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
    });
    if (
      !response.ok ||
      Number(response.headers.get('content-length') ?? 0) > 25 * 1024 * 1024
    )
      throw new Error('产物下载失败或超过 25 MiB');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('产物内容为空');
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 25 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('产物超过 25 MiB');
      }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  }
}
