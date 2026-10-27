import { useState } from 'react';
import { Button, Popover } from 'antd';
import { Plus } from 'lucide-react';
import {
  isNodeCatalogEntryVisible,
  type NodeCatalogCategory,
  type NodeCatalogEntry,
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
  entries,
  disabled,
  onSelect,
}: {
  entries: readonly NodeCatalogEntry[];
  disabled: boolean;
  onSelect: (entry: NodeCatalogEntry) => void;
}) {
  const catalog = entries.filter((entry) => isNodeCatalogEntryVisible(entry));
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
            {catalog.map((entry) => (
              <Button
                key={entry.id}
                className={styles.option}
                type="text"
                block
                aria-label={`添加 ${entry.metadata.name} · v${entry.target.version}`}
                disabled={disabled}
                onClick={() => {
                  onSelect(entry);
                  setOpen(false);
                }}
              >
                <span className={styles.icon} aria-hidden="true">
                  <NodeTypeIcon metadata={entry.metadata} />
                </span>
                <span className={styles.details}>
                  <strong>{entry.metadata.name}</strong>
                  {entry.metadata.description ? <span>{entry.metadata.description}</span> : null}
                  <small>
                    {categoryNames[entry.category]} · v{entry.target.version}
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
