import {Knex} from "knex";

export interface PaginationParams {
    cursor?: string;
    limit: number;
    sortBy: string;
    sortOrder: "asc" | "desc";
}

export interface FilterParams {
    field: string;
    operator: "eq" | "gt" | "lt" | "lte" | "gte" | "in" | "like";
    value: string | string[];
}

export interface PaginationMeta {
    nextCursor: string | null;
    hasMore: boolean;
    count: number;
}

const CURSOR_SEPARATOR = "|";

function camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Decodes a stable composite cursor "<sortValue>|<id>" into its raw parts.
 */
function decodeCursor(cursor: string): {sortValue: string; id: string} | undefined {
    const idx = cursor.lastIndexOf(CURSOR_SEPARATOR);
    if (idx <= 0) return undefined;
    const sortValue = cursor.slice(0, idx);
    const id = cursor.slice(idx + 1);
    if (!sortValue || !id) return undefined;
    return {sortValue, id};
}

/**
 * Applies keyset pagination with a composite (sortColumn, id) cursor. The id
 * tiebreaker prevents rows from being skipped/shared when the sort column
 * (usually a timestamp) is not unique.
 */
export function applyCursorPagination(
    query: Knex.QueryBuilder,
    params: PaginationParams,
): Knex.QueryBuilder {
    if (!params.sortBy) return query;
    const dbColumn = camelToSnake(params.sortBy);
    const decoded = params.cursor ? decodeCursor(params.cursor) : undefined;

    if (decoded) {
        const op = params.sortOrder === "asc" ? ">" : "<";
        query = query.andWhere(function (this) {
            this.where(dbColumn, op, decoded.sortValue)
                .orWhere(dbColumn, "=", decoded.sortValue)
                .andWhere("id", op, decoded.id);
        });
    }

    return query
        .orderBy(dbColumn, params.sortOrder)
        .orderBy("id", params.sortOrder)
        .limit(params.limit + 1);
}

export function applyFilters(
    query: Knex.QueryBuilder,
    filters: FilterParams[],
): Knex.QueryBuilder {
    for (const filter of filters) {
        // DB column names are snake_case; mirrors the sortBy handling above.
        const dbColumn = camelToSnake(filter.field);
        switch (filter.operator) {
            case "eq":
                query.where(dbColumn, filter.value);
                break;
            case "gt":
                query.where(dbColumn, ">", filter.value);
                break;
            case "lt":
                query.where(dbColumn, "<", filter.value);
                break;
            case "lte":
                query.where(dbColumn, "<=", filter.value);
                break;
            case "gte":
                query.where(dbColumn, ">=", filter.value);
                break;
            case "like":
                query.whereLike(dbColumn, `%${filter.value}%`);
                break;
            case "in":
                query.whereIn(
                    dbColumn,
                    Array.isArray(filter.value) ? filter.value : [filter.value],
                );
                break;
        }
    }
    return query;
}

/**
 * Reads the DB-level column (snake_case) off the raw row and encodes a
 * composite cursor the next request can pass back as `?cursor=`.
 */
export function buildPaginationResult<T>(
    rows: T[],
    limit: number,
    sortBy: string,
): {data: T[]; meta: PaginationMeta} {
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    let nextCursor: string | null = null;

    if (hasMore && data.length > 0) {
        const lastItem = data[data.length - 1] as Record<string, unknown>;
        const sortValue = lastItem[camelToSnake(sortBy)];
        const id = lastItem["id"];
        if (sortValue !== undefined && sortValue !== null && id !== undefined && id !== null) {
            nextCursor = encodeCursor(String(sortValue), String(id));
        }
    }

    return {
        data,
        meta: {nextCursor, hasMore, count: data.length},
    };
}

function encodeCursor(sortValue: string, id: string): string {
    return `${sortValue}${CURSOR_SEPARATOR}${id}`;
}
