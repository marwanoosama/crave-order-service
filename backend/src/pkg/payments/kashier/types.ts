

export interface KashierCreateSessionRequest {
    merchantId: string;
    paymentType: string;          
    amount: string;               
    currency: string;             
    order: string;                
    type: "one-time";
    allowedMethods: string;
    enable3DS: boolean;
    serverWebhook?: string;
    merchantRedirect?: string;
    failureRedirect?: boolean;
    description?: string;
    interactionSource?: "ECOMMERCE";
    expireAt?: string;
    customer: {reference: string; email?: string};
}

export interface KashierCreateSessionResponse {
    _id: string;
    status: string;
    sessionUrl: string;
    expireAt?: string;
    paymentParams?: {
        order?: string;
        amount?: string;
        currency?: string;
        hash?: string;
        [k: string]: unknown;
    };
    [k: string]: unknown;
}


export interface KashierWebhookEnvelope {
    event: "pay" | "refund" | "authorize" | "void" | "capture";
    data: KashierWebhookData;
}

export interface KashierWebhookData {
    merchantOrderId: string;
    kashierOrderId: string;
    orderReference?: string;
    transactionId: string;
    status: "SUCCESS" | "FAILED" | "PENDING";
    method?: string;
    amount: number;
    currency: string;
    
    signatureKeys: string[];
    [k: string]: unknown;
}
