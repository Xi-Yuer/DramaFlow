import { nodeTypeManifestSchema } from '@dramaflow/contracts';
import { z } from 'zod';
import { request } from '../../lib/http';

const nodeTypeListSchema = z.array(nodeTypeManifestSchema).superRefine((manifests, context) => {
  const keys = new Set<string>();
  manifests.forEach((manifest, index) => {
    const key = JSON.stringify([manifest.type, manifest.version]);
    if (keys.has(key)) {
      context.addIssue({ code: 'custom', path: [index], message: '节点目录包含重复类型版本' });
    }
    keys.add(key);
  });
});

export const nodeTypeKeys = { list: ['workflow-node-types'] as const };
export const nodeTypeApi = {
  list: () => request('/workflow/node-types', nodeTypeListSchema),
};
