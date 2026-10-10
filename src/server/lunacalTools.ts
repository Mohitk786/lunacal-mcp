import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { callLunacalMcpApi, LunacalApiError } from "./lunacalApiClient.js";

type ToolResult = {
    content: { type: "text"; text: string }[];
    isError?: boolean;
};

function ok(data: unknown): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(e: unknown): ToolResult {
    if (e instanceof LunacalApiError) {
        return {
            isError: true,
            content: [{ type: "text", text: `Lunacal API error ${e.status}: ${JSON.stringify(e.body)}` }],
        };
    }
    return {
        isError: true,
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
    };
}

interface LunacalTool {
    name: string;
    title: string;
    description: string;
    inputSchema: z.ZodType;
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any, accessToken: string) => Promise<ToolResult>;
}

// Attendee fields live nested under `responses`, not flat on the booking body.
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

export const lunacalTools: LunacalTool[] = [
    {
        name: "getMe",
        title: "Get my profile",
        description:
            "Get the authenticated user's own Lunacal profile: name, email, username, timezone, subscription " +
            "and voice-agent-subscription state, team/event-type counts, feature flags, and more.",
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: z.object({
            includePasswordAdded: z.boolean().optional(),
            includeSubscription: z.boolean().optional(),
        }),
        handler: async (body, accessToken) => {
            try {
                return ok(await callLunacalMcpApi("/me", accessToken, body));
            } catch (e) {
                return err(e);
            }
        },
    },

    {
        name: "getBookings",
        title: "List bookings",
        description: "List the authenticated user's Lunacal bookings. `status` is required by the underlying API.",
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: z.object({
            status: z.enum(["upcoming", "recurring", "past", "cancelled", "unconfirmed"]),
            teamIds: z.array(z.coerce.number().int()).optional(),
            eventTypeIds: z.array(z.coerce.number().int()).optional(),
            search: z.string().optional(),
            startDate: z.string().datetime().optional(),
            endDate: z.string().datetime().optional(),
            attendeeEmail: z.string().email().optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
            cursor: z.coerce.number().int().optional().describe("Offset into the result set, from a previous call's nextCursor"),
        }),
        handler: async ({ status, teamIds, eventTypeIds, search, startDate, endDate, attendeeEmail, limit, cursor }, accessToken) => {
            try {
                return ok(
                    await callLunacalMcpApi("/bookings/list", accessToken, {
                        filters: { status, teamIds, eventTypeIds, search, startDate, endDate, attendeeEmail },
                        limit,
                        cursor,
                    }),
                );
            } catch (e) {
                return err(e);
            }
        },
    },

    {
        name: "getAvailability",
        title: "Get availability",
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
            "Get an event type's available booking slots in a time range. " +
            "createBooking and rescheduleBooking do not verify availability, so open slots should be " +
            "confirmed here before creating or rescheduling. Identify the event type by eventTypeId, " +
            "OR by eventTypeSlug combined with usernameList (the host's username, as a single-element " +
            "array for an individual).",
        inputSchema: z.object({
            startTime: z.string().describe("ISO 8601 range start"),
            endTime: z.string().describe("ISO 8601 range end"),
            eventTypeId: z.coerce.number().int().optional(),
            eventTypeSlug: z.string().optional().describe("Requires usernameList when used instead of eventTypeId"),
            usernameList: z.array(z.string()).min(1).optional().describe("Host username(s); pairs with eventTypeSlug"),
            timeZone: z.string().optional().describe("Invitee time zone; slots are returned relative to it"),
            duration: z.coerce.number().int().optional().describe("For event types with multiple duration options"),
            rescheduleUid: z.string().optional().describe("Excludes the booking being rescheduled from conflicts"),
            isTeamEvent: z.boolean().optional(),
            orgSlug: z.string().optional(),
        }),
        handler: async (body, accessToken) => {
            try {
                return ok(await callLunacalMcpApi("/get-availability", accessToken, body));
            } catch (e) {
                return err(e);
            }
        },
    },

    {
        name: "createBooking",
        title: "Create booking",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description:
            "Create a new booking against a Lunacal event type. This tool does not verify slot " +
            "availability. If the event type has custom booking questions (visible in " +
            "eventType.bookingFields from getEventTypeById), required ones must be answered via " +
            "additionalResponses or the booking will fail validation.",
        inputSchema: z.object({
            eventTypeId: z.coerce.number().int(),
            start: z.string().describe("ISO 8601 start time"),
            end: z.string().optional().describe("ISO 8601 end time"),
            timeZone: z.string().describe('IANA time zone, e.g. "America/New_York"'),
            name: z.string().describe("Attendee name"),
            email: z.string().describe("Attendee email"),
            guests: z.array(z.string()).optional().describe("Additional guest emails"),
            notes: z.string().optional(),
            location: z.string().optional().describe('Selected location value, e.g. "inPerson" or a link'),
            additionalResponses: z
                .record(z.string(), z.unknown())
                .optional()
                .describe(
                    "Answers to the event type's own custom booking questions, keyed by each question's " +
                        "field name exactly as it appears in eventType.bookingFields (from getEventTypeById) — " +
                        "e.g. { companyName: \"Acme\" }. Required questions fail the booking if omitted.",
                ),
            language: z.string().default("en"),
            metadata: z.record(z.string(), z.string()).default({}),
        }),
        handler: async (
            { eventTypeId, start, end, timeZone, name, email, guests, notes, location, additionalResponses, language, metadata },
            accessToken,
        ) => {
            try {
                return ok(
                    await callLunacalMcpApi("/bookings/create", accessToken, {
                        eventTypeId,
                        start,
                        end,
                        timeZone,
                        language,
                        metadata,
                        responses: buildBookingResponses({ name, email, guests, notes, location, additionalResponses }),
                        bookingUids: [],
                        slots: [],
                    }),
                );
            } catch (e) {
                return err(e);
            }
        },
    },

    {
        name: "rescheduleBooking",
        title: "Reschedule booking",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description:
            "Reschedule an existing booking to a new time. Internally uses the create-booking path " +
            "with rescheduleUid set. This tool does not verify slot availability. If the event type " +
            "has custom booking questions, required ones must be answered via additionalResponses.",
        inputSchema: z.object({
            rescheduleUid: z.string().describe("The uid of the booking being rescheduled"),
            eventTypeId: z.coerce.number().int(),
            start: z.string().describe("ISO 8601 new start time"),
            end: z.string().optional(),
            timeZone: z.string(),
            name: z.string().describe("Attendee name"),
            email: z.string().describe("Attendee email"),
            guests: z.array(z.string()).optional(),
            notes: z.string().optional(),
            location: z.string().optional(),
            rescheduleReason: z.string().optional(),
            additionalResponses: z
                .record(z.string(), z.unknown())
                .optional()
                .describe(
                    "Answers to the event type's own custom booking questions, keyed by each question's " +
                        "field name from eventType.bookingFields (getEventTypeById).",
                ),
            language: z.string().default("en"),
            metadata: z.record(z.string(), z.string()).default({}),
        }),
        handler: async (
            {
                rescheduleUid,
                eventTypeId,
                start,
                end,
                timeZone,
                name,
                email,
                guests,
                notes,
                location,
                rescheduleReason,
                additionalResponses,
                language,
                metadata,
            },
            accessToken,
        ) => {
            try {
                return ok(
                    await callLunacalMcpApi("/bookings/create", accessToken, {
                        rescheduleUid,
                        eventTypeId,
                        start,
                        end,
                        timeZone,
                        language,
                        metadata,
                        responses: buildBookingResponses({
                            name,
                            email,
                            guests,
                            notes,
                            location,
                            rescheduleReason,
                            additionalResponses,
                        }),
                        bookingUids: [],
                        slots: [],
                    }),
                );
            } catch (e) {
                return err(e);
            }
        },
    },

    {
        name: "cancelBooking",
        title: "Cancel booking",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: "Cancel a booking by its uid. Requires the booking uid, not the numeric booking id.",
        inputSchema: z.object({
            uid: z.string().describe("Booking uid"),
            allRemainingBookings: z.boolean().optional(),
            cancellationReason: z.string().optional(),
        }),
        handler: async ({ uid, allRemainingBookings, cancellationReason }, accessToken) => {
            try {
                return ok(
                    await callLunacalMcpApi("/bookings/cancel", accessToken, {
                        uid,
                        allRemainingBookings,
                        cancellationReason,
                    }),
                );
            } catch (e) {
                return err(e);
            }
        },
    },

    {
        name: "getEventTypes",
        title: "List event types",
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: "List the authenticated user's Lunacal event types (across their personal and team profiles).",
        inputSchema: z.object({
            teamIds: z.array(z.coerce.number().int()).optional(),
            slug: z.string().optional().describe("Client-side filter applied after fetching"),
        }),
        handler: async ({ teamIds, slug }, accessToken) => {
            try {
                const res = await callLunacalMcpApi<{
                    eventTypeGroups: { teamId: number | null; eventTypes: { slug: string }[] }[];
                }>("/event-types/list", accessToken, teamIds ? { filters: { teamIds } } : undefined);
                const eventTypes = res.eventTypeGroups.flatMap((g) => g.eventTypes);
                return ok(slug ? eventTypes.filter((et) => et.slug === slug) : eventTypes);
            } catch (e) {
                return err(e);
            }
        },
    },

    {
        name: "getEventTypeById",
        title: "Get event type",
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: "Get a single Lunacal event type by its numeric id, including team members and location options.",
        inputSchema: z.object({
            id: z.coerce.number().int(),
        }),
        handler: async ({ id }, accessToken) => {
            try {
                return ok(await callLunacalMcpApi("/event-types/get", accessToken, { id }));
            } catch (e) {
                return err(e);
            }
        },
    },

    {
        name: "createEventType",
        title: "Create event type",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description:
            "Create a new Lunacal event type with the specified fields. To enable Stripe payments, set " +
            "metadata.apps.stripe with enabled, price (in the currency's smallest unit), currency, and " +
            "credentialId (available in an existing event type's metadata from getEventTypeById).",
        inputSchema: z.object({
            title: z.string().min(1),
            slug: z.string().min(1),
            length: z.coerce.number().int().describe("Duration in minutes"),
            description: z.string().optional(),
            hidden: z.boolean().optional(),
            teamId: z.coerce.number().int().optional().describe("Required together with schedulingType for a team event"),
            schedulingType: z.enum(["ROUND_ROBIN", "COLLECTIVE", "MANAGED"]).optional(),
            minimumBookingNotice: z.coerce.number().int().min(0).optional(),
            beforeEventBuffer: z.coerce.number().int().min(0).optional(),
            afterEventBuffer: z.coerce.number().int().min(0).optional(),
            isPublished: z.boolean().optional(),
            seatsPerTimeSlot: z.coerce.number().int().nullable().optional().describe("Enables seats when set"),
            seatsShowAttendees: z.boolean().nullable().optional(),
            disableGuests: z.boolean().optional(),
            requiresConfirmation: z.boolean().optional(),
            successRedirectUrl: z.string().optional(),
            locations: z.array(z.record(z.string(), z.unknown())).optional(),
            bookingFields: z.array(z.record(z.string(), z.unknown())).optional(),
            metadata: z
                .record(z.string(), z.unknown())
                .optional()
                .describe("e.g. { apps: { stripe: { enabled, price, currency, credentialId } } }"),
        }).loose(),
        handler: async (body, accessToken) => {
            try {
                return ok(await callLunacalMcpApi("/event-types/create", accessToken, body));
            } catch (e) {
                return err(e);
            }
        },
    },

    {
        name: "updateEventType",
        title: "Update event type",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        description:
            "Update fields on an existing Lunacal event type. metadata, locations, and bookingFields " +
            "are replaced wholesale, not merged — partial updates require the full current value from " +
            "getEventTypeById. To toggle Stripe payments, set metadata.apps.stripe with enabled, price, " +
            "currency, and credentialId. The response reflects the state before the update.",
        inputSchema: z.object({
            id: z.coerce.number().int(),
            title: z.string().optional(),
            description: z.string().optional(),
            slug: z.string().optional(),
            length: z.coerce.number().int().optional().describe("Duration in minutes"),
            hidden: z.boolean().optional(),
            price: z.coerce.number().optional(),
            currency: z.string().optional(),
            minimumBookingNotice: z.coerce.number().int().optional(),
            beforeEventBuffer: z.coerce.number().int().optional(),
            afterEventBuffer: z.coerce.number().int().optional(),
            scheduleId: z.coerce.number().int().nullable().optional(),
            isPublished: z.boolean().optional(),
            hashedLink: z.string().optional(),
            seatsPerTimeSlot: z.coerce.number().int().nullable().optional().describe("Set null to disable seats"),
            seatsShowAttendees: z.boolean().nullable().optional(),
            disableGuests: z.boolean().optional(),
            requiresConfirmation: z.boolean().optional(),
            successRedirectUrl: z.string().optional(),
            minSlotsPerPackage: z.coerce.number().int().min(1).nullable().optional(),
            maxSlotsPerPackage: z.coerce.number().int().min(1).nullable().optional(),
            locations: z.array(z.record(z.string(), z.unknown())).optional().describe("Replaces all locations wholesale"),
            bookingFields: z
                .array(z.record(z.string(), z.unknown()))
                .optional()
                .describe("Replaces all custom booking fields wholesale"),
            metadata: z
                .record(z.string(), z.unknown())
                .optional()
                .describe("Replaces the whole metadata object — e.g. { apps: { stripe: { enabled, price, currency, credentialId } } }"),
        }).loose(),
        handler: async ({ id, ...body }, accessToken) => {
            try {
                return ok(await callLunacalMcpApi("/event-types/update", accessToken, { id, ...body }));
            } catch (e) {
                return err(e);
            }
        },
    },

    // {
    //     name: "deleteEventType",
    //     title: "Delete event type",
    //     description: "Delete a Lunacal event type by its numeric id.",
    //     inputSchema: z.object({
    //         id: z.coerce.number().int(),
    //     }),
    //     handler: async ({ id }, accessToken) => {
    //         try {
    //             return ok(await callLunacalMcpApi("/event-types/delete", accessToken, { id }));
    //         } catch (e) {
    //             return err(e);
    //         }
    //     },
    // },

    {
        name: "switchEventTypePublished",
        title: "Publish/unpublish event type",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        description: "Set whether a Lunacal event type is published (bookable) or unpublished.",
        inputSchema: z.object({
            eventId: z.coerce.number().int(),
            isPublished: z.boolean(),
            teamId: z.coerce.number().int().optional(),
        }),
        handler: async ({ eventId, isPublished, teamId }, accessToken) => {
            try {
                return ok(
                    await callLunacalMcpApi("/event-types/switch-published", accessToken, {
                        eventId,
                        isPublished,
                        teamId,
                    }),
                );
            } catch (e) {
                return err(e);
            }
        },
    },
];

export function registerLunacalTools(server: McpServer, oauthAccessToken?: string): void {
    for (const tool of lunacalTools) {
        server.registerTool(
            tool.name,
            { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
            (args) => {
                if (!oauthAccessToken) {
                    return Promise.resolve(err(new Error("Not authenticated — complete the OAuth login flow first")));
                }
                return tool.handler(args, oauthAccessToken);
            },
        );
    }
}
