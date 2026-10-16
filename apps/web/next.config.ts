import type { NextConfig } from 'next';

const apiOrigin = process.env.API_INTERNAL_URL ?? process.env.API_URL ?? 'http://127.0.0.1:3001';
const nextConfig: NextConfig = {
  turbopack: { rules: { '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' } } },
  transpilePackages: ['@dramaflow/contracts'],
  async rewrites() {
    return [
      { source: '/api/auth/:path*', destination: `${apiOrigin}/api/auth/:path*` },
      { source: '/api/v1/:path*', destination: `${apiOrigin}/api/v1/:path*` },
    ];
  },
};

export default nextConfig;
