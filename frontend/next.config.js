/** @type {import('next').NextConfig} */
const BACKEND_INTERNAL = process.env.BACKEND_INTERNAL_URL || "http://127.0.0.1:8000";

const nextConfig = {
  // Allow a separate build cache per dev instance (e.g. NEXT_DIST_DIR=.next-local),
  // so two dev servers on this repo don't share compiled chunks / NEXT_PUBLIC values.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_INTERNAL}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
