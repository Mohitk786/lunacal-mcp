import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function encryptionKey(): Buffer {
    const raw = required("MCP_TOKEN_ENC_KEY");
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) {
        throw new Error(
            "MCP_TOKEN_ENC_KEY must be 32 bytes, base64-encoded. Generate one with: openssl rand -base64 32",
        );
    }
    return key;
}

function intEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

const port = intEnv("PORT", Number(process.env.LUNACAL_MCP_PORT ?? 3939));

export const config = {
    port,
    publicBaseUrl: (process.env.LUNACAL_MCP_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    databaseUrl: required("DATABASE_URL"),
    encryptionKey: encryptionKey(),
    lunacalWebappUrl: (process.env.LUNACAL_WEBAPP_URL ?? "https://app.lunacal.ai").replace(/\/$/, ""),
    lunacalClientId: required("LUNACAL_OAUTH_CLIENT_ID"),
    lunacalClientSecret: required("LUNACAL_OAUTH_CLIENT_SECRET"),
    trustProxy: process.env.TRUST_PROXY === "true",
    openaiDomainToken: process.env.OPENAI_DOMAIN_TOKEN ?? "",
    mcpRateLimitMax: intEnv("MCP_RATE_LIMIT_MAX", 300),
    oauthRateLimitMax: intEnv("OAUTH_RATE_LIMIT_MAX", 300),
    registerRateLimitMax: intEnv("REGISTER_RATE_LIMIT_MAX", 60),
};

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
export const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;
export const REFRESH_GRACE_MS = 60 * 1000;
export const LUNACAL_REFRESH_SKEW_MS = 2 * 60 * 1000;
