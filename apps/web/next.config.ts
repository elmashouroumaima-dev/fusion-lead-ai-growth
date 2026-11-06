import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Les packages du monorepo sont consommés en TypeScript source.
  transpilePackages: ["@fusion-leap/domain"],
  poweredByHeader: false,
};

export default nextConfig;
