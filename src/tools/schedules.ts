import { z } from "zod";
import type { ToolDef } from "./_types.js";
import { READ_ONLY } from "./_types.js";
import { callLunacalApi } from "../utils/api-client.js";
import { withLunacal, textResult } from "./_helpers.js";

const timeRange = z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/, "HH:mm format, e.g. 09:00"),
    end: z.string().regex(/^\d{2}:\d{2}$/, "HH:mm format, e.g. 17:00"),
});

function timeToIso(hhmm: string): string {
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(Date.UTC(1970, 0, 1, h, m, 0)).toISOString();
}

function convertSchedule(schedule: { start: string; end: string }[][]): { start: string; end: string }[][] {
    return schedule.map((day) =>
        day.map((range) => ({ start: timeToIso(range.start), end: timeToIso(range.end) })),
    );
}

function slimSchedule(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.schedules)) {
        return record.schedules.map(slimOneSchedule);
    }
    if (record.schedule && typeof record.schedule === "object") {
        return {
            schedule: slimOneSchedule(record.schedule),
            availability: record.availability,
            timeZone: record.timeZone,
            isDefault: record.isDefault,
        };
    }
    return record;
}

function slimOneSchedule(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    const s = value as Record<string, unknown>;
    return {
        id: s.id,
        name: s.name,
        timeZone: s.timeZone,
        isDefault: s.isDefault,
        availability: s.availability,
    };
}

export const tools: ToolDef[] = [
    {
        name: "list_schedules",
        title: "List schedules",
        description:
            "List the user's availability schedules. Each schedule has a name, timezone, and weekly availability " +
            "windows. Event types reference a schedule by scheduleId. Use a schedule id from this list with " +
            "update_schedule. Read-only.",
        annotations: READ_ONLY,
        inputSchema: z.object({
            teamId: z.coerce.number().int().optional().describe("Filter to schedules belonging to this team"),
        }),
        handler: async (args, ctx) => {
            const body = args.teamId != null ? { teamId: args.teamId } : undefined;
            const payload = await withLunacal(ctx, true, (token) =>
                callLunacalApi("/schedules/list", token, body),
            );
            return textResult(slimSchedule(payload));
        },
    },
    {
        name: "update_schedule",
        title: "Update schedule",
        description:
            "Update a weekly availability schedule. Pass only the fields to change. " +
            "schedule is a 7-element array indexed 0–6 for Sunday–Saturday. Each element is an array of " +
            "time ranges with start and end in HH:mm format (e.g. {start: '09:00', end: '17:00'}). " +
            "An empty array means no availability that day. " +
            "Confirm with the user before calling — this changes when bookings can be made on linked event types.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: z.object({
            scheduleId: z.coerce.number().int(),
            name: z.string().optional().describe("Schedule display name"),
            timeZone: z.string().optional().describe("IANA timezone, e.g. America/New_York"),
            isDefault: z.boolean().optional().describe("Set as the user's default schedule"),
            schedule: z
                .array(z.array(timeRange))
                .length(7)
                .optional()
                .describe(
                    "Weekly hours: 7-element array [Sun, Mon, Tue, Wed, Thu, Fri, Sat]. " +
                    "Each day is an array of {start, end} in HH:mm. Example: " +
                    '[[], [{"start":"09:00","end":"17:00"}], ...] sets Monday 9am–5pm, Sunday off.',
                ),
        }),
        handler: async (args, ctx) => {
            const body: Record<string, unknown> = { scheduleId: args.scheduleId };
            if (args.name != null) body.name = args.name;
            if (args.timeZone != null) body.timeZone = args.timeZone;
            if (args.isDefault != null) body.isDefault = args.isDefault;
            if (args.schedule != null) {
                body.schedule = convertSchedule(args.schedule as { start: string; end: string }[][]);
            }
            const payload = await withLunacal(ctx, false, (token) =>
                callLunacalApi("/schedules/update", token, body),
            );
            return textResult(slimSchedule(payload));
        },
    },
];
