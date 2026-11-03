import {Request, Response, NextFunction} from "express";
import {createHash} from "crypto";
import {ICacheProvider} from "../../pkg/cache/cache.interface";
import {container} from "../di/container";
import {TOKENS} from "../di/tokens";
import {toSeconds} from "../../pkg/utils/time";

const TTL = toSeconds(1, "d");

interface IdempotencyOptions {
    strict?: boolean;
}

interface IdempotencyRecord {
    bodyHash: string;
    status: number;
    response: unknown;
}

function hashBody(body: unknown): string {
    return createHash("sha256")
        .update(JSON.stringify(body ?? {}))
        .digest("hex");
}

/**
 * Redis-backed idempotency (Redis loss window is the same cost core-service
 * accepts; the DB fallback becomes the `idempotency_keys` table later).
 *
 * - Same key + same body within TTL → replays the original 2xx response.
 * - Same key + DIFFERENT body → 409 IdempotencyConflict.
 * - Only successful (2xx) responses are ever stored: a transient failure is
 *   never frozen for 24h, the client's retry re-executes the handler.
 */
export function idempotency(options: IdempotencyOptions = {}) {
    const {strict = false} = options;

    return async (req: Request, res: Response, next: NextFunction) => {
        if (!["POST", "PATCH", "PUT"].includes(req.method)) return next();

        const idempotencyKey = req.headers["idempotency-key"];

        if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
            if (strict) {
                return res.status(400).json({error: "Missing Idempotency-Key header"});
            }
            return next();
        }

        try {
            const cacheProvider = container.resolve<ICacheProvider>(TOKENS.CacheProvider);
            const key = `idempotency:${encodeURIComponent(req.originalUrl)}:${encodeURIComponent(idempotencyKey)}`;
            const bodyHash = hashBody(req.body);

            const cached = await cacheProvider.get(key);
            if (cached) {
                try {
                    const record = JSON.parse(cached) as IdempotencyRecord;
                    if (record.bodyHash !== bodyHash) {
                        return res.status(409).json({error: "IdempotencyConflict"});
                    }
                    if (record.status >= 200 && record.status < 300) {
                        return res.status(record.status).json(record.response);
                    }
                    // A legacy/garbled record or an anomalous stored status:
                    // fall through and execute.
                } catch {
                    // Corrupt record — execute the handler.
                }
            }

            const originalJson = res.json.bind(res);
            res.json = ((body: unknown) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    const record: IdempotencyRecord = {
                        bodyHash,
                        status: res.statusCode,
                        response: body,
                    };
                    cacheProvider.set(key, JSON.stringify(record), TTL).catch(() => {});
                }
                return originalJson(body);
            }) as Response["json"];

            next();
        } catch {
            if (strict) {
                return res.status(503).json({error: "Idempotency service unavailable"});
            }
            next();
        }
    };
}
