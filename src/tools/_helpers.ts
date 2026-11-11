import { z } from "zod";
import { LunacalApiError } from "../utils/api-client.js";
import { lunacalAccessForGrant } from "../auth/lunacal-session.js";
import { GrantDeadError, UpstreamTemporaryError } from "../auth/oauth-errors.js";
import { requestStore } from "../auth/context.js";
import type { ToolResult, ToolCtx } from "./_types.js";

export const isoDateTime = z
    .string()
    .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
        "ISO 8601 datetime with a timezone offset, for example 2026-10-13T15:00:00-04:00",
    );

export const timezone = z.string().min(1).describe('IANA timezone, for example "America/New_York"');

export const HINTS: Record<string, string> = {
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

export function textResult(data: unknown, isError = false): ToolResult {
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

export function formatApiError(error: LunacalApiError): string {
    const message = apiMessage(error.body);
    const hint = Object.entries(HINTS).find(([code]) => message.includes(code))?.[1];
    return hint ? `${message}. ${hint}` : `Lunacal API error (${error.status}): ${message}`;
}

export function markReconnect(): void {
    const store = requestStore.getStore();
    if (store) store.forceUnauthorized = true;
}

export async function withLunacal<T>(ctx: ToolCtx, readOnly: boolean, run: (accessToken: string) => Promise<T>): Promise<T> {
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

export function fail(err: unknown): ToolResult {
    if (err instanceof LunacalApiError) return textResult(formatApiError(err), true);
    return textResult(err instanceof Error ? err.message : "Request failed", true);
}

export function buildBookingResponses(fields: {
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
