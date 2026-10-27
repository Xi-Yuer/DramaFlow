import { useState } from 'react';
import { Button, Popover } from 'antd';
import { Plus } from 'lucide-react';
import {
  isNodeVisibleInCatalog,
  type NodeCatalogCategory,
  type NodeTypeManifest,
} from '@dramaflow/contracts';
import { NodeTypeIcon } from './node-type-icon';
import styles from './node-picker.module.css';

const categoryNames: Record<NodeCatalogCategory, string> = {
  ai: 'AI 能力',
  data: '数据处理',
  workflow: '工作流控制',
  advanced: '高级能力',
};

export function NodePicker({
  manifests,
  disabled,
  onSelect,
}: {
  manifests: readonly NodeTypeManifest[];
  disabled: boolean;
  onSelect: (manifest: NodeTypeManifest) => void;
}) {
  const catalog = manifests.filter((manifest) => isNodeVisibleInCatalog(manifest));
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.toolbar}>
      <Popover
        trigger="click"
        placement="bottomLeft"
        open={open && !disabled && catalog.length > 0}
        onOpenChange={setOpen}
        title="选择节点"
        content={
          <div className={styles.list} aria-label="节点目录">
            {catalog.map((manifest) => (
              <Button
                key={`${manifest.type}@${manifest.version}`}
                className={styles.option}
                type="text"
                block
                aria-label={`添加 ${manifest.metadata.name} · v${manifest.version}`}
                disabled={disabled}
                onClick={() => {
                  onSelect(manifest);
                  setOpen(false);
                }}
              >
                <span className={styles.icon} aria-hidden="true">
                  <NodeTypeIcon metadata={manifest.metadata} />
                </span>
                <span className={styles.details}>
                  <strong>{manifest.metadata.name}</strong>
                  {manifest.metadata.description ? (
                    <span>{manifest.metadata.description}</span>
                  ) : null}
                  <small>
                    {categoryNames[manifest.metadata.catalog.category]} · v{manifest.version}
                  </small>
                </span>
              </Button>
            ))}
          </div>
        }
      >
        <Button
          icon={<Plus size={16} />}
          disabled={disabled || catalog.length === 0}
          aria-expanded={open && !disabled && catalog.length > 0}
        >
          添加节点
        </Button>
      </Popover>
    </div>
  );
}
