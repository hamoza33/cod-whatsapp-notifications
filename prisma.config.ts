import { defineConfig } from "prisma/config";

// dotenv is loaded lazily so deployment environments that inject secrets
// directly into process.env (Fly.io, Vercel, Railway) do not need dotenv
// available in the runtime image. We only call it when a .env file exists
// on disk — i.e. local development.
import { existsSync } from "node:fs";
if (existsSync(".env")) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv/config");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env["DATABASE_URL"] ?? "",
  },
});
