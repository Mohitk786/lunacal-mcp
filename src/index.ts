#!/usr/bin/env node
import { migrate } from "./storage/db.js";
import { startHttpServer } from "./http-server.js";
import { log } from "./utils/logger.js";

migrate()
    .then(() => startHttpServer())
    .catch((err: unknown) => {
        log.error("startup failed", { message: err instanceof Error ? err.message : "unknown" });
        process.exit(1);
    });
