import { theme, type ThemeConfig } from 'antd';
export const workspaceTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#67ded5',
    colorInfo: '#67ded5',
    colorSuccess: '#68cc9a',
    colorWarning: '#e2ba6c',
    colorError: '#ee777c',
    colorBgBase: '#101012',
    colorBgContainer: '#1b1b1f',
    colorBgElevated: '#252529',
    colorText: '#efeff2',
    colorTextSecondary: '#a2a2ad',
    colorBorder: '#36363d',
    borderRadius: 10,
    controlHeight: 40,
    fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
    fontSize: 13,
  },
  components: {
    Button: { primaryColor: '#0c2926', fontWeight: 600 },
    Input: { activeShadow: '0 0 0 2px #67ded515' },
    Tabs: { horizontalMargin: '0 0 28px' },
    Modal: { borderRadiusLG: 16 },
    Form: { labelColor: '#c7c7ce' },
  },
};
