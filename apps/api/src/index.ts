import { createPgDb, createRepos } from "@user-platform/db";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run the Platform API");
}

const db = createPgDb(databaseUrl);
const app = createApp({ config, db, repos: createRepos() });

app.listen(config.port, () => {
  console.log(`[user-platform-api] listening on ${config.port} (prod=${config.isProduction})`);
});
