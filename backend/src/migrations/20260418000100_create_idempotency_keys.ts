import {Knex} from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("idempotency_keys", (table) => {
        table.text("idempotency_key").notNullable();
        table.text("route_path").notNullable();
        table.text("body_hash").notNullable();
        table.integer("response_status").nullable();
        table.jsonb("response_body").nullable();
        table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
        table.timestamp("locked_until").nullable(); // For preventing concurrent requests

        table.primary(["idempotency_key", "route_path"]); // Composite primary key
        table.index(["created_at"]); // For cleanup/TTL
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTable("idempotency_keys");
}
