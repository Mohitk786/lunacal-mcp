import { z } from "zod";
import type { ToolDef } from "./_types.js";
import { READ_ONLY } from "./_types.js";
import { callLunacalApi } from "../utils/api-client.js";
import { withLunacal, textResult } from "./_helpers.js";

function slimTeam(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    const team = value as Record<string, unknown>;
    return {
        id: team.id,
        name: team.name,
        slug: team.slug,
        role: team.role,
        accepted: team.accepted,
        isOrganization: team.isOrganization,
        eventTypesCount: team.eventTypesCount,
    };
}

function slimTeams(payload: unknown): unknown {
    if (Array.isArray(payload)) return payload.map(slimTeam);
    return payload;
}

function slimMember(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    const member = value as Record<string, unknown>;
    return {
        id: member.id,
        name: member.name,
        username: member.username,
        accepted: member.accepted,
    };
}

function slimMembers(payload: unknown): unknown {
    if (Array.isArray(payload)) return payload.map(slimMember);
    return payload;
}

export const tools: ToolDef[] = [
    {
        name: "list_teams",
        title: "List teams",
        description:
            "List the teams the user belongs to, with the user's role (OWNER, ADMIN, or MEMBER), whether they have " +
            "accepted the invite, and the team's active event type count. Use a team id from this list with " +
            "list_team_members, list_event_types, or list_bookings. Pass includeOrgs to also include organizations. " +
            "Read-only.",
        annotations: READ_ONLY,
        inputSchema: z.object({
            includeOrgs: z.boolean().optional().describe("Include organizations in the result (excluded by default)"),
        }),
        handler: async (args, ctx) => {
            const body = args.includeOrgs != null ? { includeOrgs: args.includeOrgs } : undefined;
            const payload = await withLunacal(ctx, true, (token) => callLunacalApi("/teams/list", token, body));
            return textResult(slimTeams(payload));
        },
    },
    {
        name: "list_team_members",
        title: "List team members",
        description:
            "List the members of one or more teams: each member's id, name, username, and whether they have accepted " +
            "the invite. Pass teamIds from list_teams. Only returns members of teams where the user is an accepted " +
            "member. Members are deduplicated across the given teams. Read-only.",
        annotations: READ_ONLY,
        inputSchema: z.object({
            teamIds: z.array(z.coerce.number().int()).min(1).describe("Team ids from list_teams"),
        }),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, true, (token) =>
                callLunacalApi("/teams/members", token, { teamIds: args.teamIds }),
            );
            return textResult(slimMembers(payload));
        },
    },
];
