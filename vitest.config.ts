import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration tests share the Postgres container; run files serially.
    fileParallelism: false,
    env: {
      SW_DATABASE_URL:
        process.env.SW_DATABASE_URL ??
        "postgres://station:station_local_dev@127.0.0.1:55432/postgres",
    },
  },
});
