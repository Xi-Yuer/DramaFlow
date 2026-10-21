import type { NextConfig } from 'next';

const apiOrigin = process.env.API_INTERNAL_URL ?? process.env.API_URL ?? 'http://127.0.0.1:3001';
const nextConfig: NextConfig = {
  // 仅编译 Tailwind 入口，保留 CSS Module 的原生类名导出。
  turbopack: { rules: { 'globals.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' } } },
  transpilePackages: ['@dramaflow/contracts'],
  async rewrites() {
    return [
      { source: '/api/auth/:path*', destination: `${apiOrigin}/api/auth/:path*` },
      { source: '/api/v1/:path*', destination: `${apiOrigin}/api/v1/:path*` },
    ];
  },
};

export default nextConfig;
