import type {Request, Response, NextFunction} from "express";
import {isRegion, normalizeRegion} from "./regions";
import {RegionNotResolvedError} from "./errors";


export function resolveRegion(req: Request, _res: Response, next: NextFunction) {
    const headerRaw = req.headers["x-region"];
    const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    const queryValue = typeof req.query.region === "string" ? req.query.region : undefined;
    // Documented precedence: ?region= beat X-Region — the order here matters
    // because providers (e.g. Kashier webhooks) can only carry region in the
    // query string.
    const norm = normalizeRegion(queryValue ?? headerValue);
    if (norm === "all") {
        req.region = "all";
    } else if (norm && isRegion(norm)) {
        req.region = norm;
    }
    next();
}

export function requireRegion(req: Request, _res: Response, next: NextFunction) {
    if (!req.region) throw RegionNotResolvedError;
    next();
}


export function requireConcreteRegion(req: Request, _res: Response, next: NextFunction) {
    if (!req.region || req.region === "all") throw RegionNotResolvedError;
    next();
}
