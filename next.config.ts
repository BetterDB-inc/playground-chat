import type { NextConfig } from "next";

/**
 * Next.js config.
 *
 * - `serverExternalPackages` keeps `iovalkey` out of the server bundle so
 *   its native networking module isn't tree-shaken or wrapped by webpack.
 * - `reactStrictMode` doubles render in dev to surface side-effect bugs;
 *   we want that for an OSS demo where contributors will fork this.
 * - `poweredByHeader: false` removes the `X-Powered-By: Next.js` header
 *   (small fingerprinting reduction).
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["iovalkey"],
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Improves first-paint by avoiding extra hydration work for static parts.
    optimizePackageImports: ["react-markdown", "remark-gfm"],
  },
};

export default nextConfig;
