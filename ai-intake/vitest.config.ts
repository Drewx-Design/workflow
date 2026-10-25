import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["scripts/__tests__/*.test.ts"], fileParallelism: false, maxWorkers: 1, testTimeout: 60000, hookTimeout: 120000 } });
