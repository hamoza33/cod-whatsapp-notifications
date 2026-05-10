import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `standalone` emits a self-contained `.next/standalone` folder with just
  // the files the runtime needs (no node_modules duplication) — this is how
  // we keep the Fly.io Docker image small.
  output: "standalone",
};

export default nextConfig;
