import {
  createProjectProviderRequestSchema,
  createProjectCatalogProviderRequestSchema,
  createProjectModelRequestSchema,
  replaceProviderCredentialsRequestSchema,
  setModelResourceEnabledRequestSchema,
  modelManagementListQuerySchema,
  modelCatalogQuerySchema,
} from '@dramaflow/contracts';
import {
  ModelProviderService,
  ModelConfigurationError,
} from '@dramaflow/server';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { Actor } from '../auth/auth.guard.js';
import type { AuthActor } from '../auth/auth.service.js';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  // 不能输出 Zod issues：未知字段名、枚举或自定义 message 也可能含客户端提交的秘密。
  if (!parsed.success)
    throw new BadRequestException({
      code: 'MODEL_MANAGEMENT_REQUEST_INVALID',
      message: '模型管理请求不符合协议',
    });
  return parsed.data;
}
async function safe<T>(action: () => Promise<T> | T): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ModelConfigurationError) {
      const body = {
        code: error.code,
        message: '模型能力配置无效或不可用，请检查所选插件、能力及配置',
      };
      if (error.code === 'MODEL_PROVIDER_UNAVAILABLE')
        throw new ConflictException(body);
      throw new BadRequestException(body);
    }
    if (error instanceof NotFoundException)
      throw new NotFoundException({
        code: 'MODEL_RESOURCE_NOT_FOUND',
        message: '项目或模型资源不存在或无权访问',
      });
    if (error instanceof BadRequestException)
      throw new BadRequestException({
        code: 'MODEL_MANAGEMENT_REQUEST_INVALID',
        message: '模型管理请求不符合协议',
      });
    // 包含加密、数据库与插件错误；不保留原始异常、cause、输入或实现类型。
    throw new ServiceUnavailableException({
      code: 'MODEL_MANAGEMENT_UNAVAILABLE',
      message: '模型配置服务暂时不可用',
    });
  }
}

@Controller()
export class ModelManagementController {
  constructor(private readonly models: ModelProviderService) {}

  @Get('provider-plugins')
  @Header('Cache-Control', 'no-store')
  catalog() {
    return safe(() => this.models.listProviderPlugins());
  }

  @Get('provider-catalog')
  @Header('Cache-Control', 'no-store')
  providerCatalog() {
    return safe(() => this.models.listProviderCatalog());
  }

  @Get('model-catalog')
  @Header('Cache-Control', 'no-store')
  modelCatalog(@Query() query: unknown) {
    return safe(() =>
      this.models.listModelCatalog(
        parse(modelCatalogQuerySchema, query).capability,
      ),
    );
  }

  @Get('projects/:projectId/providers')
  @Header('Cache-Control', 'no-store')
  listProviders(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Query() query: unknown,
  ) {
    return safe(() =>
      this.models.listProviders(
        actor.user.id,
        parse(z.uuid(), projectId),
        parse(modelManagementListQuerySchema, query),
      ),
    );
  }

  @Get('projects/:projectId/providers/:providerId')
  @Header('Cache-Control', 'no-store')
  getProvider(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('providerId') providerId: string,
  ) {
    return safe(() =>
      this.models.getProvider(
        actor.user.id,
        parse(z.uuid(), projectId),
        parse(z.uuid(), providerId),
      ),
    );
  }

  @Post('projects/:projectId/providers/catalog')
  @Header('Cache-Control', 'no-store')
  createCatalogProvider(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    return safe(() =>
      this.models.createProviderFromCatalog(actor.user.id, {
        ...parse(createProjectCatalogProviderRequestSchema, body),
        projectId: parse(z.uuid(), projectId),
      }),
    );
  }

  @Post('projects/:projectId/providers')
  @Header('Cache-Control', 'no-store')
  createProvider(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    return safe(() =>
      this.models.createProvider(actor.user.id, {
        ...parse(createProjectProviderRequestSchema, body),
        projectId: parse(z.uuid(), projectId),
      }),
    );
  }

  @Patch('projects/:projectId/providers/:providerId')
  @Header('Cache-Control', 'no-store')
  setProviderEnabled(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('providerId') providerId: string,
    @Body() body: unknown,
  ) {
    return safe(() =>
      this.models.setProviderEnabled(
        actor.user.id,
        parse(z.uuid(), projectId),
        parse(z.uuid(), providerId),
        parse(setModelResourceEnabledRequestSchema, body).enabled,
      ),
    );
  }

  @Put('projects/:projectId/providers/:providerId/credentials')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  replaceCredentials(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('providerId') providerId: string,
    @Body() body: unknown,
  ) {
    return safe(() =>
      this.models.replaceCredentials(
        actor.user.id,
        parse(z.uuid(), projectId),
        parse(z.uuid(), providerId),
        parse(replaceProviderCredentialsRequestSchema, body).credentials,
      ),
    );
  }

  @Get('projects/:projectId/model-configurations')
  @Header('Cache-Control', 'no-store')
  listModels(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Query() query: unknown,
  ) {
    return safe(() =>
      this.models.listModelConfigurations(
        actor.user.id,
        parse(z.uuid(), projectId),
        parse(modelManagementListQuerySchema, query),
      ),
    );
  }

  @Get('projects/:projectId/model-configurations/:modelId')
  @Header('Cache-Control', 'no-store')
  getModel(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('modelId') modelId: string,
  ) {
    return safe(() =>
      this.models.getManagedModelConfiguration(
        actor.user.id,
        parse(z.uuid(), projectId),
        parse(z.uuid(), modelId),
      ),
    );
  }

  @Post('projects/:projectId/model-configurations')
  @Header('Cache-Control', 'no-store')
  createModel(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    return safe(async () => {
      const model = await this.models.createModelConfiguration(actor.user.id, {
        ...parse(createProjectModelRequestSchema, body),
        projectId: parse(z.uuid(), projectId),
      });
      return this.models.getManagedModelConfiguration(
        actor.user.id,
        model.projectId,
        model.id,
      );
    });
  }

  @Patch('projects/:projectId/model-configurations/:modelId')
  @Header('Cache-Control', 'no-store')
  setModelEnabled(
    @Actor() actor: AuthActor,
    @Param('projectId') projectId: string,
    @Param('modelId') modelId: string,
    @Body() body: unknown,
  ) {
    return safe(() =>
      this.models.setModelEnabled(
        actor.user.id,
        parse(z.uuid(), projectId),
        parse(z.uuid(), modelId),
        parse(setModelResourceEnabledRequestSchema, body).enabled,
      ),
    );
  }
}
