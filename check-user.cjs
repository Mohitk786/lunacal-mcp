const { createDecipheriv } = require("node:crypto");
const pg = require("pg");

const lunacalDbUrl = process.argv[2];
const mcpDbUrl = process.argv[3];
const encKeyB64 = process.argv[4];

if (!lunacalDbUrl || !mcpDbUrl || !encKeyB64) {
    console.error("Usage: node check-user.cjs <lunacal_db_url> <mcp_db_url> <enc_key_b64>");
    process.exit(1);
}

const encKey = Buffer.from(encKeyB64, "base64");

function decrypt(encoded) {
    const data = Buffer.from(encoded, "base64");
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

async function main() {
    const lunacalPool = new pg.Pool({ connectionString: lunacalDbUrl, ssl: { rejectUnauthorized: false } });
    const mcpPool = new pg.Pool({ connectionString: mcpDbUrl, ssl: { rejectUnauthorized: false } });

    try {
        const userTokens = await lunacalPool.query(
            'SELECT at.secret, at."userId", at."expiresAt", u.email FROM "AccessToken" at JOIN "users" u ON u.id = at."userId" WHERE u.email = $1',
            ["b.daley@icandywebs.com"]
        );

        console.log("=== Lunacal AccessTokens for b.daley@icandywebs.com ===");
        if (userTokens.rows.length === 0) {
            console.log("No access tokens found for this user.");
        } else {
            for (const row of userTokens.rows) {
                console.log("  Token:", row.secret.slice(0, 20) + "...", " Expires:", row.expiresAt);
            }
        }

        const grants = await mcpPool.query(
            "SELECT id, client_id, lunacal_access_token_enc, lunacal_refresh_token_enc, revoked_at, created_at FROM mcp_grants"
        );

        const lunacalSecrets = new Set(userTokens.rows.map(r => r.secret));

        console.log("\n=== Checking MCP grants ===");
        let found = false;
        for (const grant of grants.rows) {
            try {
                const at = decrypt(grant.lunacal_access_token_enc);
                const rt = decrypt(grant.lunacal_refresh_token_enc);
                if (lunacalSecrets.has(at) || lunacalSecrets.has(rt)) {
                    found = true;
                    console.log("MATCH!");
                    console.log("  Grant ID:  ", grant.id);
                    console.log("  Client ID: ", grant.client_id);
                    console.log("  Created:   ", grant.created_at);
                    console.log("  Revoked:   ", grant.revoked_at ?? "no");
                }
            } catch {}
        }

        if (!found) {
            console.log("NO MATCH — user never completed MCP OAuth into this DB.");
        }
    } finally {
        await lunacalPool.end();
        await mcpPool.end();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
