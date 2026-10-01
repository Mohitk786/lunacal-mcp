import { randomBytes, createHash } from "node:crypto";

/**
 * Bridges MCP's expected OAuth shape (dynamic client registration + PKCE,
 * per the MCP spec) to Lunacal's actual auth model — a bespoke, minimal flow
 * built specifically for lunacal-mcp (see apps/web/pages/api/mcp/* and
 * apps/web/pages/auth/platform/authorize.tsx in calendar-scheduling), not
 * Cal.com's own apps/api/v2 Platform OAuth system, which Lunacal never
 * deployed. Since there's only ever one client (lunacal-mcp itself), the
 * consent page doesn't need a client_id to look anything up.
 *
 * We are the OAuth *server* to MCP clients and the OAuth *client* to Lunacal.
 * State lives in memory — fine for a first version, but a restart drops every
 * pending login and issued token; move this to a real store before this runs
 * as more than one process or needs to survive restarts.
 */

// Read lazily (inside functions), not as module-level constants: index.ts's
// dotenv.config() call runs after all of its imports are evaluated — ESM
// always fully evaluates the import graph before an importing module's own
// top-level statements — so a module-level `process.env.X` read here would
// always capture undefined, regardless of what's actually in .env.
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
    mcpCodeChallenge?: string;
    mcpCodeChallengeMethod?: string;
    createdAt: number;
}

const mcpClients = new Map<string, RegisteredMcpClient>();
const pendingAuthorizations = new Map<string, PendingAuthorization>();
const ourAuthCodes = new Map<string, OurAuthCode>();
// Our issued access token -> the Lunacal tokens it stands in for.
const issuedTokens = new Map<string, LunacalTokens>();

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

/** RFC 7591 dynamic client registration — trivially accepts any MCP client and hands it a fresh id. */
export function registerMcpClient(body: { redirect_uris?: string[] }): {
    client_id: string;
    redirect_uris: string[];
    token_endpoint_auth_method: "none";
} {
    const clientId = randomToken(16);
    const redirectUris = body.redirect_uris ?? [];
    mcpClients.set(clientId, { clientId, redirectUris });
    return { client_id: clientId, redirect_uris: redirectUris, token_endpoint_auth_method: "none" };
}

/**
 * Handles the incoming MCP client's /authorize request: validates it, stashes
 * what we'll need once Lunacal redirects back to us, and returns the URL to
 * send the user's browser to next (Lunacal's own authorize page).
 */
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
    // Not needed to build this URL (there's only one client), but checked
    // early so a missing config fails fast instead of at the token exchange.
    requireLunacalClientConfig();

    if (!params.client_id || !mcpClients.has(params.client_id)) {
        throw new Error("Unknown client_id — register first via /register");
    }
    if (!params.redirect_uri || !mcpClients.get(params.client_id)!.redirectUris.includes(params.redirect_uri)) {
        throw new Error("redirect_uri does not match a registered redirect_uri for this client");
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

    // Lunacal's consent page (apps/web/pages/auth/platform/authorize.tsx) renders
    // the "Allow" prompt and, on click, calls its own /api/mcp/authorize with
    // our fixed callback as redirect_uri. No client_id is sent — the page
    // already knows which client it is (there's only ever the one).
    const url = new URL(`${getLunacalWebappUrl()}/auth/platform/authorize`);
    url.searchParams.set("redirect_uri", ourCallbackUrl(publicBaseUrl));
    url.searchParams.set("state", ourState);
    return url;
}

/**
 * Handles Lunacal's redirect back to us (?code=...&state=...): exchanges the
 * Lunacal auth code for Lunacal tokens, mints OUR OWN auth code for the
 * original MCP client, and returns the URL to send the browser to next
 * (the MCP client's own redirect_uri).
 */
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
        mcpCodeChallenge: pending.mcpCodeChallenge,
        mcpCodeChallengeMethod: pending.mcpCodeChallengeMethod,
        createdAt: Date.now(),
    });

    const redirectUrl = new URL(pending.mcpRedirectUri);
    redirectUrl.searchParams.set("code", ourCode);
    if (pending.mcpState) {
        redirectUrl.searchParams.set("state", pending.mcpState);
    }
    return redirectUrl;
}

/** The MCP client's /token request: exchanges our auth code (+ PKCE verifier) for one of our access tokens. */
export function exchangeOurCode(body: { code?: string; code_verifier?: string }): {
    access_token: string;
    token_type: "bearer";
    expires_in: number;
} {
    if (!body.code) {
        throw new Error("Missing code");
    }
    const entry = ourAuthCodes.get(body.code);
    if (!entry) {
        throw new Error("Unknown or already-used code");
    }
    ourAuthCodes.delete(body.code);

    if (entry.mcpCodeChallenge) {
        if (!body.code_verifier || !verifyPkce(body.code_verifier, entry.mcpCodeChallenge)) {
            throw new Error("PKCE verification failed");
        }
    }

    const ourAccessToken = randomToken();
    issuedTokens.set(ourAccessToken, entry.lunacalTokens);

    return {
        access_token: ourAccessToken,
        token_type: "bearer",
        expires_in: Math.max(0, Math.floor((entry.lunacalTokens.expiresAt - Date.now()) / 1000)),
    };
}

/** Resolves one of our issued access tokens back to the underlying Lunacal access token, for the API client to use. */
export function resolveLunacalAccessToken(ourAccessToken: string): string | undefined {
    return issuedTokens.get(ourAccessToken)?.accessToken;
}
