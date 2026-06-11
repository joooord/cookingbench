import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@cookingbench/core'],
  outputFileTracingIncludes: {
    '/**': ['../../data/**'],
  },
  webpack: (config) => {
    // @cookingbench/core uses ESM-style ".js" specifiers in TypeScript source.
    config.resolve.extensionAlias = { '.js': ['.ts', '.js'] };
    return config;
  },
};

export default nextConfig;
