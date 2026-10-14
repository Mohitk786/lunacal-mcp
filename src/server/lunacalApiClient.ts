import { config } from "./config.js";

export class LunacalApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly body: unknown,
    ) {
        super(`Lunacal API error ${status}`);
        this.name = "LunacalApiError";
    }
}

export function getWebappUrl(): string {
    return config.lunacalWebappUrl;
}

export async function callLunacalMcpApi<T = unknown>(
    path: string,
    accessToken: string,
    body?: unknown,
): Promise<T> {
    const url = `${getWebappUrl()}/api/mcp${path}`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(20_000),
    });

    const text = await res.text();
    let data: unknown;
    if (text) {
        try {
            data = JSON.parse(text) as unknown;
        } catch {
            data = { message: "Lunacal returned a non-JSON response" };
        }
    }

    if (!res.ok) {
        throw new LunacalApiError(res.status, data);
    }
    return data as T;
}
