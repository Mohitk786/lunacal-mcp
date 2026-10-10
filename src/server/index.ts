import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import dotenv from "dotenv";
import { McpServer, createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { registerLunacalTools } from "./lunacalTools.js";
import { getWebappUrl } from "./lunacalApiClient.js";
import {
    registerMcpClient,
    beginAuthorization,
    finishLunacalAuthorization,
    exchangeOurCode,
    resolveLunacalAccessToken,
} from "./oauthBroker.js";

dotenv.config();

const PORT = Number(process.env.PORT ?? process.env.LUNACAL_MCP_PORT ?? 3939);
const PUBLIC_BASE_URL = process.env.LUNACAL_MCP_PUBLIC_URL ?? `http://localhost:${PORT}`;
const MCP_PATH = "/mcp";

const handler = createMcpHandler((ctx) => {
    const server = new McpServer({
        name: "lunacal",
        version: "1.0.0",
        icons: [{ src: `${getWebappUrl()}/lunacal-icon.svg`, mimeType: "image/svg+xml" }],
    });
    registerLunacalTools(server, ctx.authInfo?.token);
    return server;
});

const nodeHandler = toNodeHandler(handler);

const MAX_BODY_BYTES = 1024 * 1024;

const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

async function readRawBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
        totalBytes += (chunk as Buffer).length;
        if (totalBytes > MAX_BODY_BYTES) throw new Error("Request body too large");
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf-8");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await readRawBody(req);
    return raw ? JSON.parse(raw) : {};
}

async function readTokenRequestBody(req: IncomingMessage): Promise<Record<string, string>> {
    const raw = await readRawBody(req);
    if (!raw) return {};
    if (req.headers["content-type"]?.includes("application/json")) {
        return JSON.parse(raw);
    }
    return Object.fromEntries(new URLSearchParams(raw));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", PUBLIC_BASE_URL);

    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

    if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
    }

    try {
        // --- OAuth discovery (RFC 8414) ---
        if (url.pathname === "/.well-known/oauth-authorization-server") {
            sendJson(res, 200, {
                issuer: PUBLIC_BASE_URL,
                authorization_endpoint: `${PUBLIC_BASE_URL}/authorize`,
                token_endpoint: `${PUBLIC_BASE_URL}/token`,
                registration_endpoint: `${PUBLIC_BASE_URL}/register`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
            });
            return;
        }

        // --- OpenAI domain verification ---
        if (url.pathname === "/.well-known/openai-apps-challenge") {
            const token = process.env.OPENAI_DOMAIN_TOKEN ?? "";
            res.writeHead(200, { "Content-Type": "text/plain" }).end(token);
            return;
        }

        // --- OAuth Protected Resource Metadata (RFC 9728) ---
        if (url.pathname === "/.well-known/oauth-protected-resource") {
            sendJson(res, 200, {
                resource: `${PUBLIC_BASE_URL}/mcp`,
                authorization_servers: [PUBLIC_BASE_URL],
                bearer_methods_supported: ["header"],
            });
            return;
        }

        // --- RFC 7591 dynamic client registration ---
        if (url.pathname === "/register" && req.method === "POST") {
            const body = await readJsonBody(req);
            const redirectUris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
            sendJson(res, 201, registerMcpClient({ redirect_uris: redirectUris }));
            return;
        }

        // --- Step 1: MCP client sends the user's browser here ---
        if (url.pathname === "/authorize" && req.method === "GET") {
            const target = beginAuthorization(
                {
                    client_id: url.searchParams.get("client_id") ?? undefined,
                    redirect_uri: url.searchParams.get("redirect_uri") ?? undefined,
                    state: url.searchParams.get("state") ?? undefined,
                    code_challenge: url.searchParams.get("code_challenge") ?? undefined,
                    code_challenge_method: url.searchParams.get("code_challenge_method") ?? undefined,
                },
                PUBLIC_BASE_URL,
            );
            res.writeHead(302, { Location: target.toString() }).end();
            return;
        }

        // --- Step 2: Lunacal sends the browser back here after login+consent ---
        if (url.pathname === "/oauth/lunacal/callback" && req.method === "GET") {
            const target = await finishLunacalAuthorization({
                code: url.searchParams.get("code") ?? undefined,
                state: url.searchParams.get("state") ?? undefined,
            });
            res.writeHead(302, { Location: target.toString() }).end();
            return;
        }

        // --- Step 3: MCP client exchanges our code for one of our access tokens ---
        if (url.pathname === "/token" && req.method === "POST") {
            const body = await readTokenRequestBody(req);
            sendJson(res, 200, exchangeOurCode({ code: body.code, code_verifier: body.code_verifier }));
            return;
        }

        // --- The actual MCP endpoint ---
        if (url.pathname === MCP_PATH) {
            const authHeader = req.headers.authorization;
            const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;

            const lunacalToken = bearerToken ? resolveLunacalAccessToken(bearerToken) : undefined;
            if (!lunacalToken) {
                res.writeHead(401, {
                    "Content-Type": "application/json",
                    "WWW-Authenticate":
                        `Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`,
                });
            
                res.end(JSON.stringify({
                    error: "invalid_token",
                }));
            
                return;
            }

            (req as NodeIncomingMessageLike).auth = {
                token: lunacalToken,
                clientId: "lunacal-mcp",
                scopes: [],
            } satisfies AuthInfo;

            await nodeHandler(req, res);
            return;
        }

        res.writeHead(404).end();
    } catch (e) {
        console.error("Request error:", e);
        if (!res.headersSent) {
            const message = e instanceof SyntaxError
                ? "Invalid JSON in request body"
                : e instanceof Error && e.message === "Request body too large"
                    ? "Request body exceeds 1 MB limit"
                    : "Unexpected server error";
            sendJson(res, e instanceof SyntaxError ? 400 : 500, { error: message });
        }
    }
}).listen(PORT, "0.0.0.0", () => {
    console.log(`Lunacal MCP server listening on http://0.0.0.0:${PORT}${MCP_PATH}`);
    console.log(`OAuth endpoints under ${PUBLIC_BASE_URL} (/authorize, /token, /register)`);
});

