import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function randomToken(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

/** S256 PKCE: base64url(sha256(verifier)) compared in constant time. */
export function verifyPkce(verifier: string, challenge: string): boolean {
    const computed = createHash("sha256").update(verifier).digest("base64url");
    const a = Buffer.from(computed);
    const b = Buffer.from(challenge);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/** AES-256-GCM. Payload is base64(iv || tag || ciphertext). */
export function encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decrypt(encoded: string): string {
    const data = Buffer.from(encoded, "base64");
    if (data.length < IV_LENGTH + TAG_LENGTH + 1) {
        throw new Error("Ciphertext is too short");
    }
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", config.encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
