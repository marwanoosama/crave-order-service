import {
    CreateSessionInput,
    CreateSessionResult,
    RefundInput,
    RefundResult,
    VerifyWebhookInput,
} from "./types";


export interface IPaymentProvider {
    createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
    verifyWebhook(input: VerifyWebhookInput): boolean;
    refund(input: RefundInput): Promise<RefundResult>;
}
