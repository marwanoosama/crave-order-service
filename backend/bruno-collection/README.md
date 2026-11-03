# Crave — Bruno Endpoint Collection

Full Postman-style collection covering both microservices:

| Service | Env var | Local value |
|---|---|---|
| Core service (auth, users, restaurants, branches, catalog, rbac, internal API) | `coreBase` | http://localhost:3000/api |
| Order service (orders, agents, payments, finance) | `orderBase` | http://localhost:4000/api |

## How to use

1. Open Bruno → **Import** → **Open Collection** → select this folder (`bruno-collection`).
2. Select the **Local** environment (dropdown at the top).
3. Run a **Login** request in `01 Auth` for the role you want to test. Each login
   stores its `access_token` in an env var (e.g. `customerToken`, `ownerToken`).
   All other requests send `Cookie: access_token={{<roleToken>}}` automatically.
4. Some requests (e.g. create/assign) save returned ids into env vars:
   creating an order stores `orderId` (its public id) used by the
   status-transition / agent / webhook requests.
5. Internal API requests use the
   `api-key: dev-internal-api-key` header (service-to-service).

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
