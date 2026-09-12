import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: "v8",
      include: [
        "src/index.ts",
        "src/process.ts",
        "src/lib/auth.ts",
        "src/lib/config.ts",
        "src/lib/mentions.ts",
        "src/lib/messages.ts",
        "src/lib/notify.ts",
      ],
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 90,
        branches: 85,
      },
      reporter: ["text", "json-summary"],
    },
  },
});
