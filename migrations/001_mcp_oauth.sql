-- OAuth broker state for the Lunacal MCP server.
-- Applied by the startup migration runner. Idempotent.

CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
    client_id TEXT PRIMARY KEY,
    redirect_uris TEXT[] NOT NULL CHECK (cardinality(redirect_uris) > 0),
    client_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_pending_authorizations (
    state_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES mcp_oauth_clients (client_id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    client_state TEXT,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_pending_authorizations_expires_at_idx
    ON mcp_pending_authorizations (expires_at);

-- Holds encrypted Lunacal tokens until the MCP client exchanges the code.
-- The code itself is stored only as a sha256 hash.
CREATE TABLE IF NOT EXISTS mcp_auth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES mcp_oauth_clients (client_id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    lunacal_access_token_enc TEXT NOT NULL,
    lunacal_refresh_token_enc TEXT NOT NULL,
    lunacal_expires_at TIMESTAMPTZ NOT NULL,
    lunacal_refresh_expires_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_auth_codes_expires_at_idx
    ON mcp_auth_codes (expires_at);

-- One grant per completed login. Lunacal tokens are AES-256-GCM ciphertext.
CREATE TABLE IF NOT EXISTS mcp_grants (
    id UUID PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES mcp_oauth_clients (client_id) ON DELETE CASCADE,
    lunacal_access_token_enc TEXT NOT NULL,
    lunacal_refresh_token_enc TEXT NOT NULL,
    lunacal_expires_at TIMESTAMPTZ NOT NULL,
    lunacal_refresh_expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_grants_client_id_idx
    ON mcp_grants (client_id);

-- Our access and refresh tokens are sha256 hashes. Plaintext is never stored.
-- successor_* holds a short-lived encrypted copy of the rotated pair so a
-- client that missed the refresh response can retry within the grace window
-- and receive the same tokens. Cleanup nulls those columns after the window.
CREATE TABLE IF NOT EXISTS mcp_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id UUID NOT NULL REFERENCES mcp_grants (id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('access', 'refresh')),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    successor_access_enc TEXT,
    successor_refresh_enc TEXT,
    successor_access_expires_at TIMESTAMPTZ,
    successor_refresh_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_tokens_grant_id_idx
    ON mcp_tokens (grant_id);

CREATE INDEX IF NOT EXISTS mcp_tokens_expires_at_idx
    ON mcp_tokens (expires_at);
