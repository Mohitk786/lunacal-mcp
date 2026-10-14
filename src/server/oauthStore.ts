import { randomUUID } from "node:crypto";
import {
    ACCESS_TOKEN_TTL_MS,
    AUTH_CODE_TTL_MS,
    PENDING_AUTH_TTL_MS,
    REFRESH_GRACE_MS,
    REFRESH_TOKEN_TTL_MS,
} from "./config.js";
import { decrypt, encrypt, randomToken, sha256, verifyPkce } from "./crypto.js";
import { pool, type DbClient } from "./db.js";
import { log } from "./log.js";
import { OAuthError } from "./oauthErrors.js";

export type RegisteredClient = {
    clientId: string;
    redirectUris: string[];
    clientName: string | null;
    createdAt: Date;
};

export type PendingAuthorization = {
    clientId: string;
    redirectUri: string;
    clientState: string | null;
    codeChallenge: string;
};

export type IssuedTokens = {
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
};

type AuthCodeRow = {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    lunacal_access_token_enc: string;
    lunacal_refresh_token_enc: string;
    lunacal_expires_at: Date;
    lunacal_refresh_expires_at: Date | null;
    expires_at: Date;
};

type RefreshRow = {
    grant_id: string;
    expires_at: Date;
    used_at: Date | null;
    successor_access_enc: string | null;
    successor_refresh_enc: string | null;
    successor_access_expires_at: Date | null;
    successor_refresh_expires_at: Date | null;
    client_id: string;
    revoked_at: Date | null;
};

async function withTransaction<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
    const db = await pool.connect();
    try {
        await db.query("BEGIN");
        const result = await fn(db);
        await db.query("COMMIT");
        return result;
    } catch (err) {
        if (err instanceof OAuthError && err.commit) {
            await db.query("COMMIT");
        } else {
            await db.query("ROLLBACK");
        }
        throw err;
    } finally {
        db.release();
    }
}

function expiresInSeconds(date: Date): number {
    return Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
}

export function publicTokenResponse(issued: IssuedTokens): {
    access_token: string;
    token_type: "bearer";
    expires_in: number;
    refresh_token: string;
} {
    return {
        access_token: issued.accessToken,
        token_type: "bearer",
        expires_in: expiresInSeconds(issued.accessExpiresAt),
        refresh_token: issued.refreshToken,
    };
}

async function insertTokenPair(db: DbClient, grantId: string): Promise<IssuedTokens> {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    await db.query(
        `INSERT INTO mcp_tokens (token_hash, grant_id, type, expires_at)
         VALUES ($1, $2, 'access', $3), ($4, $2, 'refresh', $5)`,
        [sha256(accessToken), grantId, accessExpiresAt, sha256(refreshToken), refreshExpiresAt],
    );
    return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}

export async function insertClient(input: {
    redirectUris: string[];
    clientName: string | null;
}): Promise<RegisteredClient> {
    const clientId = randomToken(16);
    const createdAt = new Date();
    await pool.query(
        `INSERT INTO mcp_oauth_clients (client_id, redirect_uris, client_name, created_at)
         VALUES ($1, $2, $3, $4)`,
        [clientId, input.redirectUris, input.clientName, createdAt],
    );
    return { clientId, redirectUris: input.redirectUris, clientName: input.clientName, createdAt };
}

export async function getClient(clientId: string): Promise<RegisteredClient | undefined> {
    const result = await pool.query<{
        client_id: string;
        redirect_uris: string[];
        client_name: string | null;
        created_at: Date;
    }>(
        `SELECT client_id, redirect_uris, client_name, created_at
         FROM mcp_oauth_clients WHERE client_id = $1`,
        [clientId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
        clientId: row.client_id,
        redirectUris: row.redirect_uris,
        clientName: row.client_name,
        createdAt: row.created_at,
    };
}

export async function insertPending(input: PendingAuthorization): Promise<string> {
    const state = randomToken();
    await pool.query(
        `INSERT INTO mcp_pending_authorizations
           (state_hash, client_id, redirect_uri, client_state, code_challenge, code_challenge_method, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'S256', $6)`,
        [
            sha256(state),
            input.clientId,
            input.redirectUri,
            input.clientState,
            input.codeChallenge,
            new Date(Date.now() + PENDING_AUTH_TTL_MS),
        ],
    );
    return state;
}

export async function consumePending(state: string): Promise<PendingAuthorization | undefined> {
    const result = await pool.query<{
        client_id: string;
        redirect_uri: string;
        client_state: string | null;
        code_challenge: string;
        expires_at: Date;
    }>(
        `DELETE FROM mcp_pending_authorizations
         WHERE state_hash = $1
         RETURNING client_id, redirect_uri, client_state, code_challenge, expires_at`,
        [sha256(state)],
    );
    const row = result.rows[0];
    if (!row || row.expires_at.getTime() <= Date.now()) return undefined;
    return {
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        clientState: row.client_state,
        codeChallenge: row.code_challenge,
    };
}

export async function insertAuthCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    lunacalAccessToken: string;
    lunacalRefreshToken: string;
    lunacalExpiresAt: Date;
    lunacalRefreshExpiresAt: Date | null;
}): Promise<string> {
    const code = randomToken();
    await pool.query(
        `INSERT INTO mcp_auth_codes
           (code_hash, client_id, redirect_uri, code_challenge,
            lunacal_access_token_enc, lunacal_refresh_token_enc,
            lunacal_expires_at, lunacal_refresh_expires_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
            sha256(code),
            input.clientId,
            input.redirectUri,
            input.codeChallenge,
            encrypt(input.lunacalAccessToken),
            encrypt(input.lunacalRefreshToken),
            input.lunacalExpiresAt,
            input.lunacalRefreshExpiresAt,
            new Date(Date.now() + AUTH_CODE_TTL_MS),
        ],
    );
    return code;
}

export async function redeemAuthCode(input: {
    code: string;
    clientId: string;
    codeVerifier: string | undefined;
    redirectUri: string | undefined;
}): Promise<IssuedTokens> {
    return withTransaction(async (db) => {
        const deleted = await db.query<AuthCodeRow>(
            `DELETE FROM mcp_auth_codes WHERE code_hash = $1 RETURNING *`,
            [sha256(input.code)],
        );
        const row = deleted.rows[0];
        const burned = (description: string) => new OAuthError("invalid_grant", description, 400, true);
        if (!row) throw burned("Unknown or already-used code");
        if (row.expires_at.getTime() <= Date.now()) throw burned("Authorization code expired");
        if (row.client_id !== input.clientId) throw burned("client_id does not match the authorization request");
        if (input.redirectUri && input.redirectUri !== row.redirect_uri) {
            throw burned("redirect_uri does not match the authorization request");
        }
        if (!input.codeVerifier || !verifyPkce(input.codeVerifier, row.code_challenge)) {
            throw burned("PKCE verification failed");
        }

        const grantId = randomUUID();
        await db.query(
            `INSERT INTO mcp_grants
               (id, client_id, lunacal_access_token_enc, lunacal_refresh_token_enc,
                lunacal_expires_at, lunacal_refresh_expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                grantId,
                row.client_id,
                row.lunacal_access_token_enc,
                row.lunacal_refresh_token_enc,
                row.lunacal_expires_at,
                row.lunacal_refresh_expires_at,
            ],
        );
        return insertTokenPair(db, grantId);
    });
}

export async function rotateRefreshToken(presented: string, clientId: string): Promise<IssuedTokens> {
    return withTransaction(async (db) => {
        const found = await db.query<RefreshRow>(
            `SELECT t.grant_id, t.expires_at, t.used_at,
                    t.successor_access_enc, t.successor_refresh_enc,
                    t.successor_access_expires_at, t.successor_refresh_expires_at,
                    g.client_id, g.revoked_at
             FROM mcp_tokens t
             JOIN mcp_grants g ON g.id = t.grant_id
             WHERE t.token_hash = $1 AND t.type = 'refresh'
             FOR UPDATE OF t, g`,
            [sha256(presented)],
        );
        const row = found.rows[0];
        if (!row) throw new OAuthError("invalid_grant", "Unknown refresh token", 400);
        if (row.revoked_at) throw new OAuthError("invalid_grant", "Grant has been revoked", 400);
        if (row.client_id !== clientId) throw new OAuthError("invalid_grant", "client_id does not match this refresh token", 400);

        if (row.used_at) {
            const withinGrace = Date.now() < row.used_at.getTime() + REFRESH_GRACE_MS;
            if (
                withinGrace &&
                row.successor_access_enc &&
                row.successor_refresh_enc &&
                row.successor_access_expires_at &&
                row.successor_refresh_expires_at
            ) {
                try {
                    const replayed = {
                        accessToken: decrypt(row.successor_access_enc),
                        refreshToken: decrypt(row.successor_refresh_enc),
                        accessExpiresAt: row.successor_access_expires_at,
                        refreshExpiresAt: row.successor_refresh_expires_at,
                    };
                    log.info("refresh token grace replay", { grantId: row.grant_id });
                    return replayed;
                } catch {
                    log.error("failed to decrypt refresh grace successor", { grantId: row.grant_id });
                    throw new Error("Could not replay the rotated refresh token");
                }
            }
            await revokeGrantLocked(db, row.grant_id);
            log.error("refresh token reuse revoked grant", { grantId: row.grant_id });
            throw new OAuthError("invalid_grant", "Refresh token reuse detected", 400, true);
        }

        if (row.expires_at.getTime() <= Date.now()) {
            throw new OAuthError("invalid_grant", "Refresh token expired", 400);
        }

        const issued = await insertTokenPair(db, row.grant_id);
        await db.query(
            `UPDATE mcp_tokens
             SET used_at = now(),
                 successor_access_enc = $2,
                 successor_refresh_enc = $3,
                 successor_access_expires_at = $4,
                 successor_refresh_expires_at = $5
             WHERE token_hash = $1`,
            [
                sha256(presented),
                encrypt(issued.accessToken),
                encrypt(issued.refreshToken),
                issued.accessExpiresAt,
                issued.refreshExpiresAt,
            ],
        );
        log.info("rotated refresh token", { grantId: row.grant_id });
        return issued;
    });
}

async function revokeGrantLocked(db: DbClient, grantId: string): Promise<void> {
    await db.query(
        `UPDATE mcp_tokens
         SET successor_access_enc = NULL,
             successor_refresh_enc = NULL,
             successor_access_expires_at = NULL,
             successor_refresh_expires_at = NULL
         WHERE grant_id = $1`,
        [grantId],
    );
    await db.query(
        `UPDATE mcp_grants SET revoked_at = now(), updated_at = now() WHERE id = $1 AND revoked_at IS NULL`,
        [grantId],
    );
}

export async function lookupAccessToken(token: string): Promise<{
    grantId: string;
    clientId: string;
    expiresAt: Date;
} | undefined> {
    const result = await pool.query<{
        grant_id: string;
        expires_at: Date;
        client_id: string;
        revoked_at: Date | null;
    }>(
        `SELECT t.grant_id, t.expires_at, g.client_id, g.revoked_at
         FROM mcp_tokens t
         JOIN mcp_grants g ON g.id = t.grant_id
         WHERE t.token_hash = $1 AND t.type = 'access'`,
        [sha256(token)],
    );
    const row = result.rows[0];
    if (!row || row.revoked_at || row.expires_at.getTime() <= Date.now()) return undefined;
    return { grantId: row.grant_id, clientId: row.client_id, expiresAt: row.expires_at };
}
