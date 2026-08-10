import { shopifyGraphQL } from './shopify.js';
import { requireData } from './mutations.js';
import { ShopifyAuthError } from './errors.js';
import { z } from 'zod';

const SCOPES_QUERY = `
  query GrantedScopes {
    currentAppInstallation {
      accessScopes { handle }
    }
  }
`;

const ScopesSchema = z.object({
  data: z
    .object({
      currentAppInstallation: z.object({
        accessScopes: z.array(z.object({ handle: z.string() })),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

let cached: Set<string> | null = null;

export async function grantedScopes(): Promise<Set<string>> {
  if (cached) return cached;

  const { body } = await shopifyGraphQL(SCOPES_QUERY);

  const scopes = requireData(
    ScopesSchema,
    body,
    'currentAppInstallation'
  ).currentAppInstallation.accessScopes;

  cached = new Set(scopes.map((s) => s.handle));
  return cached;
}

/**
 * Verifies the token actually holds every required scope before the script
 * does any work.
 *
 * Declared scopes and granted scopes drift: releasing a new app version
 * changes what the app *declares*, but an existing installation keeps the
 * grant it was authorized under, and tokens are issued against the
 * installation. Reads keep working while every write is denied — which
 * otherwise surfaces mid-run, after minutes of wasted effort.
 */
export async function assertScopes(required: readonly string[]): Promise<void> {
  const granted = await grantedScopes();
  const missing = required.filter((scope) => !granted.has(scope));

  if (missing.length === 0) return;

  throw new ShopifyAuthError(
    `Missing required scope(s): ${missing.join(', ')}\n` +
      `Granted: ${[...granted].sort().join(', ')}\n\n` +
      'Add the scope in the Dev Dashboard, release a new version, then ' +
      'REINSTALL the app on the store. Releasing alone does not update an ' +
      'existing installation.',
    403,
    undefined
  );
}

/**
 * Shared sample-mode convention. `LIMIT=5` processes five items and stops,
 * turning a twenty-minute feedback loop into a five-second one when a
 * mutation shape turns out to be wrong.
 */
export function getLimit(): number | null {
  const raw = process.env['LIMIT'];
  if (!raw) return null;

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`LIMIT must be a positive integer, got: ${raw}`);
  }

  return parsed;
}

/** Applies LIMIT if set, and reports when it's truncating. */
export function applyLimit<T>(items: T[], label: string): T[] {
  const limit = getLimit();
  if (limit === null) return items;

  const sliced = items.slice(0, limit);
  console.log(
    `\n  LIMIT=${limit} — processing ${sliced.length} of ${items.length} ${label}\n`
  );
  return sliced;
}