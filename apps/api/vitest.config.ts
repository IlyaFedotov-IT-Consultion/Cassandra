import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL?.replace(/\/cassandra$/, "/cassandra_test") ??
        "postgresql://postgres:postgres@localhost:5432/cassandra_test",
    },
  },
});
