type Fields = Record<string, unknown>;

const SENSITIVE_KEY = /token|secret|code|authorization|password|verifier|challenge|cookie/i;
const LONG_SECRET = /[A-Za-z0-9_-]{24,}/g;

function sanitize(value: unknown): unknown {
    if (typeof value === "string") {
        return value.replace(LONG_SECRET, "[redacted]");
    }
    if (Array.isArray(value)) {
        return value.map(sanitize);
    }
    if (value && typeof value === "object") {
        const out: Fields = {};
        for (const [key, inner] of Object.entries(value)) {
            if (SENSITIVE_KEY.test(key)) continue;
            out[key] = sanitize(inner);
        }
        return out;
    }
    return value;
}

function write(level: "info" | "warn" | "error", msg: string, fields?: Fields): void {
    const line = JSON.stringify({
        time: new Date().toISOString(),
        level,
        msg,
        ...(fields ? (sanitize(fields) as Fields) : {}),
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
}

export const log = {
    info(msg: string, fields?: Fields): void {
        write("info", msg, fields);
    },
    warn(msg: string, fields?: Fields): void {
        write("warn", msg, fields);
    },
    error(msg: string, fields?: Fields): void {
        write("error", msg, fields);
    },
};
