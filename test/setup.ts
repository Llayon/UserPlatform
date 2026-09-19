/**
 * Global test setup: load local secrets for DATABASE_URL-gated integration
 * tests. Silent when .env.local is absent (unit suites still run).
 * Never prints values — dotenv only populates process.env.
 */
import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
