import { z } from "zod";
import type { ToolDef } from "./_types.js";
import { READ_ONLY } from "./_types.js";
import { callLunacalApi } from "../utils/api-client.js";
import { withLunacal, textResult } from "./_helpers.js";

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

export const tools: ToolDef[] = [
    {
        name: "list_event_types",
        title: "List event types",
        description:
            "List the user's event types (personal and team). Use an id from this list with find_available_slots " +
            "and create_booking. scheduleId is informational; weekly hours cannot be edited with this server. Read-only.",
        annotations: READ_ONLY,
        inputSchema: z.object({
            teamIds: z.array(z.coerce.number().int()).optional(),
            slug: z.string().optional().describe("Keep only event types with this slug"),
        }),
        handler: async (args, ctx) => {
            const teamIds = args.teamIds as number[] | undefined;
            const slug = args.slug as string | undefined;
            const payload = await withLunacal(ctx, true, (token) =>
                callLunacalApi("/event-types/list", token, teamIds ? { filters: { teamIds } } : {}),
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
            "Required booking questions must be answered in create_booking additionalResponses, keyed by field name. Read-only.",
        annotations: READ_ONLY,
        inputSchema: z.object({ id: z.coerce.number().int() }),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, true, (token) =>
                callLunacalApi("/event-types/get", token, { id: args.id }),
            );
            return textResult(slimEventType(payload));
        },
    },
    {
        name: "create_event_type",
        title: "Create event type",
        description:
            "Add an event type on the signed-in account. length is the duration in minutes. " +
            "This does not delete or replace an existing event type and does not email anyone. " +
            "Use set_event_type_published to show or hide it on the public booking page.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
            const payload = await withLunacal(ctx, false, (token) => callLunacalApi("/event-types/create", token, args));
            return textResult(slimEventType(payload));
        },
    },
    {
        name: "update_event_type",
        title: "Update event type",
        description:
            "Update an event type on the signed-in account. metadata, locations, and bookingFields replace " +
            "the whole stored value, so read get_event_type first when changing only part of them. " +
            "That replacement is an overwrite. Confirm with the user before calling. This does not email anyone.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
            const payload = await withLunacal(ctx, false, (token) => callLunacalApi("/event-types/update", token, args));
            return textResult(slimEventType(payload));
        },
    },
    {
        name: "set_event_type_published",
        title: "Publish or unpublish event type",
        description:
            "Show or hide an event type on the public booking page. Hiding it revokes public booking access. " +
            "Confirm with the user before hiding. Setting the same value again does not change anything further.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        inputSchema: z.object({
            eventId: z.coerce.number().int(),
            isPublished: z.boolean(),
            teamId: z.coerce.number().int().optional(),
        }),
        handler: async (args, ctx) => {
            const payload = await withLunacal(ctx, false, (token) =>
                callLunacalApi("/event-types/switch-published", token, args),
            );
            return textResult(payload);
        },
    },
];
