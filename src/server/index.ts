#!/usr/bin/env node
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { McpServer, createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { config } from "./config.js";
import { sha256 } from "./crypto.js";
import { checkDb, cleanupExpired, closePool, migrate } from "./db.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { getWebappUrl } from "./lunacalApiClient.js";
import { registerLunacalTools } from "./lunacalTools.js";
import { log } from "./log.js";
import { GrantDeadError, OAuthError, UpstreamTemporaryError } from "./oauthErrors.js";
import {
    beginAuthorization,
    exchangeToken,
    finishLunacalAuthorization,
    registerMcpClient,
    resolveMcpAccess,
} from "./oauthBroker.js";
import { RateLimiter } from "./rateLimit.js";
import { requestStore, type RequestStore } from "./requestContext.js";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 1024 * 1024;

const handler = createMcpHandler((ctx) => {
    const server = new McpServer(
        {
            name: "lunacal",
            version: "1.1.0",
            icons: [{ src: `${getWebappUrl()}/lunacal-icon.svg`, mimeType: "image/svg+xml" }],
        },
        { instructions: SERVER_INSTRUCTIONS },
    );
    registerLunacalTools(server, ctx.authInfo);
    return server;
});

const nodeHandler = toNodeHandler(handler);

const rateLimiters = {
    general: new RateLimiter(config.oauthRateLimitMax, 60_000),
    register: new RateLimiter(config.registerRateLimitMax, 60_000),
    token: new RateLimiter(config.oauthRateLimitMax, 60_000),
    mcp: new RateLimiter(config.mcpRateLimitMax, 60_000),
};

const rateTimer = setInterval(() => {
    for (const limiter of Object.values(rateLimiters)) limiter.cleanup();
}, 60_000);
rateTimer.unref();

const cleanupTimer = setInterval(() => {
    cleanupExpired().catch((err: unknown) => {
        log.error("cleanup failed", { message: err instanceof Error ? err.message : "unknown" });
    });
}, 5 * 60 * 1000);
cleanupTimer.unref();

function clientIp(req: IncomingMessage): string {
    if (config.trustProxy) {
        const forwarded = req.headers["x-forwarded-for"];
        const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        if (raw) {
            const first = raw.split(",")[0]?.trim();
            if (first) return first;
        }
    }
    return req.socket.remoteAddress ?? "unknown";
}

function wwwAuthenticate(): string {
    return `Bearer error="invalid_token", resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource"`;
}

function applyCors(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra?: OutgoingHttpHeaders): void {
    const headers: OutgoingHttpHeaders = {
        "Content-Type": "application/json",
        ...extra,
    };
    res.writeHead(status, headers).end(JSON.stringify(body));
}

function sendOAuthError(res: ServerResponse, err: OAuthError, path: string): void {
    log.warn("oauth error", {
        path,
        oauthError: err.oauthError,
        description: err.description,
        status: err.status,
    });
    sendJson(res, err.status, { error: err.oauthError, error_description: err.description }, {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
    });
}

async function readRawBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
        const buf = chunk as Buffer;
        totalBytes += buf.length;
        if (totalBytes > MAX_BODY_BYTES) throw new OAuthError("invalid_request", "Request body exceeds 1 MB", 400);
        chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readRawBody(req);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new OAuthError("invalid_request", "Request body must be a JSON object", 400);
        }
        return parsed as Record<string, unknown>;
    } catch (err) {
        if (err instanceof OAuthError) throw err;
        throw new OAuthError("invalid_request", "Invalid JSON in request body", 400);
    }
}

async function readTokenRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readRawBody(req);
    if (!raw) return {};
    if (req.headers["content-type"]?.includes("application/json")) {
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new OAuthError("invalid_request", "Request body must be a JSON object", 400);
            }
            return parsed as Record<string, unknown>;
        } catch (err) {
            if (err instanceof OAuthError) throw err;
            throw new OAuthError("invalid_request", "Invalid JSON in request body", 400);
        }
    }
    return Object.fromEntries(new URLSearchParams(raw));
}

function installUnauthorizedOverride(res: ServerResponse, store: RequestStore): void {
    const authenticate = wwwAuthenticate();
    const originalWriteHead = res.writeHead.bind(res);
    const originalEnd = res.end.bind(res);
    res.writeHead = ((statusCode: number, ...rest: unknown[]) => {
        if (store.forceUnauthorized && !res.headersSent) {
            res.setHeader("WWW-Authenticate", authenticate);
            return originalWriteHead(401, ...(rest as []));
        }
        return originalWriteHead(statusCode, ...(rest as []));
    }) as typeof res.writeHead;
    res.end = ((...args: unknown[]) => {
        if (store.forceUnauthorized && !res.headersSent) {
            res.statusCode = 401;
            res.setHeader("WWW-Authenticate", authenticate);
        }
        return originalEnd(...(args as []));
    }) as typeof res.end;
}

function sendUnauthorized(res: ServerResponse): void {
    res.setHeader("WWW-Authenticate", wwwAuthenticate());
    sendJson(res, 401, { error: "invalid_token" });
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", config.publicBaseUrl);
    applyCors(res);

    if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
    }

    try {
        if (url.pathname === "/health" && req.method === "GET") {
            try {
                await checkDb();
                sendJson(res, 200, { ok: true });
            } catch (err) {
                log.error("health check failed", { message: err instanceof Error ? err.message : "unknown" });
                sendJson(res, 503, { ok: false });
            }
            return;
        }

        if (url.pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
            sendJson(res, 200, {
                issuer: config.publicBaseUrl,
                authorization_endpoint: `${config.publicBaseUrl}/authorize`,
                token_endpoint: `${config.publicBaseUrl}/token`,
                registration_endpoint: `${config.publicBaseUrl}/register`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
            });
            return;
        }

        if (url.pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
            sendJson(res, 200, {
                resource: `${config.publicBaseUrl}/mcp`,
                authorization_servers: [config.publicBaseUrl],
                bearer_methods_supported: ["header"],
            });
            return;
        }

        if (url.pathname === "/.well-known/openai-apps-challenge" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "text/plain" }).end(config.openaiDomainToken);
            return;
        }

        const ip = clientIp(req);
        const bearer = req.headers.authorization?.startsWith("Bearer ")
            ? req.headers.authorization.slice("Bearer ".length)
            : undefined;

        const limiter =
            url.pathname === MCP_PATH ? rateLimiters.mcp
            : url.pathname === "/register" ? rateLimiters.register
            : url.pathname === "/token" ? rateLimiters.token
            : rateLimiters.general;
        const limitKey = url.pathname === MCP_PATH && bearer ? `mcp:${sha256(bearer)}` : `ip:${ip}:${url.pathname}`;
        const decision = limiter.check(limitKey);
        if (!decision.allowed) {
            res.setHeader("Retry-After", String(decision.retryAfterSeconds));
            sendJson(res, 429, { error: "too_many_requests", error_description: "Rate limit exceeded" });
            return;
        }

        if (url.pathname === "/register" && req.method === "POST") {
            const body = await readJsonBody(req);
            sendJson(res, 201, await registerMcpClient(body));
            return;
        }

        if (url.pathname === "/authorize" && req.method === "GET") {
            const location = await beginAuthorization({
                client_id: url.searchParams.get("client_id") ?? undefined,
                redirect_uri: url.searchParams.get("redirect_uri") ?? undefined,
                state: url.searchParams.get("state") ?? undefined,
                code_challenge: url.searchParams.get("code_challenge") ?? undefined,
                code_challenge_method: url.searchParams.get("code_challenge_method") ?? undefined,
                response_type: url.searchParams.get("response_type") ?? undefined,
            });
            res.writeHead(302, { Location: location }).end();
            return;
        }

        if (url.pathname === "/oauth/lunacal/callback" && req.method === "GET") {
            const location = await finishLunacalAuthorization({
                code: url.searchParams.get("code") ?? undefined,
                state: url.searchParams.get("state") ?? undefined,
                error: url.searchParams.get("error") ?? undefined,
            });
            res.writeHead(302, { Location: location }).end();
            return;
        }

        if (url.pathname === "/token" && req.method === "POST") {
            const body = await readTokenRequestBody(req);
            sendJson(res, 200, await exchangeToken(body), { "Cache-Control": "no-store", Pragma: "no-cache" });
            return;
        }

        if (url.pathname === MCP_PATH) {
            if (!bearer) {
                sendUnauthorized(res);
                return;
            }
            let resolved: Awaited<ReturnType<typeof resolveMcpAccess>>;
            try {
                resolved = await resolveMcpAccess(bearer);
            } catch (err) {
                if (err instanceof GrantDeadError) {
                    sendUnauthorized(res);
                    return;
                }
                if (err instanceof UpstreamTemporaryError) {
                    log.error("mcp upstream auth failure", { message: err.message });
                    sendJson(res, 503, { error: "temporarily_unavailable", error_description: err.message });
                    return;
                }
                throw err;
            }
            if (!resolved) {
                sendUnauthorized(res);
                return;
            }

            (req as NodeIncomingMessageLike).auth = {
                token: resolved.lunacalAccessToken,
                clientId: resolved.clientId,
                scopes: [],
                expiresAt: resolved.expiresAt,
                extra: { grantId: resolved.grantId },
            } satisfies AuthInfo;

            const store: RequestStore = { forceUnauthorized: false };
            installUnauthorizedOverride(res, store);
            await requestStore.run(store, () => nodeHandler(req, res));
            return;
        }

        res.writeHead(404).end();
    } catch (err) {
        if (res.headersSent) {
            log.error("request failed after headers were sent", {
                path: url.pathname,
                message: err instanceof Error ? err.message : "unknown",
            });
            return;
        }
        if (err instanceof OAuthError) {
            sendOAuthError(res, err, url.pathname);
            return;
        }
        log.error("request failed", {
            path: url.pathname,
            message: err instanceof Error ? err.message : "unknown",
        });
        sendJson(res, 500, { error: "server_error", error_description: "Unexpected server error" });
    }
});

let shuttingDown = false;

function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    clearInterval(rateTimer);
    clearInterval(cleanupTimer);
    server.close(() => {
        closePool()
            .then(() => process.exit(0))
            .catch((err: unknown) => {
                log.error("failed to close database pool", { message: err instanceof Error ? err.message : "unknown" });
                process.exit(1);
            });
    });
    setTimeout(() => process.exit(1), 20_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

migrate()
    .then(() => {
        server.listen(config.port, "0.0.0.0", () => {
            log.info("listening", { port: config.port, publicBaseUrl: config.publicBaseUrl });
        });
    })
    .catch((err: unknown) => {
        log.error("startup failed", { message: err instanceof Error ? err.message : "unknown" });
        process.exit(1);
    });
