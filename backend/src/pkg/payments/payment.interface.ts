import {
    CreateSessionInput,
    CreateSessionResult,
    VerifyWebhookInput,
} from "./types";


export interface IPaymentProvider {
    createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
    verifyWebhook(input: VerifyWebhookInput): boolean;
}
