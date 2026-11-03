import {NextFunction, Request, Response} from "express";
import {verifyAccessToken} from "./jwt";
import {NotAuthenticated} from "./errors";

export function authenticate(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const token = req.cookies?.access_token || bearerToken;
    if (!token) throw NotAuthenticated;

    req.user = verifyAccessToken(token);
    next();
}
