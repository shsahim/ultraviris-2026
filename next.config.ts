import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
