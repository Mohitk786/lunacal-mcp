import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { getWebappUrl } from "./utils/api-client.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { registerAllTools } from "./tools/_registry.js";

export const handler = createMcpHandler((ctx) => {
    const server = new McpServer(
        {
            name: "lunacal",
            version: "1.1.0",
            icons: [{ src: `${getWebappUrl()}/lunacal-icon.svg`, mimeType: "image/svg+xml" }],
        },
        { instructions: SERVER_INSTRUCTIONS },
    );
    registerAllTools(server, ctx.authInfo);
    return server;
});

export const nodeHandler = toNodeHandler(handler);
