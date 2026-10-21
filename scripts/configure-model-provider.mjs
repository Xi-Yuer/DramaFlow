import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// 服务器端 CLI：命令行只有配置文件路径，密钥仅从文件指定的环境变量读取。
async function configure() {
  if (process.argv.length !== 3) throw new Error('MODEL_CONFIGURATION_ARGUMENT_INVALID');
  if (existsSync('.env')) process.loadEnvFile('.env');
  const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
  const { z } = require('zod');
  const jsonObject = z.record(z.string(), z.json());
  const config = z
    .object({
      ownerId: z.string().min(1).max(200),
      projectId: z.uuid(),
      name: z.string().trim().min(1).max(80),
      pluginId: z.string().min(1).max(100),
      pluginVersion: z.number().int().positive(),
      configuration: jsonObject,
      credentialsEnv: z
        .record(z.string().min(1), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
        .refine((value) => Object.keys(value).length > 0),
      model: z
        .object({
          capability: z.string().min(1).max(100),
          model: z.string().trim().min(1).max(200),
          settings: jsonObject,
        })
        .strict(),
    })
    .strict()
    .parse(JSON.parse(await readFile(process.argv[2], 'utf8')));

  const credentials = Object.fromEntries(
    Object.entries(config.credentialsEnv).map(([key, variable]) => {
      const value = process.env[variable];
      if (!value) throw new Error('MODEL_CREDENTIALS_ENV_MISSING');
      return [key, value];
    }),
  );
  const { DatabaseService, ModelProviderService, SecretsService, createProviderPluginRegistry } =
    await import('../packages/server/dist/index.js');
  const plugins = createProviderPluginRegistry();
  const plugin = plugins.get(config.pluginId, config.pluginVersion);
  // 在首次写库前校验整份配置，避免明知模型配置非法仍创建 Provider。
  plugin.configSchema.parse(config.configuration);
  plugin.credentialsSchema.parse(credentials);
  plugins
    .getCapability(config.pluginId, config.pluginVersion, config.model.capability)
    .modelSettingsSchema.parse(config.model.settings);

  const database = new DatabaseService();
  try {
    const service = new ModelProviderService(database, new SecretsService(), plugins);
    const provider = await service.createProvider(config.ownerId, {
      projectId: config.projectId,
      name: config.name,
      pluginId: config.pluginId,
      pluginVersion: config.pluginVersion,
      configuration: config.configuration,
      credentials,
    });
    const model = await service.createModelConfiguration(config.ownerId, {
      projectId: config.projectId,
      providerId: provider.id,
      ...config.model,
    });
    return { providerId: provider.id, modelConfigurationId: model.id };
  } finally {
    await database.onModuleDestroy();
  }
}

try {
  console.info(JSON.stringify(await configure()));
} catch {
  // 不输出原异常、参数、配置路径或 cause：驱动 / SDK 错误可能携带敏感信息。
  console.error('模型配置失败，请检查构建结果、服务器配置、环境变量和项目归属；未调用模型。');
  process.exitCode = 1;
}
