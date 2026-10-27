import { nodeCatalogEntryListSchema } from '@dramaflow/contracts';
import { request } from '../../../lib/http';

export const nodeCatalogKeys = { list: ['workflow-node-catalog'] as const };
export const nodeCatalogApi = {
  list: () => request('/workflow/node-catalog', nodeCatalogEntryListSchema),
};
