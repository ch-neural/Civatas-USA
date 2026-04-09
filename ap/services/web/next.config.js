/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // Proxy /api/* through the Next.js server to the API gateway container.
    // This lets the browser talk only to port 3000 (same-origin), so the
    // app works through restrictive networks that only allow port 3000 and
    // adapts automatically to whatever host the user typed in the browser.
    const target = process.env.API_URL || "http://api:8000";
    return [
      { source: "/api/:path*", destination: `${target}/api/:path*` },
      { source: "/health", destination: `${target}/health` },
    ];
  },
};

module.exports = nextConfig;
