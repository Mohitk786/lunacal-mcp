import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import type { ToolDef } from "./_types.js";
import { textResult, fail } from "./_helpers.js";

const toolsDir = dirname(fileURLToPath(import.meta.url));

const allTools: ToolDef[] = [];

const files = readdirSync(toolsDir)
    .filter((f) => f.endsWith(".js") && !f.startsWith("_"))
    .sort();

for (const file of files) {
    const mod = (await import(join(toolsDir, file))) as { tools?: ToolDef[] };
    if (Array.isArray(mod.tools)) allTools.push(...mod.tools);
}

export function registerAllTools(server: McpServer, auth?: AuthInfo): void {
    const accessToken = auth?.token;
    const grantId = typeof auth?.extra?.grantId === "string" ? auth.extra.grantId : undefined;

    for (const tool of allTools) {
        server.registerTool(
            tool.name,
            {
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputSchema,
                annotations: tool.annotations,
            },
            async (args) => {
                if (!accessToken || !grantId) {
                    return textResult("Not authenticated. Complete the OAuth login flow first.", true);
                }
                try {
                    return await tool.handler((args ?? {}) as Record<string, unknown>, { accessToken, grantId });
                } catch (err) {
                    return fail(err);
                }
            },
        );
    }
}
