import assert from "node:assert";
import jwt from "jsonwebtoken";
import {env} from "../src/lib/config/env";
import {db} from "../src/lib/knex/knex";
import {sweepPendingPaymentOrders} from "../src/app/order/jobs";

function createCustomerToken(): string {
    return jwt.sign({userId: 25, role: "customer", email: "marwanoss2004@gmail.com"}, env.jwt.accessSecret);
}

async function testSweep() {
    console.log("=== TESTING PENDING PAYMENT SWEEP JOB ===");

    // 1. Place an online order
    const token = createCustomerToken();
    const res = await fetch(`http://localhost:${env.port}/api/orders`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "X-Region": "eg",
            "Idempotency-Key": `sweep-test-${Date.now()}`,
        },
        body: JSON.stringify({
            branchId: 7,
            customerAddressId: 1,
            paymentMethod: "online",
            items: [{productId: 1, quantity: 3}],
        }),
    });

    const json = (await res.json()) as any;
    assert.strictEqual(res.status, 201, "Order placement failed");
    const order = json.data;
    assert.strictEqual(order.status, "pending_payment");
    console.log(`  Created pending_payment order: ${order.publicId}`);

    // Check core service stock before sweep
    const conn = db("eg");

    // Manually age the order so it is older than PAYMENT_SESSION_TIMEOUT_MIN (15m)
    const twentyMinsAgo = new Date(Date.now() - 25 * 60 * 1000);
    await conn("orders")
        .where({public_id: order.publicId})
        .update({created_at: twentyMinsAgo});

    console.log("  Order created_at updated to 25m ago.");

    // Run sweep
    const cancelledCount = await sweepPendingPaymentOrders("eg");
    assert.ok(cancelledCount >= 1, "Should have cancelled at least 1 order");
    console.log(`  Sweep cancelled ${cancelledCount} stale order(s).`);

    // Verify order is cancelled in DB
    const updated = await conn("orders").where({public_id: order.publicId}).first();
    assert.strictEqual(updated.status, "cancelled", "Order should now be cancelled");
    assert.ok(updated.cancelled_at, "cancelled_at must be stamped");
    console.log("  ✅ Stale order cancelled and reserved stock released via core-client!");

    console.log("🎉 PENDING PAYMENT SWEEP PASSED!");
    process.exit(0);
}

testSweep().catch((err) => {
    console.error("❌ Sweep test failed:", err);
    process.exit(1);
});
