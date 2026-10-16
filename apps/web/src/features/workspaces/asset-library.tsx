'use client';

import { useQuery } from '@tanstack/react-query';
import { Image as ImageIcon, Loader2 } from 'lucide-react';
import { api, queryKeys } from '@/lib/api';
import { EmptyState, ErrorNotice } from '@/components/ui/form-field';
import { AssetPreview } from '@/features/runs/asset-preview';

export function AssetLibrary({ workspaceId }: { workspaceId: string }) {
  const assets = useQuery({
    queryKey: queryKeys.assets(workspaceId),
    queryFn: () => api.assets(workspaceId),
  });
  return (
    <section className="workspace-home">
      <div className="section-heading">
        <div>
          <span className="eyebrow">
            <i /> THE OUTPUT ARCHIVE
          </span>
          <h1>你的创作素材库</h1>
          <p>每次生成保留独立版本，让灵感和选择都有迹可循。</p>
        </div>
        <span className="status-tag">{assets.data?.items.length ?? '—'} ASSETS</span>
      </div>
      {assets.error && <ErrorNotice error={assets.error} onRetry={() => void assets.refetch()} />}
      {assets.isPending && (
        <div className="loading-row">
          <Loader2 className="animate-spin" size={14} />
          读取素材版本…
        </div>
      )}
      {assets.data?.items.length === 0 && (
        <EmptyState icon={<ImageIcon />} title="还没有生成素材">
          运行图片或视频能力后，生成的文件会出现在这里。
        </EmptyState>
      )}
      <div className="result-grid">
        {assets.data?.items.map((asset) => (
          <AssetPreview
            key={asset.versionId}
            value={{
              assetId: asset.assetId,
              versionId: asset.versionId,
              type: asset.type,
              mimeType: asset.mimeType,
              ...(asset.name ? { name: asset.name } : {}),
            }}
            label={asset.name ?? asset.assetId}
          />
        ))}
      </div>
    </section>
  );
}
