import {coreClient} from "./core-client";
import {CoreEnvelope, CoreCustomerAddress} from "./types";

export async function getCustomerAddress(addressId: number, correlationId?: string): Promise<CoreCustomerAddress> {
    const res = await coreClient.request<CoreEnvelope<CoreCustomerAddress>>({
        method: "GET",
        path: `/api/customer/addresses/internal/${addressId}`,
        correlationId,
    });
    return res.data;
}


export function flattenAddress(a: CoreCustomerAddress): string {
    const parts = [a.building, a.street, a.city, a.country].filter(Boolean);
    return parts.join(", ");
}