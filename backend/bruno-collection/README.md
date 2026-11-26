# Crave — Bruno Endpoint Collection

Full Postman-style collection covering the core and order services. Analytics has its own
collection in `crave-analytics-service/backend/bruno-collection`:

| Service | Env var | Local value |
|---|---|---|
| Core service (auth, users, restaurants, branches, catalog, rbac, internal API) | `coreBase` | http://localhost:3000/api |
| Order service (orders, agents, payments, finance) | `orderBase` | http://localhost:4000/api |

## How to use

1. Open Bruno → **Import** → **Open Collection** → select this folder (`bruno-collection`).
2. Select the **Local** environment (dropdown at the top). It lives in
   `environments/Local.bru` and defines all service URLs, test IDs, request payloads,
   credentials, idempotency keys, and actor token slots. Tokens are pre-filled with
   30-day dev JWTs — just press Send.
3. Run the `01 Auth` login requests for the actors you need. Each login stores both an
   actor-specific JWT (for example `customer1Token`, `owner1Token`, `agent1Token`) and
   refresh token. The collection includes every seeded actor: admin, owners 1–3, managers 1–2,
   staff 1–2, customers 1–3, and agents 1–3.
4. Some requests (e.g. create/assign) save returned ids into env vars:
   creating an order stores `orderId` (its public id) used by the
   status-transition / agent / webhook requests.
5. Internal API requests use `{{internalApiKey}}`; the negative request uses `{{badApiKey}}`.

## Order status transition flow (exercise `07 Orders` in this order)

`01 Create order (COD)` → `07 → accepted (staff)` → `08 → preparing (staff)` →
`09 → ready (manager)` → (agent goes online in `08 Agents`) → assignment worker
broadcasts an offer (worker only) → `08 Agents/03 Accept offer` →
`04 Status (picked/delivered)`.

Order lifecycle: `pending_payment → placed → accepted → preparing → ready →
assigned → picked → delivered`, with cancellation/rejection paths.

## Kashier webhook

`09 Payments/01` needs a valid `x-kashier-signature` header =
`HMAC-SHA256(apiKey)` over the QR-style `key=value&` pairs of the
`signatureKeys` fields (merchantOrderId, amount, currency, id, status, mid…
sorted) — see the generator in `../play/smoke-all.ts`. Point Kashier's test
dashboard webhooks or send your own signed payload.

## Notes

- Idempotency keys are fixed strings per request; bump them in the
  request Headers if you want a fresh response.
- `region` env var (values `eg` / `ksa`) sets the `X-Region` shard header used
  by all order-service requests.

## WebSocket / Socket.IO

The order service exposes Socket.IO on `{{wsUrl}}` (`/ws` with the Engine.IO query). Bruno's
WebSocket client is a raw WebSocket client, so the requests in `11 WebSocket` use the Socket.IO
wire packets directly:

1. Connect and wait for the Engine.IO `0` packet.
2. Send `40` to open the Socket.IO namespace.
3. After the server's `hello` event, send the saved `subscribe` messages.

The collection covers customer, restaurant-member, delivery-agent, and admin-alert rooms. The
implemented server events are `hello`, `subscribed`, `order.created`, `order.status_changed`,
`task.offered`, `task.assigned`, `offer.cancelled`, and `assignment.exhausted`.
