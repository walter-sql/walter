import { defineConfig } from "vitest/config";

export default defineConfig({
  root: __dirname,
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    env: { WALTER_LOG: "silent" }
  }
});
