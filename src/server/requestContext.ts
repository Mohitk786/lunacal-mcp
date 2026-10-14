import { AsyncLocalStorage } from "node:async_hooks";

export type RequestStore = {
    forceUnauthorized: boolean;
};

export const requestStore = new AsyncLocalStorage<RequestStore>();
