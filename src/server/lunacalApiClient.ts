const DEFAULT_WEBAPP_URL = "https://app.lunacal.ai";

export class LunacalApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly body: unknown,
    ) {
        super(`Lunacal API error ${status}: ${JSON.stringify(body)}`);
    }
}

export function getWebappUrl(): string {
    return process.env.LUNACAL_WEBAPP_URL ?? DEFAULT_WEBAPP_URL;
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
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;

    if (!res.ok) {
        throw new LunacalApiError(res.status, data);
    }
    return data as T;
}
