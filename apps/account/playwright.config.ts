import { defineConfig, devices } from "@playwright/test";

// Reuses system Chrome (no browser download needed), mirrors Holodilnik setup.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 2,
  use: {
    baseURL: "http://localhost:4174",
    actionTimeout: 10000,
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"], channel: "chrome" } },
    { name: "chromium", use: { channel: "chrome" } },
  ],
  webServer: {
    command: "npx vite preview --port 4174",
    url: "http://localhost:4174",
    reuseExistingServer: true,
    timeout: 60000,
  },
});
