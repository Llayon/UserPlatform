import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./test/setup.ts"],
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "api/*.test.ts"],
    exclude: ["node_modules"],
  },
});
