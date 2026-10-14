import { LUNACAL_REFRESH_SKEW_MS } from "./config.js";
import { decrypt, encrypt } from "./crypto.js";
import { pool } from "./db.js";
import { refreshLunacalToken } from "./lunacalOAuth.js";
import { log } from "./log.js";
import { GrantDeadError, UpstreamTemporaryError } from "./oauthErrors.js";

type GrantRow = {
    id: string;
    lunacal_access_token_enc: string;
    lunacal_refresh_token_enc: string;
    lunacal_expires_at: Date;
    revoked_at: Date | null;
};

function isLockTimeout(err: unknown): boolean {
    return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "55P03";
}

/**
 * Returns a Lunacal access token for this grant, refreshing it under a row
 * lock when it expires within two minutes (or when `rejectedToken` is the
 * token Lunacal just refused). Parallel callers block on the lock, then see
 * the updated row and do not refresh again.
 */
export async function lunacalAccessForGrant(grantId: string, rejectedToken?: string): Promise<string> {
    const db = await pool.connect();
    let finished = false;
    const rollback = async () => {
        if (finished) return;
        finished = true;
        await db.query("ROLLBACK").catch(() => undefined);
    };
    const commit = async () => {
        await db.query("COMMIT");
        finished = true;
    };

    try {
        await db.query("BEGIN");
        await db.query("SET LOCAL lock_timeout = '20s'");
        const result = await db.query<GrantRow>(
            `SELECT id, lunacal_access_token_enc, lunacal_refresh_token_enc, lunacal_expires_at, revoked_at
             FROM mcp_grants WHERE id = $1 FOR UPDATE`,
            [grantId],
        );
        const row = result.rows[0];
        if (!row || row.revoked_at) {
            await rollback();
            throw new GrantDeadError();
        }

        const accessToken = decrypt(row.lunacal_access_token_enc);
        const refreshToken = decrypt(row.lunacal_refresh_token_enc);
        const expiresAt = row.lunacal_expires_at.getTime();
        const stillValid = expiresAt > Date.now();
        const nearExpiry = expiresAt <= Date.now() + LUNACAL_REFRESH_SKEW_MS;
        const rejected = rejectedToken !== undefined && rejectedToken === accessToken;
        const alreadyRotated = rejectedToken !== undefined && rejectedToken !== accessToken;

        if (alreadyRotated || (!rejected && !nearExpiry)) {
            await commit();
            return accessToken;
        }

        const outcome = await refreshLunacalToken(refreshToken);
        if (outcome.kind === "dead") {
            await db.query(
                `UPDATE mcp_grants SET revoked_at = now(), updated_at = now() WHERE id = $1 AND revoked_at IS NULL`,
                [grantId],
            );
            await commit();
            log.error("lunacal refresh rejected the grant", {
                grantId,
                status: outcome.status,
                lunacalMessage: outcome.message,
            });
            throw new GrantDeadError();
        }
        if (outcome.kind === "temporary") {
            log.error("lunacal refresh left the grant unchanged", {
                grantId,
                status: outcome.status,
                lunacalMessage: outcome.message,
            });
            if (stillValid && !rejected) {
                await commit();
                return accessToken;
            }
            await rollback();
            throw new UpstreamTemporaryError("Lunacal token refresh failed temporarily");
        }

        await db.query(
            `UPDATE mcp_grants
             SET lunacal_access_token_enc = $2,
                 lunacal_refresh_token_enc = $3,
                 lunacal_expires_at = $4,
                 lunacal_refresh_expires_at = $5,
                 updated_at = now()
             WHERE id = $1`,
            [
                grantId,
                encrypt(outcome.tokens.accessToken),
                encrypt(outcome.tokens.refreshToken),
                outcome.tokens.expiresAt,
                outcome.tokens.refreshTokenExpiresAt,
            ],
        );
        await commit();
        log.info("refreshed lunacal access token", { grantId });
        return outcome.tokens.accessToken;
    } catch (err) {
        if (!finished) {
            if (isLockTimeout(err)) {
                await rollback();
                log.error("timed out waiting for lunacal grant lock", { grantId });
                throw new UpstreamTemporaryError("Timed out waiting to refresh the Lunacal session");
            }
            await rollback();
        }
        if (!(err instanceof GrantDeadError) && !(err instanceof UpstreamTemporaryError)) {
            log.error("lunacal grant refresh failed", {
                grantId,
                message: err instanceof Error ? err.message : "unknown",
            });
        }
        throw err;
    } finally {
        db.release();
    }
}
