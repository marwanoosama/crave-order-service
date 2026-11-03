/**
 * Locally completes a Kashier "checkout" without Kashier needing to reach us.
 *
 * Why this exists: opening the session URL and paying in the browser will NOT
 * move your local order out of `pending_payment` — Kashier delivers the result
 * via a server-to-server webhook (POST /api/payments/webhook/kashier) and
 * `KASHIER_WEBHOOK_URL` is currently `https://example.com/...`, unreachable.
 * Localhost can't receive Kashier's webhook under test mode.
 *
 * Usage:
 *   npx tsx play/pay-webhook.ts <orderPublicId> [region]   # region default eg
 *
 * What it does: builds the same `event: "pay"` / `status: "SUCCESS"` payload
 * Kashier would send after a successful checkout, HMAC-signs it exactly like
 * the gateway does (see src/pkg/payments/kashier/kashier.signature.ts) and
 * POSTs it to your local webhook endpoint. The order transitions
 * pending_payment → placed, the session is marked CAPTURED and a transaction
 * row is created.
 */
import {createHmac} from "crypto";
import {readFileSync} from "fs";
import path from "path";

const ROOT = "/home/marwan/Side Projects/Crave/crave-order-service/backend";
const ORDER_BASE = "http://localhost:4000/api";

const envp: Record<string, string> = {};
for (const line of readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) envp[m[1]] = m[2];
}

const [publicId, regionArg] = process.argv.slice(2);
if (!publicId) {
    console.error("usage: npx tsx play/pay-webhook.ts <orderPublicId> [region]");
    process.exit(1);
}
const region = regionArg ?? "eg";

const {Pool} = require(path.join(ROOT, "node_modules/pg"));
const pool = new Pool({
    host: envp[`DB_${region}_HOST`], port: Number(envp[`DB_${region}_PORT`]),
    user: envp[`DB_${region}_USERNAME`], password: envp[`DB_${region}_PASSWORD`], database: envp[`DB_${region}_NAME`],
});

const json = async (r: Response) => ({status: r.status, body: await r.json().catch(() => ({}))});

(async () => {
    const order = await pool.query("select id, public_id, status, total, currency, branch_id, customer_id from orders where public_id = $1", [publicId]);
    if (order.rows.length === 0) throw new Error(`order ${publicId} not found in ${region} shard`);
    const o = order.rows[0];
    if (o.status === "placed" || o.status !== "pending_payment") {
        console.log(`order ${publicId} status is "${o.status}" — nothing to do`);
        await pool.end();
        return;
    }
    const session = await pool.query(
        "select id, provider_session_id from payment_sessions where order_id = $1 and status in ('initialized','pending') order by id desc limit 1",
        [o.id],
    );
    if (session.rows.length === 0) throw new Error(`no active payment session for order ${publicId} (already captured?)`);

    // Same shape Kashier sends for a successful card payment, and the total
    // in major units (EGP 1.00 = 100 piasters — order totals are minor units).
    const txId = `TX-LOCAL-${Date.now()}`;
    const data: Record<string, unknown> = {
        amount: (o.total / 100).toFixed(2),
        currency: o.currency,
        merchantOrderId: publicId,
        kashierOrderId: `KO-${session.rows[0].provider_session_id}`,
        method: "card",
        orderReference: `LOCAL-${session.rows[0].id}`,
        status: "SUCCESS",
        transactionId: txId,
        transactionResponseCode: "00",
    };
    const signatureKeys = Object.keys(data);
    data.signatureKeys = signatureKeys;

    const payload = [...signatureKeys].sort()
        .map((k) => `${k}=${encodeURIComponent(String(data[k]))}`).join("&");
    const signature = createHmac("sha256", envp.KASHIER_API_KEY).update(payload, "utf8").digest("hex");

    const res = await json(await fetch(`${ORDER_BASE}/payments/webhook/kashier?region=${region}`, {
        method: "POST",
        headers: {"content-type": "application/json", "x-kashier-signature": signature},
        body: JSON.stringify({event: "pay", data}),
    }));
    console.log("webhook →", res.status, JSON.stringify(res.body));

    const after = await pool.query("select public_id, status from orders where public_id = $1", [publicId]);
    console.log(`order ${publicId}: "${o.status}" → "${after.rows[0].status}"`);
    await pool.end();
    if (after.rows[0].status !== "placed") process.exit(1);
})();
