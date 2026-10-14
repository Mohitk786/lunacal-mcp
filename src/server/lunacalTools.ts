import { z } from "zod";
import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { callLunacalMcpApi, LunacalApiError } from "./lunacalApiClient.js";
import { lunacalAccessForGrant } from "./lunacalSession.js";
import { GrantDeadError, UpstreamTemporaryError } from "./oauthErrors.js";
import { requestStore } from "./requestContext.js";

type ToolResult = {
    content: { type: "text"; text: string }[];
    isError?: boolean;
};

const isoDateTime = z
    .string()
    .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
        "ISO 8601 datetime with a timezone offset, for example 2026-10-13T15:00:00-04:00",
    );

const timezone = z.string().min(1).describe('IANA timezone, for example "America/New_York"');

const HINTS: Record<string, string> = {
    no_available_users_found_error:
        "That time is not available. Call find_available_slots for this event type and timezone, then book one of the returned slots.",
    hosts_unavailable_for_booking:
        "No host is free at that time. Call find_available_slots and choose an open slot.",
    booking_conflict: "That slot was just taken. Call find_available_slots and choose a different open slot.",
    booking_seats_full_error: "That slot has no seats left. Call find_available_slots and choose another slot.",
    not_enough_available_seats_error: "Not enough seats left. Call find_available_slots and choose another slot.",
    event_type_not_found_error: "No event type with that id. Call list_event_types and use an id from the result.",
    booking_not_found_error: "No booking with that uid. Call list_bookings and use a uid from the result.",
    cancelled_bookings_cannot_be_rescheduled: "That booking is already cancelled and cannot be rescheduled.",
    availability_not_found_in_schedule_error:
        "The event type's schedule has no availability. This server cannot edit weekly schedules.",
    cancellation_reason_required_error:
        "This booking requires cancellationReason. Ask the user for a reason and call cancel_booking again.",
    cancellation_not_allowed_past_deadline_error: "The cancellation deadline for this booking has passed.",
};

function textResult(data: unknown, isError = false): ToolResult {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    return {
        ...(isError ? { isError: true } : {}),
        content: [{ type: "text", text }],
    };
}

function apiMessage(body: unknown): string {
    if (!body || typeof body !== "object") return "Request failed";
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
    return "Request failed";
}

function formatApiError(error: LunacalApiError): string {
    const message = apiMessage(error.body);
    const hint = Object.entries(HINTS).find(([code]) => message.includes(code))?.[1];
    return hint ? `${message}. ${hint}` : `Lunacal API error (${error.status}): ${message}`;
}

type ToolCtx = { accessToken: string; grantId: string };

function markReconnect(): void {
    const store = requestStore.getStore();
    if (store) store.forceUnauthorized = true;
}

async function withLunacal<T>(ctx: ToolCtx, readOnly: boolean, run: (accessToken: string) => Promise<T>): Promise<T> {
    try {
        return await run(ctx.accessToken);
    } catch (err) {
        if (!(err instanceof LunacalApiError) || err.status !== 401) throw err;
        let fresh: string;
        try {
            fresh = await lunacalAccessForGrant(ctx.grantId, ctx.accessToken);
        } catch (refreshErr) {
            if (refreshErr instanceof GrantDeadError) {
                markReconnect();
                throw new Error("Lunacal rejected this session. The user must reconnect.");
            }
            if (refreshErr instanceof UpstreamTemporaryError) {
                throw new Error(
                    "Lunacal could not refresh the session because of a temporary error. Retry shortly. The user does not need to reconnect.",
                );
            }
            throw refreshErr;
        }
        if (fresh !== ctx.accessToken) {
            if (!readOnly) {
                throw new Error("Lunacal rejected the access token and a new one was issued. Retry this tool call.");
            }
            try {
                return await run(fresh);
            } catch (retryErr) {
                if (retryErr instanceof LunacalApiError && retryErr.status === 401) {
                    markReconnect();
                    throw new Error("Lunacal rejected this session. The user must reconnect.");
                }
                throw retryErr;
            }
        }
        markReconnect();
        throw new Error("Lunacal rejected this session. The user must reconnect.");
    }
}

function fail(err: unknown): ToolResult {
    if (err instanceof LunacalApiError) return textResult(formatApiError(err), true);
    return textResult(err instanceof Error ? err.message : "Request failed", true);
}

function buildBookingResponses(fields: {
    name?: string;
    email?: string;
    guests?: string[];
    notes?: string;
    location?: string;
    rescheduleReason?: string;
    additionalResponses?: Record<string, unknown>;
}) {
    const { name, email, guests, notes, location, rescheduleReason, additionalResponses } = fields;
    return {
        name,
        email,
        guests,
        notes,
        rescheduleReason,
        ...(location ? { location: { value: location, optionValue: location } } : {}),
        ...additionalResponses,
    };
}

function slimBookingFields(value: unknown): unknown {
    if (!Array.isArray(value)) return undefined;
    return value.map((field) => {
        if (!field || typeof field !== "object") return field;
        const record = field as Record<string, unknown>;
        return {
            name: record.name,
            type: record.type,
            required: record.required,
            label: record.label,
        };
    });
}

function slimEventType(value: unknown, teamId?: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    const eventType = value as Record<string, unknown>;
    if (eventType.id == null) return value;
    return {
        id: eventType.id,
        title: eventType.title,
        slug: eventType.slug,
        length: eventType.length,
        description: typeof eventType.description === "string" ? eventType.description.slice(0, 500) : eventType.description,
        teamId: eventType.teamId ?? teamId ?? null,
        scheduleId: eventType.scheduleId ?? null,
        hidden: eventType.hidden,
        locations: eventType.locations,
        requiresConfirmation: eventType.requiresConfirmation,
        bookingFields: slimBookingFields(eventType.bookingFields),
    };
}

function flattenEventTypes(payload: unknown): unknown {
    if (!payload || typeof payload !== "object") return payload;
    const groups = (payload as { eventTypeGroups?: unknown }).eventTypeGroups;
    if (!Array.isArray(groups)) return payload;
    return groups.flatMap((group) => {
        if (!group || typeof group !== "object") return [];
        const record = group as { teamId?: unknown; eventTypes?: unknown[] };
        return (record.eventTypes ?? []).map((eventType) => slimEventType(eventType, record.teamId));
    });
}

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

type ToolDef = {
    name: string;
    title: string;
    description: string;
    inputSchema: z.ZodType;
    readOnly: boolean;
    destructive: boolean;
    handler: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
};

const tools: ToolDef[] = [
    {
        name: "get_my_profile",
        title: "Get my profile",
        description:
            "Get the signed-in user's Lunacal profile: name, email, username, and timezone. " +
            "Call this when you need the user's timezone before searching for slots.",
        readOnly: true,
        destructive: false,
        inputSchema: z.object({}),
        handler: async (_args, ctx) => {
            const profile = await withLunacal(ctx, true, (token) => callLunacalMcpApi("/me", token, {}));
            return textResult(slimProfile(profile));
        },
    },
    {
        name: "list_event_types",
        title: "List event types",
        description:
            "List the user's event types (personal and team). Use an id from this list with find_available_slots " +
            "and create_booking. scheduleId is informational; weekly hours cannot be edited with this server.",
        readOnly: true,
        destructive: false,
        inputSchema: z.object({
            teamIds: z.array(z.coerce.number().int()).optional(),
            slug: z.string().optional().describe("Keep only event types with this slug"),
        }),
        handler: async (args, ctx) => {
            const teamIds = args.teamIds as number[] | undefined;
            const slug = args.slug as string | undefined;
            const payload = await withLunacal(ctx, true, (token) =>
                callLunacalMcpApi("/event-types/list", token, teamIds ? { filters: { teamIds } } : {}),
            );
            const eventTypes = flattenEventTypes(payload);
            if (!Array.isArray(eventTypes) || !slug) return textResult(eventTypes);
            return textResult(eventTypes.filter((eventType) => (eventType as { slug?: string }).slug === slug));
        },
    },
    {
        name: "get_event_type",
        title: "Get event type",
        description:
            "Get one event type by numeric id, including locations and bookingFields. " +
            "Required booking questions must be answered in create_booking additionalResponses, keyed by field name.",
        readOnly: true,
        destructive: false,
        inputSchema: z.object({ id: z.coerce.number().int() }),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, true, (token) =>
                callLunacalMcpApi("/event-types/get", token, { id: args.id }),
            );
            return textResult(slimEventType(payload));
        },
    },
    {
        name: "find_available_slots",
        title: "Find available slots",
        description:
            "Find open booking slots for an event type between start and end. " +
            "Call this before create_booking or reschedule_booking. Identify the event type by eventTypeId, " +
            "or by eventTypeSlug plus usernameList. Times must include a timezone offset, and timezone is required.",
        readOnly: true,
        destructive: false,
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
                callLunacalMcpApi("/get-availability", token, {
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
    {
        name: "list_bookings",
        title: "List bookings",
        description:
            "List the user's bookings. status is required. Pass limit (default 20, max 100) and cursor from a " +
            "previous nextCursor for the next page. Use a booking uid from this list to reschedule or cancel.",
        readOnly: true,
        destructive: false,
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
                callLunacalMcpApi("/bookings/list", token, {
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
            "keyed by each field's name. This does not check availability itself.",
        readOnly: false,
        destructive: false,
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
                callLunacalMcpApi("/bookings/create", token, {
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
            "Requires the booking uid from list_bookings, the event type id, and the attendee name and email.",
        readOnly: false,
        destructive: false,
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
                callLunacalMcpApi("/bookings/create", token, {
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
            "This cannot be undone. If Lunacal requires a reason, pass cancellationReason.",
        readOnly: false,
        destructive: true,
        inputSchema: z.object({
            uid: z.string().describe("Booking uid"),
            cancellationReason: z.string().optional(),
            allRemainingBookings: z.boolean().optional().describe("Also cancel the rest of a recurring series"),
        }),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, false, (token) =>
                callLunacalMcpApi("/bookings/cancel", token, {
                    uid: args.uid,
                    cancellationReason: args.cancellationReason,
                    allRemainingBookings: args.allRemainingBookings,
                }),
            );
            return textResult(payload);
        },
    },
    {
        name: "create_event_type",
        title: "Create event type",
        description: "Create an event type the user owns. length is the duration in minutes.",
        readOnly: false,
        destructive: false,
        inputSchema: z
            .object({
                title: z.string().min(1),
                slug: z.string().min(1),
                length: z.coerce.number().int().describe("Duration in minutes"),
                description: z.string().optional(),
                hidden: z.boolean().optional(),
                teamId: z.coerce.number().int().optional(),
                schedulingType: z.enum(["ROUND_ROBIN", "COLLECTIVE", "MANAGED"]).optional(),
                locations: z.array(z.record(z.string(), z.unknown())).optional(),
                bookingFields: z.array(z.record(z.string(), z.unknown())).optional(),
                metadata: z.record(z.string(), z.unknown()).optional(),
            })
            .loose(),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, false, (token) => callLunacalMcpApi("/event-types/create", token, args));
            return textResult(slimEventType(payload));
        },
    },
    {
        name: "update_event_type",
        title: "Update event type",
        description:
            "Update an event type. metadata, locations, and bookingFields replace the whole value, " +
            "so read get_event_type first when changing only part of them.",
        readOnly: false,
        destructive: false,
        inputSchema: z
            .object({
                id: z.coerce.number().int(),
                title: z.string().optional(),
                description: z.string().optional(),
                slug: z.string().optional(),
                length: z.coerce.number().int().optional().describe("Duration in minutes"),
                locations: z.array(z.record(z.string(), z.unknown())).optional(),
                bookingFields: z.array(z.record(z.string(), z.unknown())).optional(),
                metadata: z.record(z.string(), z.unknown()).optional(),
            })
            .loose(),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, false, (token) => callLunacalMcpApi("/event-types/update", token, args));
            return textResult(slimEventType(payload));
        },
    },
    {
        name: "set_event_type_published",
        title: "Publish or unpublish event type",
        description: "Set whether an event type is published (bookable) or hidden from the public booking page.",
        readOnly: false,
        destructive: false,
        inputSchema: z.object({
            eventId: z.coerce.number().int(),
            isPublished: z.boolean(),
            teamId: z.coerce.number().int().optional(),
        }),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, false, (token) =>
                callLunacalMcpApi("/event-types/switch-published", token, args),
            );
            return textResult(payload);
        },
    },
];

export function registerLunacalTools(server: McpServer, auth?: AuthInfo): void {
    const accessToken = auth?.token;
    const grantId = typeof auth?.extra?.grantId === "string" ? auth.extra.grantId : undefined;
    for (const tool of tools) {
        server.registerTool(
            tool.name,
            {
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputSchema,
                annotations: {
                    readOnlyHint: tool.readOnly,
                    destructiveHint: tool.destructive,
                    idempotentHint: tool.readOnly,
                    openWorldHint: !tool.readOnly,
                },
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
