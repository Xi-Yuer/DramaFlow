import type { ThemeConfig } from 'antd';

/** 全站唯一设计令牌入口，避免各功能模块自行定义主题。 */
export const workspaceTheme: ThemeConfig = {
  token: {
    colorPrimary: '#1677ff',
    colorInfo: '#1677ff',
    colorSuccess: '#16a574',
    colorWarning: '#d89614',
    colorError: '#e5484d',
    colorText: '#1d2939',
    colorTextSecondary: '#667085',
    colorBorder: '#dce3ed',
    colorBgLayout: '#f4f6fa',
    borderRadius: 8,
    controlHeight: 36,
    fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
    fontSize: 13,
  },
  components: {
    Layout: { siderBg: '#101d35', headerBg: '#ffffff' },
    Menu: { darkItemBg: '#101d35', darkItemSelectedBg: '#1677ff', itemHeight: 44 },
    Card: { headerFontSize: 15 },
    Tabs: { horizontalMargin: '0', horizontalItemGutter: 24 },
    Modal: { titleFontSize: 17 },
  },
};
