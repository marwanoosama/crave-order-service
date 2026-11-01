import {Knex} from "knex";
import {OrderItemEntity} from "../entity/order-item.entity";
import {InsertOrderItemInput} from "../types";

const ORDER_ITEM_COLUMNS = [
    "id",
    "region",
    "order_id",
    "product_id",
    "quantity",
    "unit_price_snapshot",
    "name_snapshot",
    "image_url_snapshot",
    "line_total",
    "created_at",
];

function toEntity(row: any): OrderItemEntity {
    return new OrderItemEntity({
        id: Number(row.id),
        region: row.region,
        orderId: Number(row.order_id),
        productId: Number(row.product_id),
        quantity: Number(row.quantity),
        unitPriceSnapshot: Number(row.unit_price_snapshot),
        nameSnapshot: row.name_snapshot,
        imageUrlSnapshot: row.image_url_snapshot,
        lineTotal: Number(row.line_total),
        createdAt: row.created_at,
    });
}

export async function bulkInsertItems(inputs: InsertOrderItemInput[], conn: Knex): Promise<OrderItemEntity[]> {
    if (inputs.length === 0) return [];

    const rows = await conn("order_items")
        .insert(
            inputs.map((item) => ({
                region: item.region,
                order_id: item.orderId,
                product_id: item.productId,
                quantity: item.quantity,
                unit_price_snapshot: item.unitPriceSnapshot,
                name_snapshot: item.nameSnapshot,
                image_url_snapshot: item.imageUrlSnapshot,
                line_total: item.lineTotal,
            })),
        )
        .returning(ORDER_ITEM_COLUMNS);

    return rows.map(toEntity);
}

export async function findItemsByOrderIds(orderIds: number[], conn: Knex): Promise<OrderItemEntity[]> {
    if (orderIds.length === 0) return [];

    const rows = await conn("order_items")
        .select(ORDER_ITEM_COLUMNS)
        .whereIn("order_id", orderIds)
        .orderBy("id", "asc");

    return rows.map(toEntity);
}

export async function countItemsByOrderIds(orderIds: number[], conn: Knex): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    if (orderIds.length === 0) return counts;

    const rows = await conn("order_items")
        .select("order_id")
        .count("* as count")
        .whereIn("order_id", orderIds)
        .groupBy("order_id");

    for (const row of rows) {
        counts.set(Number(row.order_id), Number(row.count));
    }
    return counts;
}
