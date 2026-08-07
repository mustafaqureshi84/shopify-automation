import { shopifyGraphQL } from './shopify.js';
import { ShopifyApiError } from './errors.js';
import type { ThrottleStatus } from './types.js';

export interface Connection<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

export interface Page<T> {
  items: T[];
  pageNumber: number;
  cost: ThrottleStatus | null;
}

export interface PaginateOptions {
  pageSize?: number;
  maxPages?: number;
  variables?: Record<string, unknown>;
}

export async function* paginate<T>(
  query: string,
  extract: (body: unknown) => Connection<T>,
  options: PaginateOptions = {}
): AsyncGenerator<Page<T>> {
  const { pageSize = 250, maxPages = Infinity, variables = {} } = options;

  let cursor: string | null = null;
  let previousCursor: string | null = null;
  let pageNumber = 0;

  while (pageNumber < maxPages) {
    const { body, cost } = await shopifyGraphQL(query, {
      ...variables,
      first: pageSize,
      after: cursor,
    });

    const connection = extract(body);
    pageNumber += 1;

    yield { items: connection.nodes, pageNumber, cost };

    if (!connection.pageInfo.hasNextPage) return;

    const next = connection.pageInfo.endCursor;

    if (!next) {
      throw new ShopifyApiError(
        `hasNextPage was true but endCursor was null on page ${pageNumber}`,
        connection.pageInfo
      );
    }

    if (next === previousCursor) {
      throw new ShopifyApiError(
        `Cursor did not advance on page ${pageNumber} — aborting to avoid an infinite loop`,
        { cursor: next }
      );
    }

    previousCursor = cursor;
    cursor = next;
  }
}

export async function* paginateItems<T>(
  query: string,
  extract: (body: unknown) => Connection<T>,
  options: PaginateOptions = {}
): AsyncGenerator<T> {
  for await (const page of paginate(query, extract, options)) {
    for (const item of page.items) {
      yield item;
    }
  }
}