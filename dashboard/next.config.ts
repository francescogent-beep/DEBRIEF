import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The web version of the rep logger lives in public/log (built from the
  // Chrome extension by scripts/build-web-logger.py).
  async rewrites() {
    return [
      { source: "/log", destination: "/log/index.html" },
      { source: "/log/", destination: "/log/index.html" },
    ];
  },
};

export default nextConfig;
