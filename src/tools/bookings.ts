import { z } from "zod";
import type { ToolDef } from "./_types.js";
import { READ_ONLY } from "./_types.js";
import { callLunacalApi } from "../utils/api-client.js";
import { withLunacal, textResult, isoDateTime, timezone, buildBookingResponses } from "./_helpers.js";

function slimBooking(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    const booking = value as Record<string, unknown>;
    if (typeof booking.uid !== "string" && booking.id == null) return value;
    const attendees = Array.isArray(booking.attendees)
        ? booking.attendees.map((attendee) => {
              if (!attendee || typeof attendee !== "object") return attendee;
              const record = attendee as Record<string, unknown>;
              return { name: record.name, email: record.email, timeZone: record.timeZone };
          })
        : undefined;
    return {
        id: booking.id,
        uid: booking.uid,
        title: booking.title,
        status: booking.status,
        start: booking.startTime ?? booking.start,
        end: booking.endTime ?? booking.end,
        eventTypeId: booking.eventTypeId ?? (booking.eventType as { id?: unknown } | undefined)?.id,
        attendees,
    };
}

function slimBookings(payload: unknown): unknown {
    if (Array.isArray(payload)) return payload.map(slimBooking);
    if (!payload || typeof payload !== "object") return payload;
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.bookings)) {
        return { ...record, bookings: record.bookings.map(slimBooking) };
    }
    return slimBooking(payload);
}

export const tools: ToolDef[] = [
    {
        name: "list_bookings",
        title: "List bookings",
        description:
            "List the user's bookings. status is required. Pass limit (default 20, max 100) and cursor from a " +
            "previous nextCursor for the next page. Use a booking uid from this list to reschedule or cancel. Read-only.",
        annotations: READ_ONLY,
        inputSchema: z.object({
            status: z.enum(["upcoming", "recurring", "past", "cancelled", "unconfirmed"]),
            timezone: timezone.optional().describe("How to interpret startDate and endDate when they are local times"),
            teamIds: z.array(z.coerce.number().int()).optional(),
            eventTypeIds: z.array(z.coerce.number().int()).optional(),
            search: z.string().optional(),
            startDate: isoDateTime.optional(),
            endDate: isoDateTime.optional(),
            attendeeEmail: z.string().optional(),
            limit: z.coerce.number().int().min(1).max(100).default(20),
            cursor: z.coerce.number().int().optional().describe("Offset from a previous response's nextCursor"),
        }),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, true, (token) =>
                callLunacalApi("/bookings/list", token, {
                    filters: {
                        status: args.status,
                        teamIds: args.teamIds,
                        eventTypeIds: args.eventTypeIds,
                        search: args.search,
                        startDate: args.startDate,
                        endDate: args.endDate,
                        attendeeEmail: args.attendeeEmail,
                    },
                    limit: args.limit,
                    cursor: args.cursor,
                }),
            );
            return textResult(slimBookings(payload));
        },
    },
    {
        name: "create_booking",
        title: "Create booking",
        description:
            "Book a slot on an event type. Call find_available_slots first and pass one of those start times. " +
            "If the event type has required bookingFields from get_event_type, put the answers in additionalResponses " +
            "keyed by each field's name. This does not check availability itself. Lunacal emails the attendee and " +
            "any guests, and that notice cannot be unsent. Calling this again can create a second booking.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        inputSchema: z.object({
            eventTypeId: z.coerce.number().int(),
            start: isoDateTime,
            end: isoDateTime.optional(),
            timezone,
            name: z.string().describe("Attendee name"),
            email: z.string().describe("Attendee email"),
            guests: z.array(z.string()).optional().describe("Additional guest emails"),
            notes: z.string().optional(),
            location: z.string().optional().describe('Selected location value, for example "integrations:daily" or an address'),
            additionalResponses: z
                .record(z.string(), z.unknown())
                .optional()
                .describe("Answers to custom booking questions, keyed by bookingFields.name"),
            language: z.string().default("en"),
            metadata: z.record(z.string(), z.string()).default({}),
        }),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, false, (token) =>
                callLunacalApi("/bookings/create", token, {
                    eventTypeId: args.eventTypeId,
                    start: args.start,
                    end: args.end,
                    timeZone: args.timezone,
                    language: args.language,
                    metadata: args.metadata,
                    responses: buildBookingResponses({
                        name: args.name as string,
                        email: args.email as string,
                        guests: args.guests as string[] | undefined,
                        notes: args.notes as string | undefined,
                        location: args.location as string | undefined,
                        additionalResponses: args.additionalResponses as Record<string, unknown> | undefined,
                    }),
                    bookingUids: [],
                    slots: [],
                }),
            );
            return textResult(slimBooking(payload));
        },
    },
    {
        name: "reschedule_booking",
        title: "Reschedule booking",
        description:
            "Move an existing booking to a new start time. Call find_available_slots with rescheduleUid first. " +
            "Requires the booking uid from list_bookings, the event type id, and the attendee name and email. " +
            "This overwrites the current time and Lunacal emails the attendee. Confirm with the user before calling.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        inputSchema: z.object({
            rescheduleUid: z.string().describe("uid of the booking to move"),
            eventTypeId: z.coerce.number().int(),
            start: isoDateTime,
            end: isoDateTime.optional(),
            timezone,
            name: z.string(),
            email: z.string(),
            guests: z.array(z.string()).optional(),
            notes: z.string().optional(),
            location: z.string().optional(),
            rescheduleReason: z.string().optional(),
            additionalResponses: z.record(z.string(), z.unknown()).optional(),
            language: z.string().default("en"),
            metadata: z.record(z.string(), z.string()).default({}),
        }),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, false, (token) =>
                callLunacalApi("/bookings/create", token, {
                    rescheduleUid: args.rescheduleUid,
                    eventTypeId: args.eventTypeId,
                    start: args.start,
                    end: args.end,
                    timeZone: args.timezone,
                    language: args.language,
                    metadata: args.metadata,
                    responses: buildBookingResponses({
                        name: args.name as string,
                        email: args.email as string,
                        guests: args.guests as string[] | undefined,
                        notes: args.notes as string | undefined,
                        location: args.location as string | undefined,
                        rescheduleReason: args.rescheduleReason as string | undefined,
                        additionalResponses: args.additionalResponses as Record<string, unknown> | undefined,
                    }),
                    bookingUids: [],
                    slots: [],
                }),
            );
            return textResult(slimBooking(payload));
        },
    },
    {
        name: "cancel_booking",
        title: "Cancel booking",
        description:
            "Cancel a booking by uid (not the numeric id). Confirm with the user first. " +
            "This cannot be undone, and Lunacal emails the attendees. allRemainingBookings also cancels the rest " +
            "of a recurring series. If Lunacal requires a reason, pass cancellationReason.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        inputSchema: z.object({
            uid: z.string().describe("Booking uid"),
            cancellationReason: z.string().optional(),
            allRemainingBookings: z.boolean().optional().describe("Also cancel the rest of a recurring series"),
        }),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, false, (token) =>
                callLunacalApi("/bookings/cancel", token, {
                    uid: args.uid,
                    cancellationReason: args.cancellationReason,
                    allRemainingBookings: args.allRemainingBookings,
                }),
            );
            return textResult(payload);
        },
    },
    {
        name: "confirm_booking",
        title: "Confirm booking",
        description:
            "Confirm a pending booking on an event type that requires confirmation. Identify the booking by its " +
            "numeric bookingId (the id field from list_bookings, not the uid). Only bookings with status " +
            "'unconfirmed' can be confirmed. Lunacal emails the attendee to confirm the meeting is on. " +
            "Pass forceConfirm to confirm even when the slot now conflicts with another booking.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: z.object({
            bookingId: z.coerce.number().int().describe("Numeric booking id from list_bookings (not the uid)"),
            forceConfirm: z.boolean().optional().describe("Confirm even if the slot now conflicts with another booking"),
        }),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, false, (token) =>
                callLunacalApi("/bookings/confirm", token, {
                    bookingId: args.bookingId,
                    confirmed: true,
                    forceConfirm: args.forceConfirm,
                }),
            );
            return textResult(payload);
        },
    },
    {
        name: "decline_booking",
        title: "Decline booking",
        description:
            "Decline (reject) a pending booking on an event type that requires confirmation. Identify the booking " +
            "by its numeric bookingId (the id field from list_bookings, not the uid). Only bookings with status " +
            "'unconfirmed' can be declined. Confirm with the user first — this rejects the booking and Lunacal " +
            "emails the attendee. Pass recurringEventId to decline the whole recurring series, and reason to tell " +
            "the attendee why.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        inputSchema: z.object({
            bookingId: z.coerce.number().int().describe("Numeric booking id from list_bookings (not the uid)"),
            reason: z.string().optional().describe("Reason sent to the attendee for the decline"),
            recurringEventId: z.string().optional().describe("Decline all future bookings in this recurring series"),
        }),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, false, (token) =>
                callLunacalApi("/bookings/confirm", token, {
                    bookingId: args.bookingId,
                    confirmed: false,
                    reason: args.reason,
                    recurringEventId: args.recurringEventId,
                }),
            );
            return textResult(payload);
        },
    },
];
