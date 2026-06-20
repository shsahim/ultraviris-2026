import type { NextConfig } from "next";

// Content-Security-Policy. 'unsafe-inline' is required for scripts/styles
// because Next's App Router injects inline hydration scripts (and we use inline
// style attributes) without a nonce. img-src allows https: so CDN/S3-hosted
// gallery images load regardless of the configured IMAGE_BASE_URL host.
const cspDirectives = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: cspDirectives },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Emit a self-contained server build (.next/standalone) so the Docker image
  // can run with a minimal node runtime and no full node_modules copy.
  output: "standalone",
  // ssh2 (and mysql2) ship native/binary files that must not be bundled by
  // webpack; load them from node_modules at runtime instead.
  serverExternalPackages: ["ssh2", "mysql2", "cpu-features"],
  webpack: (config, { isServer, webpack }) => {
    // ssh2 → cpu-features (.node). Never pull these into the client bundle.
    if (!isServer) {
      config.plugins.push(
        new webpack.IgnorePlugin({ resourceRegExp: /^(ssh2|cpu-features)$/ }),
        new webpack.IgnorePlugin({ resourceRegExp: /\.node$/ })
      );
      config.resolve.alias = {
        ...config.resolve.alias,
        ssh2: false,
        "cpu-features": false,
      };
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        child_process: false,
      };
    }
    return config;
  },
};

export default nextConfig;
