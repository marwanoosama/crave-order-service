

export interface CreateSessionInput {

    merchantOrderId: string;

    amount: string;

    currency: string;

    description?: string;

    allowedMethods?: string;

    // Per-request webhook destination — wins over the client-level default
    // (Kashier "serverWebhook"). Empty/undefined omits the field entirely.
    serverWebhookUrl?: string;

    customerReference: string;
}

export interface CreateSessionResult {
    
    providerSessionId: string;
    
    redirectUrl: string;
    
    rawResponse: unknown;
    
    expiresAt?: string;
}

export interface VerifyWebhookInput {
    
    payload: Record<string, unknown>;
    
    signatureKeys: string[];
    
    signature: string;
}

export interface RefundInput {
    kashierOrderId: string;
    targetTransactionId?: string;
    amount: string;
    currency: string;
    reason: string;
}

export interface RefundResult {
    providerRefundId?: string;
    status: string;
    rawResponse: unknown;
}
