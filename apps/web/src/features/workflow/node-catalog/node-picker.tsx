import { useState } from 'react';
import { Button, Popover } from 'antd';
import { Plus } from 'lucide-react';
import type { NodeCategory, NodeTypeManifest } from '@dramaflow/contracts';
import { NodeTypeIcon } from './node-type-icon';
import styles from './node-picker.module.css';

const categoryNames: Record<NodeCategory, string> = {
  input: '输入',
  ai: 'AI',
  image: '图片',
  video: '视频',
  audio: '音频',
  flow: '流程',
  data: '数据',
  output: '输出',
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
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.toolbar}>
      <Popover
        trigger="click"
        placement="bottomLeft"
        open={open && !disabled}
        onOpenChange={setOpen}
        title="选择节点"
        content={
          <div className={styles.list} aria-label="节点目录">
            {manifests.map((manifest) => (
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
                    {categoryNames[manifest.metadata.category]} · v{manifest.version}
                  </small>
                </span>
              </Button>
            ))}
          </div>
        }
      >
        <Button icon={<Plus size={16} />} disabled={disabled} aria-expanded={open && !disabled}>
          添加节点
        </Button>
      </Popover>
    </div>
  );
}
