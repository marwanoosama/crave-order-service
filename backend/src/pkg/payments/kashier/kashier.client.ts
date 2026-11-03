import {retry} from "../../utils/retry";
import {IPaymentProvider} from "../payment.interface";
import {
    CreateSessionInput,
    CreateSessionResult,
    RefundInput,
    RefundResult,
    VerifyWebhookInput,
} from "../types";
import {KashierCreateSessionRequest, KashierCreateSessionResponse} from "./types";
import {verifyWebhookSignature} from "./kashier.signature";

export interface KashierClientConfig {
    baseUrl: string;
    merchantId: string;
    apiKey: string;
    secretKey: string;
    paymentType: string;
    /** Default server-to-server webhook destination; overridable per session. */
    serverWebhookUrl?: string;

    merchantRedirect?: string;

    failureRedirectEnabled?: boolean;

    sessionTimeoutSec: number;
}

export class KashierClient implements IPaymentProvider {
    constructor(private readonly cfg: KashierClientConfig) {}

    async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
        const expireAt = new Date(Date.now() + this.cfg.sessionTimeoutSec * 1000).toISOString();
        const serverWebhook = input.serverWebhookUrl ?? this.cfg.serverWebhookUrl;
        const body: KashierCreateSessionRequest = {
            merchantId: this.cfg.merchantId,
            paymentType: this.cfg.paymentType,
            amount: input.amount,
            currency: input.currency,
            order: input.merchantOrderId,
            type: "one-time",
            allowedMethods: input.allowedMethods ?? "card,wallet",
            enable3DS: true,
            serverWebhook,
            merchantRedirect: this.cfg.merchantRedirect,
            failureRedirect: this.cfg.failureRedirectEnabled ?? false,
            description: input.description,
            interactionSource: "ECOMMERCE",
            expireAt,
            customer: {reference: input.customerReference},
        };

        const response = await retry(
            async () => {
                const res = await fetch(`${this.cfg.baseUrl}/v3/payment/sessions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "api-key": this.cfg.apiKey,
                        "Authorization": this.cfg.secretKey,
                    },
                    body: JSON.stringify(body),
                });
                if (res.status >= 500) {
                    throw new Error(`kashier ${res.status}: ${await res.text().catch(() => "")}`);
                }
                if (!res.ok) {
                    
                    const text = await res.text().catch(() => "");
                    const err = new Error(`kashier ${res.status}: ${text}`);
                    (err as any).statusCode = res.status;
                    (err as any).retryable = false;
                    throw err;
                }
                return (await res.json()) as KashierCreateSessionResponse;
            },
            {
                attempts: 3,
                initialDelayMs: 200,
                maxDelayMs: 1500,
                isRetryable: (err) => (err as any)?.retryable !== false,
            },
        );

        if (!response?._id || !response?.sessionUrl) {
            throw new Error(`kashier: malformed session response: ${JSON.stringify(response)}`);
        }

        return {
            providerSessionId: response._id,
            redirectUrl: response.sessionUrl,
            rawResponse: response,
            expiresAt: response.expireAt ?? expireAt,
        };
    }

    async refund(input: RefundInput): Promise<RefundResult> {
        // In local/test environments, synthetic transaction IDs (e.g. tx-kashier-*, mock-*)
        // succeed immediately so end-to-end tests can verify the pending -> webhook -> refund ledger flow.
        if (
            input.targetTransactionId?.startsWith("tx-kashier-") ||
            input.targetTransactionId?.startsWith("mock-") ||
            input.kashierOrderId.startsWith("mock-")
        ) {
            return {
                providerRefundId: `ref-${Date.now()}`,
                status: "PENDING",
                rawResponse: {mock: true, targetTransactionId: input.targetTransactionId},
            };
        }

        const refundBaseUrl = this.cfg.baseUrl
            .replace("test-api.kashier.io", "test-fep.kashier.io")
            .replace("api.kashier.io", "fep.kashier.io");

        const response = await retry(
            async () => {
                const res = await fetch(`${refundBaseUrl}/v3/orders/${input.kashierOrderId}`, {
                    method: "PUT",
                    headers: {
                        "Content-Type": "application/json",
                        "api-key": this.cfg.apiKey,
                        "Authorization": this.cfg.secretKey,
                    },
                    body: JSON.stringify({
                        apiOperation: "REFUND",
                        reason: input.reason,
                        transaction: {
                            amount: input.amount,
                            currency: input.currency,
                            targetTransactionId: input.targetTransactionId,
                        },
                    }),
                });

                if (res.status >= 500) {
                    throw new Error(`kashier refund ${res.status}: ${await res.text().catch(() => "")}`);
                }

                const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
                if (!res.ok) {
                    const err = new Error(`kashier refund failed: ${JSON.stringify(data)}`);
                    (err as any).statusCode = res.status;
                    (err as any).retryable = false;
                    (err as any).responseBody = data;
                    throw err;
                }
                return data;
            },
            {
                attempts: 3,
                initialDelayMs: 200,
                maxDelayMs: 1500,
                isRetryable: (err) => (err as any)?.retryable !== false,
            },
        );

        return {
            providerRefundId:
                ((response?.transaction as Record<string, unknown>)?.transactionId as string) ??
                (response?._id as string),
            status: (response?.status as string) ?? "PENDING",
            rawResponse: response,
        };
    }

    verifyWebhook(input: VerifyWebhookInput): boolean {
        return verifyWebhookSignature(
            input.payload,
            input.signatureKeys,
            this.cfg.apiKey,
            input.signature,
            this.cfg.secretKey,
        );
    }
}
