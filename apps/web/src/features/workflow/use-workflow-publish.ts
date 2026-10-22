'use client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { useWorkflowDraft } from './use-workflow-draft';
import { workflowApi, workflowKeys } from './workflow-api';
import { WorkflowPublisher, workflowPublicationForRevision } from './workflow-publish';

export function useWorkflowPublish(draft: ReturnType<typeof useWorkflowDraft>) {
  const client = useQueryClient();
  const { workflowId, revision, beginPublish, endPublish, publishConflict } = draft;
  const versions = useQuery({
    queryKey: workflowKeys.publication(workflowId, revision),
    queryFn: ({ signal }) => workflowApi.publicationStatus(workflowId, revision, signal),
  });
  const publisher = useMemo(
    () =>
      new WorkflowPublisher({
        begin: () => {
          const target = beginPublish();
          if (target && target.workflowId !== workflowId) {
            endPublish();
            return null;
          }
          return target;
        },
        end: endPublish,
        conflict: publishConflict,
        publish: (target) => workflowApi.publish(target.workflowId, target.revision),
        refresh: async (target) => {
          await client.cancelQueries({ queryKey: workflowKeys.versions(target.workflowId) });
          await client.invalidateQueries({
            queryKey: workflowKeys.versions(target.workflowId),
            refetchType: 'none',
          });
          return client.fetchQuery({
            queryKey: workflowKeys.publication(target.workflowId, target.revision),
            queryFn: ({ signal }) =>
              workflowApi.publicationStatus(target.workflowId, target.revision, signal),
            staleTime: 0,
          });
        },
      }),
    [client, workflowId, beginPublish, endPublish, publishConflict],
  );
  const state = useSyncExternalStore(
    publisher.subscribe,
    publisher.getSnapshot,
    publisher.getSnapshot,
  );
  useEffect(() => {
    if (versions.isSuccess) publisher.clearRefreshError();
  }, [publisher, versions.isSuccess, versions.dataUpdatedAt]);
  const { latest: latestPublishedVersion, current: currentSavedRevisionPublished } =
    workflowPublicationForRevision(revision, versions.data, state.publishedVersion);
  return {
    ...state,
    latestPublishedVersion,
    currentSavedRevisionPublished,
    versions,
    publish: () => publisher.publish(),
  };
}
