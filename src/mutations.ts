import { shopifyGraphQL } from './shopify.js';
import { ShopifyApiError } from './errors.js';
import { UserErrorSchema } from './types.js';
import type { UserError } from './types.js';
import { z } from 'zod';

/**
 * A mutation that produces the same end state whether it runs once or
 * five times. Only these are safe to retry blindly.
 *
 * Upserts (metafieldsSet) are idempotent: writing the same value twice
 * leaves the same value.
 *
 * Creates (productCreate) are NOT: two calls make two products.
 */
export type Idempotency = 'idempotent' | 'not-idempotent';

export class UserErrorsFailure extends Error {
  constructor(
    message: string,
    public readonly userErrors: UserError[],
    public readonly mutationName: string
  ) {
    super(message);
    this.name = 'UserErrorsFailure';
  }
}

const UserErrorProbeSchema = z.object({
  data: z.record(
    z.string(),
    z.looseObject({ userErrors: z.array(UserErrorSchema) })
  ),
});

export function assertNoUserErrors(body: unknown, mutationName: string): void {
  const probe = UserErrorProbeSchema.safeParse(body);
  if (!probe.success) return;

  const payload = probe.data.data[mutationName];
  if (!payload) return;

  if (payload.userErrors.length > 0) {
    const summary = payload.userErrors
      .map((e) => {
        const path = e.field ? e.field.join('.') : '(no field)';
        const code = e.code ? ` [${e.code}]` : '';
        return `${path}: ${e.message}${code}`;
      })
      .join('; ');

    throw new UserErrorsFailure(
      `${mutationName} rejected: ${summary}`,
      payload.userErrors,
      mutationName
    );
  }
}

export interface MutateOptions {
  mutationName: string;
  idempotency: Idempotency;
  variables?: Record<string, unknown>;
}

/**
 * Runs a mutation, then verifies userErrors before returning.
 *
 * Non-idempotent mutations are NOT retried on network failure — the
 * write may have succeeded with the response lost, and retrying would
 * duplicate. Those failures surface for a human to reconcile.
 */
export async function mutate(
  mutation: string,
  options: MutateOptions
): Promise<unknown> {
  const { mutationName, idempotency, variables } = options;

  const { body } = await shopifyGraphQL(mutation, variables, {
    retry: idempotency === 'idempotent',
  });

  assertNoUserErrors(body, mutationName);
  return body;
}

/**
 * Parses a response and returns its `data` payload, throwing on any of
 * the three failure channels: bad shape, GraphQL errors, or null data.
 *
 * Takes the schema rather than a parse result so the return type is a
 * plain object rather than a union TypeScript has to narrow at each use.
 */
export function requireData<T>(
  schema: z.ZodType<{ data?: T | undefined; errors?: unknown }>,
  body: unknown,
  context: string
): T {
  // Check errors BEFORE shape. A rejected request often has null data as a
  // consequence of the error, and the error is the message worth reading.
  const envelope = z
    .object({ errors: z.array(z.object({ message: z.string() })).optional() })
    .safeParse(body);

  if (envelope.success && envelope.data.errors?.length) {
    throw new ShopifyApiError(
      `${context} returned GraphQL errors`,
      envelope.data.errors
    );
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new ShopifyApiError(
      `${context} did not match expected shape`,
      parsed.error.issues
    );
  }

  if (parsed.data.data === undefined) {
    throw new ShopifyApiError(`${context} contained no data`, parsed.data);
  }

  return parsed.data.data;
}