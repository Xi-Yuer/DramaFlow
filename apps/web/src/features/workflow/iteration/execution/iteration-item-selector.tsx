import { Select, Space, Typography, theme } from 'antd';
import type { IterationItemSelectorState } from './use-iteration-item-selection';
import styles from './iteration-item-selector.module.css';

export function IterationItemSelector({
  items,
  executionId,
  onSelect,
}: IterationItemSelectorState) {
  const { token } = theme.useToken();
  if (items.length <= 1) return null;
  return (
    <Space
      className={styles.context}
      role="group"
      aria-label="Iteration Body 执行上下文"
      style={{
        background: token.colorBgContainer,
        borderColor: token.colorBorderSecondary,
        borderRadius: token.borderRadiusSM,
      }}
    >
      <Typography.Text type="secondary">执行 Item</Typography.Text>
      <Select
        className={styles.select}
        aria-label="选择 Item 执行"
        size="small"
        value={executionId}
        onChange={onSelect}
        popupMatchSelectWidth={false}
        options={items.map((item) => ({
          value: item.executionId,
          label: `Item ${item.index + 1}`,
        }))}
      />
    </Space>
  );
}
