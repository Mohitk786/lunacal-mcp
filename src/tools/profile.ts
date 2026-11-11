import { z } from "zod";
import type { ToolDef } from "./_types.js";
import { READ_ONLY } from "./_types.js";
import { callLunacalApi } from "../utils/api-client.js";
import { withLunacal, textResult } from "./_helpers.js";

function slimProfile(payload: unknown): unknown {
    if (!payload || typeof payload !== "object") return payload;
    const profile = payload as Record<string, unknown>;
    const picked = {
        id: profile.id,
        name: profile.name,
        email: profile.email,
        username: profile.username,
        timeZone: profile.timeZone,
        weekStart: profile.weekStart,
        locale: profile.locale,
        defaultScheduleId: profile.defaultScheduleId,
    };
    return Object.values(picked).some((value) => value !== undefined) ? picked : payload;
}

export const tools: ToolDef[] = [
    {
        name: "get_my_profile",
        title: "Get my profile",
        description:
            "Get the signed-in user's Lunacal profile: name, email, username, and timezone. " +
            "Call this when you need the user's timezone before searching for slots. Reads the signed-in account only.",
        annotations: READ_ONLY,
        inputSchema: z.object({}),
        handler: async (_args, ctx) => {
            const profile = await withLunacal(ctx, true, (token) => callLunacalApi("/user/me", token, {}));
            return textResult(slimProfile(profile));
        },
    },
];
