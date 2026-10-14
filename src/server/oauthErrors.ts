export class OAuthError extends Error {
    readonly commit: boolean;

    constructor(
        readonly oauthError: string,
        readonly description: string,
        readonly status: number,
        commit = false,
    ) {
        super(description);
        this.name = "OAuthError";
        this.commit = commit;
    }
}

/** Lunacal said this refresh token is invalid, expired, or already used. */
export class GrantDeadError extends Error {
    readonly commit = true;

    constructor() {
        super("Lunacal refresh token is no longer valid");
        this.name = "GrantDeadError";
    }
}

/** Network, 5xx, bad client secret, rate limit, or any other non-terminal failure. */
export class UpstreamTemporaryError extends Error {
    constructor(message = "Lunacal is temporarily unavailable") {
        super(message);
        this.name = "UpstreamTemporaryError";
    }
}
