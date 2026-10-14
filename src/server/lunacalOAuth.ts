import { config } from "./config.js";
import { log } from "./log.js";

export type LunacalTokenSet = {
    accessToken: string;
    expiresAt: Date;
    refreshToken: string;
    refreshTokenExpiresAt: Date | null;
};

export type LunacalRefreshResult =
    | { kind: "ok"; tokens: LunacalTokenSet }
    | { kind: "dead"; status: number; message: string }
    | { kind: "temporary"; status: number; message: string };

// Exact messages from calendar-scheduling apps/web/pages/api/mcp/refresh.ts.
// "Invalid refresh token" covers unknown, wrong-client, and already-rotated tokens.
const DEAD_REFRESH_MESSAGES = new Set(["Invalid refresh token", "Refresh token expired"]);

function errorMessage(body: unknown): string {
    if (!body || typeof body !== "object" || !("message" in body)) return "";
    const message = (body as { message: unknown }).message;
    return typeof message === "string" ? message : "";
}

function parseTokenSet(body: unknown): LunacalTokenSet | undefined {
    if (!body || typeof body !== "object") return undefined;
    const record = body as Record<string, unknown>;
    if (typeof record.accessToken !== "string" || typeof record.expiresAt !== "string") return undefined;
    if (typeof record.refreshToken !== "string" || !record.refreshToken) return undefined;
    const expiresAt = new Date(record.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) return undefined;
    let refreshTokenExpiresAt: Date | null = null;
    if (typeof record.refreshTokenExpiresAt === "string") {
        const parsed = new Date(record.refreshTokenExpiresAt);
        refreshTokenExpiresAt = Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return {
        accessToken: record.accessToken,
        expiresAt,
        refreshToken: record.refreshToken,
        refreshTokenExpiresAt,
    };
}

async function readBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return undefined;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

export async function exchangeLunacalCode(code: string): Promise<LunacalTokenSet> {
    const res = await fetch(`${config.lunacalWebappUrl}/api/mcp/token`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${code}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ clientSecret: config.lunacalClientSecret }),
        signal: AbortSignal.timeout(15_000),
    });
    const body = await readBody(res);
    if (!res.ok) {
        const message = errorMessage(body) || `HTTP ${res.status}`;
        log.error("lunacal code exchange failed", { status: res.status, lunacalMessage: message });
        throw new Error("Lunacal authorization could not be completed");
    }
    const tokens = parseTokenSet(body);
    if (!tokens) {
        log.error("lunacal code exchange returned an unexpected body", { status: res.status });
        throw new Error("Lunacal authorization could not be completed");
    }
    return tokens;
}

export async function refreshLunacalToken(refreshToken: string): Promise<LunacalRefreshResult> {
    let res: Response;
    try {
        res = await fetch(`${config.lunacalWebappUrl}/api/mcp/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                refreshToken,
                clientSecret: config.lunacalClientSecret,
            }),
            signal: AbortSignal.timeout(10_000),
        });
    } catch (err) {
        const message = err instanceof Error ? err.name : "network";
        log.error("lunacal refresh request failed", { lunacalMessage: message });
        return { kind: "temporary", status: 0, message };
    }

    const body = await readBody(res);
    if (res.ok) {
        const tokens = parseTokenSet(body);
        if (!tokens) {
            log.error("lunacal refresh returned an unexpected body", { status: res.status });
            return { kind: "temporary", status: res.status, message: "Malformed token response" };
        }
        return { kind: "ok", tokens };
    }

    const message = errorMessage(body) || `HTTP ${res.status}`;
    if (res.status === 400 && DEAD_REFRESH_MESSAGES.has(message)) {
        return { kind: "dead", status: res.status, message };
    }
    log.error("lunacal refresh was not applied", { status: res.status, lunacalMessage: message });
    return { kind: "temporary", status: res.status, message };
}
