import { config } from "./config.js";
import { exchangeLunacalCode } from "./lunacalOAuth.js";
import { log } from "./log.js";
import { lunacalAccessForGrant } from "./lunacalSession.js";
import { OAuthError } from "./oauthErrors.js";
import {
    consumePending,
    getClient,
    insertAuthCode,
    insertClient,
    insertPending,
    lookupAccessToken,
    publicTokenResponse,
    redeemAuthCode,
    rotateRefreshToken,
    type IssuedTokens,
} from "./oauthStore.js";

const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:"]);
const MAX_REDIRECT_URIS = 10;

export function validateRedirectUri(uri: string): string | undefined {
    if (uri.length === 0 || uri.length > 2000) return "redirect_uri is empty or too long";
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return "redirect_uri is not a valid URI";
    }
    if (url.username || url.password) return "redirect_uri must not contain credentials";
    if (url.hash) return "redirect_uri must not contain a fragment";
    const protocol = url.protocol.toLowerCase();
    if (BLOCKED_SCHEMES.has(protocol)) return `${protocol} redirect URIs are not allowed`;
    if (protocol === "http:") {
        const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
            return "http redirect_uri is only allowed for localhost or 127.0.0.1";
        }
        return undefined;
    }
    if (protocol === "https:") {
        if (!url.hostname) return "https redirect_uri needs a host";
        return undefined;
    }
    if (!/^[a-z][a-z0-9+.-]*:$/.test(protocol)) return "invalid redirect_uri scheme";
    return undefined;
}

function errorRedirect(redirectUri: string, error: string, description: string, state?: string | null): string {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state) url.searchParams.set("state", state);
    return url.toString();
}

export async function registerMcpClient(body: {
    redirect_uris?: unknown;
    client_name?: unknown;
}): Promise<{
    client_id: string;
    redirect_uris: string[];
    client_name?: string;
    grant_types: ["authorization_code", "refresh_token"];
    response_types: ["code"];
    token_endpoint_auth_method: "none";
    client_id_issued_at: number;
}> {
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
        throw new OAuthError("invalid_request", "redirect_uris must be a non-empty array", 400);
    }
    if (body.redirect_uris.length > MAX_REDIRECT_URIS) {
        throw new OAuthError("invalid_request", `At most ${MAX_REDIRECT_URIS} redirect_uris are allowed`, 400);
    }
    const redirectUris: string[] = [];
    for (const uri of body.redirect_uris) {
        if (typeof uri !== "string") {
            throw new OAuthError("invalid_request", "Each redirect_uri must be a string", 400);
        }
        const problem = validateRedirectUri(uri);
        if (problem) throw new OAuthError("invalid_redirect_uri", problem, 400);
        redirectUris.push(uri);
    }
    const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 256) : null;
    const client = await insertClient({ redirectUris, clientName });
    log.info("registered oauth client", { clientId: client.clientId });
    return {
        client_id: client.clientId,
        redirect_uris: client.redirectUris,
        ...(client.clientName ? { client_name: client.clientName } : {}),
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    };
}

export async function beginAuthorization(params: {
    client_id?: string;
    redirect_uri?: string;
    state?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    response_type?: string;
}): Promise<string> {
    if (!params.client_id || !params.redirect_uri) {
        throw new OAuthError("invalid_request", "client_id and redirect_uri are required", 400);
    }
    if (params.client_id.length > 256 || params.redirect_uri.length > 2000) {
        throw new OAuthError("invalid_request", "client_id or redirect_uri is too long", 400);
    }
    const client = await getClient(params.client_id);
    if (!client) {
        throw new OAuthError("invalid_request", "Unknown client_id", 400);
    }
    if (!client.redirectUris.includes(params.redirect_uri)) {
        throw new OAuthError("invalid_request", "redirect_uri is not registered for this client", 400);
    }
    if (params.response_type && params.response_type !== "code") {
        return errorRedirect(
            params.redirect_uri,
            "unsupported_response_type",
            "Only response_type=code is supported",
            params.state,
        );
    }
    if (params.state && params.state.length > 2000) {
        return errorRedirect(params.redirect_uri, "invalid_request", "state is too long", params.state);
    }
    if (!params.code_challenge || params.code_challenge_method !== "S256") {
        return errorRedirect(params.redirect_uri, "invalid_request", "PKCE with S256 is required", params.state);
    }
    if (params.code_challenge.length > 256) {
        return errorRedirect(params.redirect_uri, "invalid_request", "code_challenge is too long", params.state);
    }

    const state = await insertPending({
        clientId: params.client_id,
        redirectUri: params.redirect_uri,
        clientState: params.state ?? null,
        codeChallenge: params.code_challenge,
    });
    const url = new URL(`${config.lunacalWebappUrl}/auth/platform/authorize`);
    url.searchParams.set("redirect_uri", `${config.publicBaseUrl}/oauth/lunacal/callback`);
    url.searchParams.set("state", state);
    return url.toString();
}

export async function finishLunacalAuthorization(query: {
    code?: string;
    state?: string;
    error?: string;
}): Promise<string> {
    if (!query.state) {
        throw new OAuthError("invalid_request", "Missing state on Lunacal callback", 400);
    }
    const pending = await consumePending(query.state);
    if (!pending) {
        throw new OAuthError("invalid_request", "Unknown or expired state on Lunacal callback", 400);
    }
    if (query.error || !query.code) {
        return errorRedirect(
            pending.redirectUri,
            query.error ?? "access_denied",
            "Lunacal did not return an authorization code",
            pending.clientState,
        );
    }

    try {
        const tokens = await exchangeLunacalCode(query.code);
        const ourCode = await insertAuthCode({
            clientId: pending.clientId,
            redirectUri: pending.redirectUri,
            codeChallenge: pending.codeChallenge,
            lunacalAccessToken: tokens.accessToken,
            lunacalRefreshToken: tokens.refreshToken,
            lunacalExpiresAt: tokens.expiresAt,
            lunacalRefreshExpiresAt: tokens.refreshTokenExpiresAt,
        });
        const url = new URL(pending.redirectUri);
        url.searchParams.set("code", ourCode);
        if (pending.clientState) url.searchParams.set("state", pending.clientState);
        return url.toString();
    } catch (err) {
        log.error("lunacal callback failed", { message: err instanceof Error ? err.message : "unknown" });
        return errorRedirect(
            pending.redirectUri,
            "server_error",
            "Login could not be completed. Try connecting again.",
            pending.clientState,
        );
    }
}

function asString(body: Record<string, unknown>, key: string): string | undefined {
    const value = body[key];
    return typeof value === "string" ? value : undefined;
}

export async function exchangeToken(body: Record<string, unknown>): Promise<{
    access_token: string;
    token_type: "bearer";
    expires_in: number;
    refresh_token: string;
}> {
    const grantType = asString(body, "grant_type");
    const clientId = asString(body, "client_id");
    if (!grantType) throw new OAuthError("invalid_request", "grant_type is required", 400);
    if (!clientId) throw new OAuthError("invalid_request", "client_id is required", 400);

    let issued: IssuedTokens;
    if (grantType === "authorization_code") {
        const code = asString(body, "code");
        if (!code) throw new OAuthError("invalid_request", "code is required", 400);
        issued = await redeemAuthCode({
            code,
            clientId,
            codeVerifier: asString(body, "code_verifier"),
            redirectUri: asString(body, "redirect_uri"),
        });
    } else if (grantType === "refresh_token") {
        const refreshToken = asString(body, "refresh_token");
        if (!refreshToken) throw new OAuthError("invalid_request", "refresh_token is required", 400);
        issued = await rotateRefreshToken(refreshToken, clientId);
    } else {
        throw new OAuthError(
            "unsupported_grant_type",
            "Only authorization_code and refresh_token are supported",
            400,
        );
    }
    return publicTokenResponse(issued);
}

export async function resolveMcpAccess(ourAccessToken: string): Promise<{
    lunacalAccessToken: string;
    grantId: string;
    clientId: string;
    expiresAt: number;
} | undefined> {
    const row = await lookupAccessToken(ourAccessToken);
    if (!row) return undefined;
    const lunacalAccessToken = await lunacalAccessForGrant(row.grantId);
    return {
        lunacalAccessToken,
        grantId: row.grantId,
        clientId: row.clientId,
        expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
    };
}
