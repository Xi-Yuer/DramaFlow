import { nodeTypeManifestListSchema } from '@dramaflow/contracts';
import { request } from '../../lib/http';

export const nodeTypeKeys = { list: ['workflow-node-types'] as const };
export const nodeTypeApi = {
  list: () => request('/workflow/node-types', nodeTypeManifestListSchema),
};
