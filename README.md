# Crave Order Service

Owns order state, online and cash payments, delivery assignment, restaurant finance and
live order updates.

**Stack:** Node.js, TypeScript, Express, PostgreSQL, Redis, RabbitMQ and Socket.IO.

- [System design](docs/system-design.md)

From `backend/`, install dependencies, copy `.env.example` to `.env`, and configure the
regional databases and infrastructure. Run `npm run migrate:all`, then
`npm run partitions:create` and `npm run dev`. Run `npm run worker` separately for
assignment, inbound events and outbox delivery.
