import {AppError} from "../error/AppError";
import type {IncomingMessage} from "http";
import {verifyAccessToken, JWTPayload} from "../auth/jwt";

export const WsNoTokenError = new AppError("No token provided", 401);

/* extract access token to attach to socket.io connection */
export function authenticateHandshake(handshake: {
    auth?: {token?: string};
    headers: IncomingMessage["headers"];
}): JWTPayload {
    const token =
        handshake.auth?.token ??
        extractCookie(handshake.headers.cookie, "access_token");

    if (!token) throw WsNoTokenError;
    return verifyAccessToken(token);
}

/* channels (socket.io rooms) the user is allowed to join */
export function permittedChannels(user: JWTPayload): Set<string> {
    const allowed = new Set<string>([`customer:${user.userId}`]);
    if (user.role === "system_admin") allowed.add("admin:alerts");
    if (user.role === "restaurant_user" && user.restaurantId) {
        allowed.add(`restaurant:${user.restaurantId}`);
        for (const b of user.branchIds ?? []) allowed.add(`branch:${b}`);
    }
    if (user.role === "delivery_agent") {
        allowed.add(`agent:${user.userId}`);
    }
    return allowed;
}

function extractCookie(cookieHeader: string | undefined, name: string): string | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return null;
}
