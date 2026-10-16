import { z } from 'zod';
import {
  identifierSchema,
  type NodeDefinition,
  type WorkflowDefinition,
  type WorkflowIssue,
} from './workflow.js';

export const pluginCapabilitySchema = z.enum(['text', 'image', 'video']);
export type PluginCapability = z.infer<typeof pluginCapabilitySchema>;
export const credentialFieldSchema = z
  .object({
    key: identifierSchema,
    label: z.string().min(1).max(40),
    secret: z.boolean(),
    required: z.boolean(),
    defaultValue: z.string().max(300).optional(),
  })
  .strict();
export const modelListingSchema = z.enum(['openai', 'anthropic', 'none']);
export type ModelListing = z.infer<typeof modelListingSchema>;
export const pluginManifestSchema = z
  .object({
    id: identifierSchema,
    version: z.number().int().positive(),
    vendor: z.string().min(1).max(40),
    title: z.string().min(1).max(80),
    description: z.string().max(500),
    capabilities: z.array(pluginCapabilitySchema).min(1),
    credentialFields: z.array(credentialFieldSchema).min(1).max(8),
    modelListing: modelListingSchema,
    allowCustomModel: z.boolean(),
    asyncTasks: z.boolean(),
  })
  .strict();
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type CredentialField = z.infer<typeof credentialFieldSchema>;
export const installationSummarySchema = z
  .object({
    id: z.string().uuid(),
    pluginId: identifierSchema,
    pluginVersion: z.number().int().positive(),
    label: z.string(),
    publicConfig: z.record(z.string(), z.string()),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type InstallationSummary = z.infer<typeof installationSummarySchema>;
export const installPluginSchema = z
  .object({
    pluginId: identifierSchema,
    label: z.string().trim().min(1).max(80),
    credentials: z.record(z.string(), z.string().max(2000)),
  })
  .strict();
export const updateInstallationSchema = installPluginSchema.omit({ pluginId: true });
export type InstallPlugin = z.infer<typeof installPluginSchema>;
export type UpdateInstallation = z.infer<typeof updateInstallationSchema>;
export const remoteModelSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    label: z.string().min(1).max(80),
  })
  .strict();
export const remoteModelListSchema = z
  .object({
    items: z.array(remoteModelSchema).max(500),
    unavailableReason: z.string().max(200).nullable(),
  })
  .strict();
export type RemoteModel = z.infer<typeof remoteModelSchema>;
export type RemoteModelList = z.infer<typeof remoteModelListSchema>;

export function validateNodePlugins(
  definition: WorkflowDefinition,
  catalog: NodeDefinition[],
  installations: { id: string; pluginId: string }[],
  manifests: PluginManifest[],
): WorkflowIssue[] {
  const definitions = new Map(catalog.map((item) => [`${item.type}@${item.version}`, item]));
  const installed = new Map(installations.map((item) => [item.id, item]));
  const plugins = new Map(manifests.map((item) => [item.id, item]));
  const issues: WorkflowIssue[] = [];
  for (const node of definition.nodes) {
    const nodeDefinition = definitions.get(`${node.type}@${node.version}`);
    if (!nodeDefinition?.pluginCapability) continue;
    const installationId = node.config.installationId;
    const modelId = node.config.modelId;
    if (typeof installationId !== 'string' || typeof modelId !== 'string') continue;
    if (!installationId && !modelId) continue;
    const installation = installed.get(installationId);
    const manifest = installation ? plugins.get(installation.pluginId) : undefined;
    if (!installation || !manifest) {
      issues.push({
        code: 'plugin_installation',
        message: `节点 ${node.title} 选择的插件安装不存在或无权使用`,
        nodeId: node.id,
      });
      continue;
    }
    if (!manifest.capabilities.includes(nodeDefinition.pluginCapability)) {
      issues.push({
        code: 'plugin_capability',
        message: `节点 ${node.title} 不能使用 ${manifest.title}`,
        nodeId: node.id,
      });
      continue;
    }
    if (!modelId.trim())
      issues.push({
        code: 'plugin_model',
        message: `节点 ${node.title} 需要选择 ${manifest.title} 的模型`,
        nodeId: node.id,
      });
  }
  return issues;
}
