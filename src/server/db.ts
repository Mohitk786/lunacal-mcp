import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.js";
import { log } from "./log.js";

const { Pool } = pg;

export const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    application_name: "lunacal-mcp",
});

pool.on("error", (err: Error) => {
    log.error("idle postgres client error", { message: err.message });
});

export type DbClient = pg.PoolClient;

const MIGRATION_LOCK_KEY = 2_142_501;

function migrationsDir(): string {
    return join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
}

export async function migrate(): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        const files = readdirSync(migrationsDir())
            .filter((name) => name.endsWith(".sql"))
            .sort();
        for (const filename of files) {
            const existing = await client.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [filename]);
            if (existing.rowCount) continue;
            const sql = readFileSync(join(migrationsDir(), filename), "utf8");
            try {
                await client.query("BEGIN");
                await client.query(sql);
                await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
                await client.query("COMMIT");
                log.info("applied migration", { filename });
            } catch (err) {
                await client.query("ROLLBACK");
                throw err;
            }
        }
    } finally {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
        client.release();
    }
}

export async function checkDb(): Promise<void> {
    await pool.query("SELECT 1");
}

/** Safe to run on every instance. Deletes only rows that are already useless. */
export async function cleanupExpired(): Promise<void> {
    await pool.query("DELETE FROM mcp_pending_authorizations WHERE expires_at < now()");
    await pool.query("DELETE FROM mcp_auth_codes WHERE expires_at < now()");
    await pool.query(`
        UPDATE mcp_tokens
        SET successor_access_enc = NULL,
            successor_refresh_enc = NULL,
            successor_access_expires_at = NULL,
            successor_refresh_expires_at = NULL
        WHERE type = 'refresh'
          AND used_at IS NOT NULL
          AND used_at < now() - interval '60 seconds'
          AND successor_access_enc IS NOT NULL
    `);
    await pool.query(`
        DELETE FROM mcp_tokens
        WHERE expires_at < now() - interval '1 day'
    `);
    await pool.query(`
        DELETE FROM mcp_tokens
        WHERE type = 'refresh'
          AND used_at IS NOT NULL
          AND used_at < now() - interval '1 day'
    `);
}

export async function closePool(): Promise<void> {
    await pool.end();
}
