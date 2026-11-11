import { z } from "zod";
import type { ToolDef } from "./_types.js";
import { READ_ONLY } from "./_types.js";
import { callLunacalApi } from "../utils/api-client.js";
import { withLunacal, textResult, isoDateTime, timezone } from "./_helpers.js";

export const tools: ToolDef[] = [
    {
        name: "find_available_slots",
        title: "Find available slots",
        description:
            "Find open booking slots for an event type between start and end. " +
            "Call this before create_booking or reschedule_booking. Identify the event type by eventTypeId, " +
            "or by eventTypeSlug plus usernameList. Times must include a timezone offset, and timezone is required. " +
            "This only returns slots. It does not book or notify anyone.",
        annotations: READ_ONLY,
        inputSchema: z.object({
            startTime: isoDateTime.describe("Range start"),
            endTime: isoDateTime.describe("Range end"),
            timezone,
            eventTypeId: z.coerce.number().int().optional(),
            eventTypeSlug: z.string().optional().describe("Requires usernameList when used instead of eventTypeId"),
            usernameList: z.array(z.string()).min(1).optional().describe("Host username(s); pairs with eventTypeSlug"),
            duration: z.coerce.number().int().optional().describe("For event types that offer more than one duration"),
            rescheduleUid: z.string().optional().describe("Exclude the booking being rescheduled from conflicts"),
        }),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, true, (token) =>
                callLunacalApi("/availability", token, {
                    startTime: args.startTime,
                    endTime: args.endTime,
                    timeZone: args.timezone,
                    eventTypeId: args.eventTypeId,
                    eventTypeSlug: args.eventTypeSlug,
                    usernameList: args.usernameList,
                    duration: args.duration,
                    rescheduleUid: args.rescheduleUid,
                }),
            );
            return textResult(payload);
        },
    },
];
