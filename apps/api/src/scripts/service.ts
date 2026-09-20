/**
 * Operator CLI for per-app service credentials (no admin web UI).
 *
 *   npm run service:create -- --app fridge --label holodilnik-prod
 *   npm run service:list -- --app fridge
 *   npm run service:revoke -- --key-id <keyId>
 *   npm run service:rotate -- --app fridge --label holodilnik-prod-v2 --old-key-id <keyId>
 *
 * CREATE prints the raw token EXACTLY ONCE (store it in the app's secret
 * store immediately; it cannot be retrieved later). LIST never prints
 * secrets or hashes. All commands fail closed without DATABASE_URL.
 */
import { createPgDb, createRepos } from "@user-platform/db";
import { generateServiceToken, hashServiceSecret } from "@user-platform/auth-core";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const db = createPgDb(databaseUrl, { maxConnections: 2 });
  const repos = createRepos();
  try {
    if (command === "create") {
      const slug = arg("app");
      const label = arg("label") ?? null;
      const expiresDays = arg("expires-in-days");
      if (!slug) {
        console.error("Usage: service:create -- --app <slug> --label <label>");
        process.exit(1);
      }
      const app = await repos.registry.getAppBySlug(db, slug);
      if (!app) {
        console.error(`Unknown app slug: ${slug}`);
        process.exit(1);
      }
      if (app.status === "disabled") {
        console.error(`App is disabled: ${slug}`);
        process.exit(1);
      }
      const gen = generateServiceToken();
      const expiresAt = expiresDays
        ? new Date(Date.now() + Number(expiresDays) * 24 * 3600 * 1000).toISOString()
        : null;
      await repos.serviceCredentials.create(db, {
        appId: app.id,
        keyId: gen.keyId,
        secretHash: hashServiceSecret(gen.secret),
        label,
        expiresAt,
      });
      console.log(`Created service credential for app "${slug}" (keyId=${gen.keyId})`);
      console.log(`TOKEN (shown ONCE, cannot be retrieved later): ${gen.token}`);
      console.log("Save it directly into the app backend secret store. Never commit it.");
    } else if (command === "list") {
      const slug = arg("app");
      if (!slug) {
        console.error("Usage: service:list -- --app <slug>");
        process.exit(1);
      }
      const app = await repos.registry.getAppBySlug(db, slug);
      if (!app) {
        console.error(`Unknown app slug: ${slug}`);
        process.exit(1);
      }
      const rows = await repos.serviceCredentials.listByApp(db, app.id);
      for (const r of rows) {
        // NEVER print secret/hash here.
        console.log(
          [
            r.keyId,
            slug,
            r.label ?? "-",
            r.status,
            r.createdAt,
            r.expiresAt ?? "-",
            r.lastUsedAt ?? "-",
          ].join("\t"),
        );
      }
    } else if (command === "revoke") {
      const keyId = arg("key-id");
      if (!keyId) {
        console.error("Usage: service:revoke -- --key-id <keyId>");
        process.exit(1);
      }
      const revoked = await repos.serviceCredentials.revokeByKeyId(db, keyId);
      if (!revoked) {
        console.error(`Credential not found or already revoked: ${keyId}`);
        process.exit(1);
      }
      console.log(`Revoked keyId=${keyId}`);
    } else if (command === "rotate") {
      const slug = arg("app");
      const label = arg("label") ?? null;
      const oldKeyId = arg("old-key-id");
      if (!slug || !oldKeyId) {
        console.error(
          "Usage: service:rotate -- --app <slug> --old-key-id <keyId> [--label <label>]",
        );
        process.exit(1);
      }
      const app = await repos.registry.getAppBySlug(db, slug);
      if (!app) {
        console.error(`Unknown app slug: ${slug}`);
        process.exit(1);
      }
      const gen = generateServiceToken();
      await repos.serviceCredentials.create(db, {
        appId: app.id,
        keyId: gen.keyId,
        secretHash: hashServiceSecret(gen.secret),
        label,
      });
      console.log(`Created replacement credential for app "${slug}" (keyId=${gen.keyId})`);
      console.log(`TOKEN (shown ONCE): ${gen.token}`);
      console.log("Deploy it to the app backend and verify, THEN revoke the old key:");
      console.log(`  npm run service:revoke -- --key-id ${oldKeyId}`);
    } else {
      console.error("Unknown command. Use create|list|revoke|rotate");
      process.exit(1);
    }
  } finally {
    await db.close();
  }
}

void main();
