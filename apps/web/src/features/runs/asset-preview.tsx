'use client';

import { Download, File, Film, Image as ImageIcon } from 'lucide-react';
import { z } from 'zod';
import type { JsonValue } from '@dramaflow/contracts';

const referenceSchema = z.object({
  assetId: z.string(),
  versionId: z.string(),
  type: z.enum(['image', 'video', 'audio', 'file']),
  mimeType: z.string(),
  name: z.string().optional(),
});

export function AssetPreview({ value, label }: { value: JsonValue; label: string }) {
  const asset = referenceSchema.safeParse(value);
  if (asset.success) {
    const reference = asset.data;
    const src = `/api/v1/assets/${encodeURIComponent(reference.versionId)}/content`;
    return (
      <article className="asset-card">
        {reference.type === 'image' ? (
          <div
            role="img"
            aria-label={reference.name ?? label}
            className="asset-image"
            style={{ backgroundImage: `url("${src}")` }}
          />
        ) : reference.type === 'video' ? (
          <video src={src} controls preload="metadata" aria-label={reference.name ?? label} />
        ) : reference.type === 'audio' ? (
          <audio src={src} controls preload="metadata" aria-label={reference.name ?? label} />
        ) : (
          <div className="empty-state">
            <File />
          </div>
        )}
        <div className="asset-card-info">
          <strong>{reference.name ?? label}</strong>
          <small
            className="muted"
            style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 9 }}
          >
            {reference.mimeType} · {reference.versionId.slice(0, 12)}
          </small>
          <a href={src} target="_blank" rel="noreferrer">
            <Download size={12} />
            查看原始文件
          </a>
        </div>
      </article>
    );
  }
  if (Array.isArray(value))
    return (
      <div>
        <h4 className="muted" style={{ fontSize: 11, margin: '0 0 10px' }}>
          {label} · {value.length} 项
        </h4>
        <div className="result-grid">
          {value.map((item, index) => (
            <AssetPreview key={index} value={item} label={`${label}[${index}]`} />
          ))}
        </div>
      </div>
    );
  if (
    value &&
    typeof value === 'object' &&
    Object.values(value).some(
      (entry) => referenceSchema.safeParse(entry).success || Array.isArray(entry),
    )
  )
    return (
      <div>
        <h4 className="muted" style={{ fontSize: 11, margin: '0 0 10px' }}>
          {label}
        </h4>
        <div className="result-grid">
          {Object.entries(value).map(([key, entry]) => (
            <AssetPreview key={key} value={entry} label={key} />
          ))}
        </div>
      </div>
    );
  return (
    <article className="asset-card">
      <div className="asset-card-info">
        <strong>{label}</strong>
      </div>
      <pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
    </article>
  );
}

export const assetIcon = (type: string) =>
  type === 'image' ? ImageIcon : type === 'video' ? Film : File;
