import { randomBytes, createHash } from "node:crypto";

// OAuth broker: we are the OAuth *server* to MCP clients and the OAuth *client* to Lunacal.
// State lives in memory — a restart drops pending logins and issued tokens.
function getLunacalWebappUrl(): string {
    return process.env.LUNACAL_WEBAPP_URL ?? "https://app.lunacal.ai";
}

interface RegisteredMcpClient {
    clientId: string;
    redirectUris: string[];
}

interface PendingAuthorization {
    mcpClientId: string;
    mcpRedirectUri: string;
    mcpState?: string;
    mcpCodeChallenge?: string;
    mcpCodeChallengeMethod?: string;
    createdAt: number;
}

interface LunacalTokens {
    accessToken: string;
    expiresAt: number;
}

interface OurAuthCode {
    lunacalTokens: LunacalTokens;
    mcpClientId: string;
    mcpCodeChallenge: string;
    createdAt: number;
}

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_REGISTERED_CLIENTS = 10_000;
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

const mcpClients = new Map<string, RegisteredMcpClient>();
const pendingAuthorizations = new Map<string, PendingAuthorization>();
const ourAuthCodes = new Map<string, OurAuthCode>();
const issuedTokens = new Map<string, LunacalTokens>();

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingAuthorizations) {
        if (now - v.createdAt > PENDING_AUTH_TTL_MS) pendingAuthorizations.delete(k);
    }
    for (const [k, v] of ourAuthCodes) {
        if (now - v.createdAt > AUTH_CODE_TTL_MS) ourAuthCodes.delete(k);
    }
    for (const [k, v] of issuedTokens) {
        if (now > v.expiresAt) issuedTokens.delete(k);
    }
}, CLEANUP_INTERVAL_MS).unref();

function requireLunacalClientConfig(): { clientId: string; clientSecret: string } {
    const clientId = process.env.LUNACAL_OAUTH_CLIENT_ID;
    const clientSecret = process.env.LUNACAL_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error(
            "LUNACAL_OAUTH_CLIENT_ID / LUNACAL_OAUTH_CLIENT_SECRET are not set — lunacal-mcp must be " +
                "provisioned as a Lunacal PlatformOAuthClient first (see provisioning script).",
        );
    }
    return { clientId, clientSecret };
}

function randomToken(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
}

/** S256 PKCE check: base64url(sha256(verifier)) === challenge. */
function verifyPkce(verifier: string, challenge: string): boolean {
    const computed = createHash("sha256").update(verifier).digest("base64url");
    return computed === challenge;
}

export function ourCallbackUrl(publicBaseUrl: string): string {
    return `${publicBaseUrl}/oauth/lunacal/callback`;
}

export function registerMcpClient(body: { redirect_uris?: string[] }): {
    client_id: string;
    redirect_uris: string[];
    token_endpoint_auth_method: "none";
} {
    if (mcpClients.size >= MAX_REGISTERED_CLIENTS) {
        throw new Error("Too many registered clients");
    }
    const clientId = randomToken(16);
    const redirectUris = body.redirect_uris ?? [];
    mcpClients.set(clientId, { clientId, redirectUris });
    return { client_id: clientId, redirect_uris: redirectUris, token_endpoint_auth_method: "none" };
}

export function beginAuthorization(
    params: {
        client_id?: string;
        redirect_uri?: string;
        state?: string;
        code_challenge?: string;
        code_challenge_method?: string;
    },
    publicBaseUrl: string,
): URL {
    requireLunacalClientConfig();

    if (!params.client_id) {
        throw new Error("client_id is required");
    }
    if (!params.redirect_uri) {
        throw new Error("redirect_uri is required");
    }
    // Auto-register if client_id was lost on restart but the MCP client cached it.
    if (!mcpClients.has(params.client_id)) {
        mcpClients.set(params.client_id, { clientId: params.client_id, redirectUris: [params.redirect_uri] });
    }
    if (!mcpClients.get(params.client_id)!.redirectUris.includes(params.redirect_uri)) {
        throw new Error("redirect_uri does not match a registered redirect_uri for this client");
    }
    if (!params.code_challenge || params.code_challenge_method !== "S256") {
        throw new Error("PKCE with S256 is required");
    }

    const ourState = randomToken();
    pendingAuthorizations.set(ourState, {
        mcpClientId: params.client_id,
        mcpRedirectUri: params.redirect_uri,
        mcpState: params.state,
        mcpCodeChallenge: params.code_challenge,
        mcpCodeChallengeMethod: params.code_challenge_method,
        createdAt: Date.now(),
    });

    const url = new URL(`${getLunacalWebappUrl()}/auth/platform/authorize`);
    url.searchParams.set("redirect_uri", ourCallbackUrl(publicBaseUrl));
    url.searchParams.set("state", ourState);
    return url;
}

export async function finishLunacalAuthorization(query: { code?: string; state?: string }): Promise<URL> {
    if (!query.code || !query.state) {
        throw new Error("Missing code or state on Lunacal callback");
    }
    const pending = pendingAuthorizations.get(query.state);
    if (!pending) {
        throw new Error("Unknown or expired state on Lunacal callback");
    }
    pendingAuthorizations.delete(query.state);

    const { clientSecret } = requireLunacalClientConfig();
    const res = await fetch(`${getLunacalWebappUrl()}/api/mcp/token`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${query.code}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ clientSecret }),
    });
    if (!res.ok) {
        throw new Error(`Lunacal token exchange failed: ${res.status} ${await res.text()}`);
    }
    const { accessToken, expiresAt } = (await res.json()) as {
        accessToken: string;
        expiresAt: string;
    };

    const ourCode = randomToken();
    ourAuthCodes.set(ourCode, {
        lunacalTokens: {
            accessToken,
            expiresAt: new Date(expiresAt).getTime(),
        },
        mcpClientId: pending.mcpClientId,
        mcpCodeChallenge: pending.mcpCodeChallenge!,
        createdAt: Date.now(),
    });

    const redirectUrl = new URL(pending.mcpRedirectUri);
    redirectUrl.searchParams.set("code", ourCode);
    if (pending.mcpState) {
        redirectUrl.searchParams.set("state", pending.mcpState);
    }
    return redirectUrl;
}

export function exchangeOurCode(body: { code?: string; code_verifier?: string; client_id?: string }): {
    access_token: string;
    token_type: "bearer";
    expires_in: number;
} {
    if (!body.code) {
        throw new Error("Missing code");
    }
    if (!body.client_id) {
        throw new Error("Missing client_id");
    }
    const entry = ourAuthCodes.get(body.code);
    if (!entry) {
        throw new Error("Unknown or already-used code");
    }
    ourAuthCodes.delete(body.code);

    if (entry.mcpClientId !== body.client_id) {
        throw new Error("client_id does not match the authorization request");
    }

    if (Date.now() - entry.createdAt > AUTH_CODE_TTL_MS) {
        throw new Error("Authorization code expired");
    }

    if (!body.code_verifier || !verifyPkce(body.code_verifier, entry.mcpCodeChallenge)) {
        throw new Error("PKCE verification failed");
    }

    const ourAccessToken = randomToken();
    issuedTokens.set(ourAccessToken, entry.lunacalTokens);

    return {
        access_token: ourAccessToken,
        token_type: "bearer",
        expires_in: Math.max(0, Math.floor((entry.lunacalTokens.expiresAt - Date.now()) / 1000)),
    };
}

export function resolveLunacalAccessToken(ourAccessToken: string): string | undefined {
    const entry = issuedTokens.get(ourAccessToken);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
        issuedTokens.delete(ourAccessToken);
        return undefined;
    }
    return entry.accessToken;
}
