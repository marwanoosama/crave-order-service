# Order service design pointer

The maintained, implementation-grounded design is [`../../docs/system-design.md`](../../docs/system-design.md).
This older backend-local copy predates monthly order partitions and the analytics outbox;
use the linked document as the source of truth.

Legacy references to sharding, cache and messaging map to the linked document's
[regional data layout](../../docs/system-design.md#regional-sharding-and-time-partitioning)
and [messaging section](../../docs/system-design.md#messaging-cache-and-settlement).
