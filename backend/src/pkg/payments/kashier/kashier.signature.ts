import {createHmac, timingSafeEqual} from "crypto";


export function buildSignaturePayload(data: Record<string, unknown>, signatureKeys: string[]): string {
    return [...signatureKeys]
        .sort()
        .map((k) => {
            const v = data[k];
            const stringified = v === undefined || v === null ? "" : String(v);
            return `${k}=${encodeURIComponent(stringified)}`;
        })
        .join("&");
}

export function computeWebhookSignature(data: Record<string, unknown>, signatureKeys: string[], apiKey: string): string {
    const payload = buildSignaturePayload(data, signatureKeys);
    return createHmac("sha256", apiKey).update(payload, "utf8").digest("hex");
}

export function verifyWebhookSignature(
    data: Record<string, unknown>,
    signatureKeys: string[],
    apiKey: string,
    providedSignature: string,
    fallbackKey?: string,
): boolean {
    if (!providedSignature || typeof providedSignature !== "string") return false;
    const verifyWithKey = (key: string): boolean => {
        const expected = computeWebhookSignature(data, signatureKeys, key);
        if (expected.length !== providedSignature.length) return false;
        try {
            return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(providedSignature, "hex"));
        } catch {
            return false;
        }
    };

    if (verifyWithKey(apiKey)) return true;
    if (fallbackKey && verifyWithKey(fallbackKey)) return true;
    return false;
}
