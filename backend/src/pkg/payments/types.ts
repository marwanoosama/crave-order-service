

export interface CreateSessionInput {
    
    merchantOrderId: string;
    
    amount: string;
    
    currency: string;
    
    description?: string;
    
    allowedMethods?: string;
    
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
