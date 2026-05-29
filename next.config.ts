import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ssh2 (and mysql2) ship native/binary files that must not be bundled by
  // webpack; load them from node_modules at runtime instead.
  serverExternalPackages: ["ssh2", "mysql2"],
};

export default nextConfig;
