import assert from "node:assert";
import jwt from "jsonwebtoken";
import {env} from "../src/lib/config/env";
import {computeWebhookSignature} from "../src/pkg/payments/kashier/kashier.signature";
import {db} from "../src/lib/knex/knex";

const BASE_URL = `http://localhost:${env.port}/api`;

function createToken(payload: {
    userId: number;
    role: string;
    email: string;
    restaurantId?: number;
    restaurantRole?: string;
    branchIds?: number[];
}): string {
    return jwt.sign(payload, env.jwt.accessSecret, {expiresIn: "1h"});
}

const customerToken = createToken({
    userId: 25,
    role: "customer",
    email: "marwanoss2004@gmail.com",
});

const strangerToken = createToken({
    userId: 99,
    role: "customer",
    email: "stranger@gmail.com",
});

const restaurantOwnerToken = createToken({
    userId: 21,
    role: "restaurant_user",
    email: "kfc_owner@gmail.com",
    restaurantId: 7,
    restaurantRole: "owner",
});

const adminToken = createToken({
    userId: 9,
    role: "system_admin",
    email: "admin01@gmail.com",
});

async function api(
    method: string,
    path: string,
    options: {
        body?: unknown;
        token?: string;
        region?: string;
        idempotencyKey?: string;
        headers?: Record<string, string>;
    } = {},
) {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...options.headers,
    };
    if (options.token) {
        headers["Authorization"] = `Bearer ${options.token}`;
    }
    if (options.region) {
        headers["X-Region"] = options.region;
    }
    if (options.idempotencyKey) {
        headers["Idempotency-Key"] = options.idempotencyKey;
    }

    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await res.text();
    let json: any;
    try {
        json = JSON.parse(text);
    } catch {
        json = text;
    }

    return {
        status: res.status,
        headers: res.headers,
        data: json,
    };
}

async function runTests() {
    console.log("=== STARTING PHASE 1 & PHASE 2 VERIFICATION SUITE ===\n");

    // ── 1. Health check ────────────────────────────────────────────────────────
    console.log("[1] Health check against all shards...");
    {
        const res = await api("GET", "/health");
        assert.strictEqual(res.status, 200, "Health should return 200");
        assert.strictEqual(res.data.ok, true, "Health ok should be true");
        assert.ok(res.data.shards.length >= 2, "Shards should be configured");
        console.log("  ✅ Health endpoint OK:", res.data);
    }

    // ── 2. Phase 1: Place COD order ────────────────────────────────────────────
    console.log("\n[2] Placing COD Order (Phase 1)...");
    const codIdempotencyKey = `idem-cod-${Date.now()}`;
    const codOrderBody = {
        branchId: 7,
        customerAddressId: 1,
        paymentMethod: "cod",
        items: [{productId: 1, quantity: 2}],
    };

    let codOrder: any;
    {
        const res = await api("POST", "/orders", {
            token: customerToken,
            region: "eg",
            idempotencyKey: codIdempotencyKey,
            body: codOrderBody,
        });
        assert.strictEqual(res.status, 201, `Place order failed: ${JSON.stringify(res.data)}`);
        assert.ok(res.data.data.publicId, "Should return order publicId");
        assert.strictEqual(res.data.data.status, "placed", "COD order should be placed immediately");
        assert.strictEqual(res.data.data.paymentMethod, "cod");
        assert.strictEqual(res.data.data.items.length, 1);
        assert.strictEqual(res.data.data.items[0].quantity, 2);
        codOrder = res.data.data;
        console.log(`  ✅ COD Order placed successfully: ${codOrder.publicId}, status: ${codOrder.status}`);
    }

    // ── 3. Idempotency verification ───────────────────────────────────────────
    console.log("\n[3] Testing Idempotency on order creation...");
    {
        // Same key + same body -> replays original response
        const resReplay = await api("POST", "/orders", {
            token: customerToken,
            region: "eg",
            idempotencyKey: codIdempotencyKey,
            body: codOrderBody,
        });
        assert.strictEqual(resReplay.status, 201, "Replay should return 201");
        assert.strictEqual(resReplay.data.data.publicId, codOrder.publicId, "Replay should return same order");
        console.log("  ✅ Idempotency replay with same body passed");

        // Same key + different body -> 409 IdempotencyConflict
        const resConflict = await api("POST", "/orders", {
            token: customerToken,
            region: "eg",
            idempotencyKey: codIdempotencyKey,
            body: {...codOrderBody, items: [{productId: 1, quantity: 5}]},
        });
        assert.strictEqual(resConflict.status, 409, "Different body should return 409");
        assert.strictEqual(resConflict.data.error, "IdempotencyConflict");
        console.log("  ✅ Idempotency conflict on altered body returned 409 Conflict");
    }

    // ── 4. Order Detail & Access Control ───────────────────────────────────────
    console.log("\n[4] Testing Order Details & Access Control...");
    {
        // Customer (owner of order) can view
        const resCust = await api("GET", `/orders/${codOrder.publicId}`, {
            token: customerToken,
            region: "eg",
        });
        assert.strictEqual(resCust.status, 200);
        assert.strictEqual(resCust.data.data.publicId, codOrder.publicId);
        assert.ok(Array.isArray(resCust.data.data.history), "Should contain history");
        assert.ok(resCust.data.data.paymentSummary, "Should contain paymentSummary");
        console.log("  ✅ Customer can read own order with history and paymentSummary");

        // Restaurant owner can view
        const resOwner = await api("GET", `/orders/${codOrder.publicId}`, {
            token: restaurantOwnerToken,
            region: "eg",
        });
        assert.strictEqual(resOwner.status, 200);
        console.log("  ✅ Restaurant owner can read branch order");

        // Stranger customer cannot view
        const resStranger = await api("GET", `/orders/${codOrder.publicId}`, {
            token: strangerToken,
            region: "eg",
        });
        assert.strictEqual(resStranger.status, 403, "Stranger should be rejected with 403");
        console.log("  ✅ Stranger customer denied access (403)");
    }

    // ── 5. List Orders (Customer & Restaurant) ─────────────────────────────────
    console.log("\n[5] Testing List Orders (Customer & Restaurant)...");
    {
        // Customer list orders
        const resCustList = await api("GET", "/customer/orders", {
            token: customerToken,
            region: "eg",
        });
        assert.strictEqual(resCustList.status, 200);
        assert.ok(Array.isArray(resCustList.data.data), "Should return array of orders");
        assert.ok(resCustList.data.meta, "Should include pagination meta");
        console.log(`  ✅ Customer list orders returned ${resCustList.data.data.length} orders`);

        // Restaurant list orders
        const resRestList = await api("GET", "/restaurants/7/branches/7/orders", {
            token: restaurantOwnerToken,
            region: "eg",
        });
        assert.strictEqual(resRestList.status, 200);
        assert.ok(Array.isArray(resRestList.data.data));
        console.log(`  ✅ Restaurant branch orders returned ${resRestList.data.data.length} orders`);
    }

    // ── 6. Status Transitions ──────────────────────────────────────────────────
    console.log("\n[6] Testing Order Status Transitions...");
    {
        // Restaurant accepts order
        const resAccept = await api(
            "PATCH",
            `/restaurants/7/branches/7/orders/${codOrder.publicId}/status`,
            {
                token: restaurantOwnerToken,
                region: "eg",
                idempotencyKey: `idem-status-acc-${Date.now()}`,
                body: {status: "accepted"},
            },
        );
        assert.strictEqual(resAccept.status, 200);
        assert.strictEqual(resAccept.data.data.status, "accepted");
        console.log("  ✅ Status transition: placed -> accepted succeeded");

        // Restaurant preparing
        const resPrep = await api(
            "PATCH",
            `/restaurants/7/branches/7/orders/${codOrder.publicId}/status`,
            {
                token: restaurantOwnerToken,
                region: "eg",
                idempotencyKey: `idem-status-prep-${Date.now()}`,
                body: {status: "preparing"},
            },
        );
        assert.strictEqual(resPrep.status, 200);
        assert.strictEqual(resPrep.data.data.status, "preparing");
        console.log("  ✅ Status transition: accepted -> preparing succeeded");

        // Restaurant ready
        const resReady = await api(
            "PATCH",
            `/restaurants/7/branches/7/orders/${codOrder.publicId}/status`,
            {
                token: restaurantOwnerToken,
                region: "eg",
                idempotencyKey: `idem-status-ready-${Date.now()}`,
                body: {status: "ready"},
            },
        );
        assert.strictEqual(resReady.status, 200);
        assert.strictEqual(resReady.data.data.status, "ready");
        console.log("  ✅ Status transition: preparing -> ready succeeded");

        // Illegal transition: ready -> rejected should fail with 409
        const resIllegal = await api(
            "PATCH",
            `/restaurants/7/branches/7/orders/${codOrder.publicId}/status`,
            {
                token: restaurantOwnerToken,
                region: "eg",
                idempotencyKey: `idem-status-bad-${Date.now()}`,
                body: {status: "rejected", reason: "Cannot reject now"},
            },
        );
        assert.strictEqual(resIllegal.status, 409, "Illegal transition should fail with 409");
        console.log("  ✅ Illegal status transition (ready -> rejected) rejected with 409");
    }

    // ── 7. Phase 2: Place Online Order & Kashier Session ───────────────────────
    console.log("\n[7] Placing Online Order (Phase 2)...");
    const onlineIdempotencyKey = `idem-online-${Date.now()}`;
    const onlineOrderBody = {
        branchId: 7,
        customerAddressId: 1,
        paymentMethod: "online",
        items: [{productId: 1, quantity: 1}],
    };

    let onlineOrder: any;
    {
        const res = await api("POST", "/orders", {
            token: customerToken,
            region: "eg",
            idempotencyKey: onlineIdempotencyKey,
            body: onlineOrderBody,
        });
        assert.strictEqual(res.status, 201, `Place online order failed: ${JSON.stringify(res.data)}`);
        assert.strictEqual(res.data.data.status, "pending_payment");
        assert.strictEqual(res.data.data.paymentMethod, "online");
        assert.ok(res.data.data.payment, "Online order must include payment session info");
        assert.ok(res.data.data.payment.redirectUrl, "Must include Kashier redirectUrl");
        onlineOrder = res.data.data;
        console.log(`  ✅ Online Order created: ${onlineOrder.publicId}, status: ${onlineOrder.status}`);
        console.log(`  ✅ Kashier Session URL: ${onlineOrder.payment.redirectUrl}`);
    }

    // ── 8. POST /api/payments/init ─────────────────────────────────────────────
    console.log("\n[8] Testing POST /api/payments/init (re-requesting session)...");
    {
        const resInit = await api("POST", "/payments/init", {
            token: customerToken,
            region: "eg",
            idempotencyKey: `idem-init-${Date.now()}`,
            body: {orderId: onlineOrder.publicId},
        });
        assert.strictEqual(resInit.status, 200);
        assert.strictEqual(resInit.data.data.sessionId, onlineOrder.payment.sessionId);
        assert.strictEqual(resInit.data.data.redirectUrl, onlineOrder.payment.redirectUrl);
        console.log("  ✅ POST /payments/init returned active checkout session");
    }

    // ── 9. Kashier Webhook: Successful Payment ────────────────────────────────
    console.log("\n[9] Simulating Kashier Payment Webhook (SUCCESS)...");
    const transactionId = `tx-kashier-${Date.now()}`;
    const webhookData = {
        merchantOrderId: onlineOrder.publicId,
        kashierOrderId: `kashier-ord-${Date.now()}`,
        transactionId,
        status: "SUCCESS",
        amount: 160.0,
        currency: "EGP",
        signatureKeys: ["merchantOrderId", "transactionId", "status", "amount", "currency"],
    };

    const signature = computeWebhookSignature(webhookData, webhookData.signatureKeys, env.kashier.apiKey);

    {
        // 9a. Bad signature test
        const resBadSig = await api("POST", "/payments/webhook/kashier?region=eg", {
            body: {event: "pay", data: webhookData},
            headers: {"x-kashier-signature": "invalid-signature-hash"},
        });
        assert.strictEqual(resBadSig.status, 401, "Bad signature should return 401");
        console.log("  ✅ Invalid webhook signature rejected with 401");

        // 9b. Valid webhook
        const resOk = await api("POST", "/payments/webhook/kashier?region=eg", {
            body: {event: "pay", data: webhookData},
            headers: {"x-kashier-signature": signature},
        });
        assert.strictEqual(resOk.status, 200, "Valid webhook should return 200");
        console.log("  ✅ Valid Kashier webhook processed with 200");

        // Verify order transitioned to 'placed'
        const resOrderAfter = await api("GET", `/orders/${onlineOrder.publicId}`, {
            token: customerToken,
            region: "eg",
        });
        assert.strictEqual(resOrderAfter.data.data.status, "placed", "Order should transition to placed");
        assert.strictEqual(resOrderAfter.data.data.paymentSummary?.status, "captured");
        console.log("  ✅ Order transitioned to 'placed' with paymentSummary.status = 'captured'");

        // 9c. Duplicate webhook test (idempotency dedupe)
        const resDup = await api("POST", "/payments/webhook/kashier?region=eg", {
            body: {event: "pay", data: webhookData},
            headers: {"x-kashier-signature": signature},
        });
        assert.strictEqual(resDup.status, 200, "Duplicate webhook should return 200");
        console.log("  ✅ Duplicate webhook acknowledged with 200 without side effects");
    }

    // ── 10. GET /api/payments/:paymentId ──────────────────────────────────────
    console.log("\n[10] Testing GET /api/payments/:paymentId...");
    let chargePaymentId: number;
    {
        // Find the transaction id in the DB
        const conn = db("eg");
        const tx = await conn("transactions")
            .where({provider_reference_id: transactionId})
            .first();
        assert.ok(tx, "Transaction must exist in DB");
        chargePaymentId = Number(tx.id);

        const resTx = await api("GET", `/payments/${chargePaymentId}`, {
            token: adminToken,
            region: "eg",
        });
        assert.strictEqual(resTx.status, 200);
        assert.strictEqual(resTx.data.data.id, chargePaymentId);
        assert.strictEqual(resTx.data.data.status, "succeeded");
        assert.strictEqual(resTx.data.data.type, "charge");
        console.log(`  ✅ Payment read OK: id=${chargePaymentId}, status=${resTx.data.data.status}`);
    }

    // ── 11. POST /api/payments/:paymentId/refund & Webhook ────────────────────
    console.log("\n[11] Testing Refund Flow...");
    let refundId: number;
    {
        // 11a. Admin initiates refund
        const refundKey = `idem-refund-${Date.now()}`;
        const resRefund = await api("POST", `/payments/${chargePaymentId}/refund`, {
            token: adminToken,
            region: "eg",
            idempotencyKey: refundKey,
            body: {reason: "Customer request"},
        });
        assert.strictEqual(resRefund.status, 202, `Refund request should return 202: ${JSON.stringify(resRefund.data)}`);
        assert.strictEqual(resRefund.data.data.status, "pending");
        refundId = resRefund.data.data.refundId;
        console.log(`  ✅ Refund initiated: refundId=${refundId}, status=pending`);

        // 11b. Simulated Kashier refund webhook
        const refundTxId = `tx-refund-${Date.now()}`;
        const refundWebhookData = {
            merchantOrderId: onlineOrder.publicId,
            kashierOrderId: `kashier-ord-${Date.now()}`,
            transactionId: refundTxId,
            status: "SUCCESS",
            amount: 160.0,
            currency: "EGP",
            signatureKeys: ["merchantOrderId", "transactionId", "status", "amount", "currency"],
        };
        const refundSig = computeWebhookSignature(
            refundWebhookData,
            refundWebhookData.signatureKeys,
            env.kashier.apiKey,
        );

        const resRefundHook = await api("POST", "/payments/webhook/kashier?region=eg", {
            body: {event: "refund", data: refundWebhookData},
            headers: {"x-kashier-signature": refundSig},
        });
        assert.strictEqual(resRefundHook.status, 200);
        console.log("  ✅ Refund webhook processed successfully");

        // 11c. Verify charge marked as refunded and refund transaction succeeded
        const resChargeAfter = await api("GET", `/payments/${chargePaymentId}`, {
            token: adminToken,
            region: "eg",
        });
        assert.strictEqual(resChargeAfter.data.data.isRefunded, true, "Charge must be marked isRefunded = true");
        assert.strictEqual(resChargeAfter.data.data.refundedPaymentId, refundId);
        console.log("  ✅ Original charge marked isRefunded = true with refundedPaymentId");

        // 11d. Verify order detail shows refunded status
        const resOrderRefunded = await api("GET", `/orders/${onlineOrder.publicId}`, {
            token: customerToken,
            region: "eg",
        });
        assert.strictEqual(resOrderRefunded.data.data.paymentSummary?.status, "refunded");
        console.log("  ✅ Order detail shows paymentSummary.status = 'refunded'");
    }

    console.log("\n=======================================================");
    console.log("🎉 ALL TESTS PASSED SUCCESSFULLY! BOTH MODULES ARE HEALTHY!");
    console.log("=======================================================\n");
    process.exit(0);
}

runTests().catch((err) => {
    console.error("\n❌ TEST SUITE FAILED:", err);
    process.exit(1);
});
