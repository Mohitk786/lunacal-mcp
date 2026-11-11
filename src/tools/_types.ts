import type { z } from "zod";

export type ToolResult = {
    content: { type: "text"; text: string }[];
    isError?: boolean;
};

export type ToolAnnotations = {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
};

export type ToolCtx = { accessToken: string; grantId: string };

export type ToolDef = {
    name: string;
    title: string;
    description: string;
    inputSchema: z.ZodType;
    annotations: ToolAnnotations;
    handler: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
};

export const READ_ONLY: ToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
