import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server build (.next/standalone) so the Docker image
  // can run with a minimal node runtime and no full node_modules copy.
  output: "standalone",
  // ssh2 (and mysql2) ship native/binary files that must not be bundled by
  // webpack; load them from node_modules at runtime instead.
  serverExternalPackages: ["ssh2", "mysql2"],
};

export default nextConfig;
