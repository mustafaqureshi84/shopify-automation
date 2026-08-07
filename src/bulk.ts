import { shopifyGraphQL } from './shopify.js';
import { mutate, requireData } from './mutations.js';
import { ShopifyApiError } from './errors.js';
import {
  BulkRunQueryResponseSchema,
  CurrentBulkOperationResponseSchema,
  BulkCancelResponseSchema,
  BulkLineSchema,
} from './types.js';
import type { BulkOperation, BulkLine } from './types.js';

const RUN_QUERY = `
  mutation RunBulkQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation {
        id status errorCode createdAt completedAt
        objectCount fileSize url partialDataUrl
      }
      userErrors { field message }
    }
  }
`;

const CURRENT_OPERATION = `
  query CurrentBulkOperation {
    currentBulkOperation {
      id status errorCode createdAt completedAt
      objectCount fileSize url partialDataUrl
    }
  }
`;

const CANCEL_OPERATION = `
  mutation CancelBulkOperation($id: ID!) {
    bulkOperationCancel(id: $id) {
      bulkOperation {
        id status errorCode createdAt completedAt
        objectCount fileSize url partialDataUrl
      }
      userErrors { field message }
    }
  }
`;

export class BulkOperationFailed extends Error {
  constructor(
    message: string,
    public readonly operation: BulkOperation
  ) {
    super(message);
    this.name = 'BulkOperationFailed';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getCurrentOperation(): Promise<BulkOperation | null> {
  const { body } = await shopifyGraphQL(CURRENT_OPERATION);
  return requireData(
    CurrentBulkOperationResponseSchema,
    body,
    'currentBulkOperation'
  ).currentBulkOperation;
}

export async function cancelOperation(id: string): Promise<void> {
  const body = await mutate(CANCEL_OPERATION, {
    mutationName: 'bulkOperationCancel',
    // Cancelling an already-cancelled operation is harmless.
    idempotency: 'idempotent',
    variables: { id },
  });

  requireData(BulkCancelResponseSchema, body, 'bulkOperationCancel');
}

export async function submit(query: string): Promise<BulkOperation> {
  const body = await mutate(RUN_QUERY, {
    mutationName: 'bulkOperationRunQuery',
    // Only one bulk operation runs per app per store, so a duplicate
    // submission is rejected rather than duplicating work.
    idempotency: 'not-idempotent',
    variables: { query },
  });

  const operation = requireData(
    BulkRunQueryResponseSchema,
    body,
    'bulkOperationRunQuery'
  ).bulkOperationRunQuery.bulkOperation;

  if (!operation) {
    throw new ShopifyApiError('Bulk operation was not created', body);
  }

  return operation;
}

export interface PollOptions {
  intervalMs?: number;
  maxIntervalMs?: number;
  timeoutMs?: number;
  onTick?: (op: BulkOperation, elapsedMs: number) => void;
}

export async function pollUntilDone(
  options: PollOptions = {}
): Promise<BulkOperation> {
  const {
    intervalMs = 1000,
    maxIntervalMs = 10_000,
    timeoutMs = 15 * 60 * 1000,
    onTick,
  } = options;

  const started = Date.now();
  let wait = intervalMs;

  for (;;) {
    const elapsed = Date.now() - started;

    if (elapsed > timeoutMs) {
      throw new Error(`Bulk operation still running after ${timeoutMs}ms`);
    }

    await sleep(wait);

    const operation = await getCurrentOperation();

    if (!operation) {
      throw new Error('No current bulk operation — did it get cancelled?');
    }

    onTick?.(operation, Date.now() - started);

    if (operation.status === 'COMPLETED') return operation;

    if (
      operation.status === 'FAILED' ||
      operation.status === 'CANCELED' ||
      operation.status === 'EXPIRED'
    ) {
      throw new BulkOperationFailed(
        `Bulk operation ${operation.status.toLowerCase()}: ${operation.errorCode ?? 'no error code'}`,
        operation
      );
    }

    // Back off — a large export takes minutes and polling every second
    // wastes rate limit on status checks that say the same thing.
    wait = Math.min(maxIntervalMs, Math.round(wait * 1.5));
  }
}

/**
 * Streams a JSONL file line by line without loading it into memory.
 * The result URL is temporary, so download promptly.
 */
export async function* streamLines(url: string): AsyncGenerator<BulkLine> {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Failed to download bulk result: ${res.status}`);
  }

  if (!res.body) {
    throw new Error('Bulk result response had no body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lineNumber = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (value) buffer += decoder.decode(value, { stream: true });

    // A chunk boundary can land mid-line, so only emit complete lines.
    let newlineIndex = buffer.indexOf('\n');

    while (newlineIndex !== -1) {
      const raw = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      lineNumber += 1;

      if (raw.length > 0) {
        yield parseLine(raw, lineNumber);
      }

      newlineIndex = buffer.indexOf('\n');
    }

    if (done) break;
  }

  const tail = buffer.trim();
  if (tail.length > 0) yield parseLine(tail, lineNumber + 1);
}

function parseLine(raw: string, lineNumber: number): BulkLine {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch {
    throw new ShopifyApiError(`Malformed JSON on line ${lineNumber}`, {
      preview: raw.slice(0, 200),
    });
  }

  const parsed = BulkLineSchema.safeParse(json);

  if (!parsed.success) {
    throw new ShopifyApiError(`Unexpected line shape on line ${lineNumber}`, {
      issues: parsed.error.issues,
      preview: raw.slice(0, 200),
    });
  }

  return parsed.data;
}

export interface Grouped<TParent, TChild> {
  parent: TParent;
  children: TChild[];
}

/**
 * JSONL arrives flattened: a parent line, then its children, each carrying
 * `__parentId`. Shopify guarantees children follow their parent, so a
 * parent can be emitted once the next parent appears — no need to hold
 * the whole file in memory.
 */
export async function* groupByParent(
  lines: AsyncIterable<BulkLine>
): AsyncGenerator<Grouped<BulkLine, BulkLine>> {
  let current: Grouped<BulkLine, BulkLine> | null = null;

  for await (const line of lines) {
    if (line.__parentId === undefined) {
      if (current) yield current;
      current = { parent: line, children: [] };
      continue;
    }

    if (!current) {
      throw new ShopifyApiError('Child line appeared before any parent', line);
    }

    if (line.__parentId !== current.parent.id) {
      throw new ShopifyApiError('Child line does not belong to current parent', {
        parentId: current.parent.id,
        childParentId: line.__parentId,
      });
    }

    current.children.push(line);
  }

  if (current) yield current;
}