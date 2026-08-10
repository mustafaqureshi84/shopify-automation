import { mutate, requireData } from './mutations.js';
import { limiter } from './shopify.js';
import { paginate } from './paginate.js';
import {
  LocationsPageSchema,
  VariantInventoryItemsPageSchema,
  InventorySetQuantitiesResponseSchema,
  InventoryActivateResponseSchema,
} from './types.js';
import type { Location, InventoryItemRef } from './types.js';
import type { Connection } from './paginate.js';
import { handleFatal, describeError } from './exit.js';
import { GENERATED_TAG } from './generate-products.js';

const LOCATIONS_QUERY = `
  query AllLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after, includeInactive: false) {
      pageInfo { hasNextPage endCursor }
      nodes { id name isActive shipsInventory fulfillsOnlineOrders }
    }
  }
`;

const VARIANT_ITEMS_QUERY = `
  query VariantInventoryItems($first: Int!, $after: String) {
    productVariants(
      first: $first
      after: $after
      query: "tag:'${GENERATED_TAG}'"
      sortKey: ID
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        sku
        inventoryItem { id tracked }
        product { id tags }
      }
    }
  }
`;

/**
 * Stocking a variant at a location requires activating it there first.
 * Takes ONE locationId — there is no array form.
 */
const ACTIVATE = `
  mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!) {
    inventoryActivate(
      inventoryItemId: $inventoryItemId
      locationId: $locationId
    ) {
      inventoryLevel { id }
      userErrors { field message }
    }
  }
`;

/**
 * `on_hand` is set rather than `available`. Available is derived —
 * on_hand minus committed — and is not directly settable.
 */
const SET_QUANTITIES = `
  mutation SetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        createdAt
        reason
        changes { name delta }
      }
      userErrors { field message code }
    }
  }
`;

function extractLocations(body: unknown): Connection<Location> {
  return requireData(LocationsPageSchema, body, 'Locations').locations;
}

function extractVariants(body: unknown): Connection<InventoryItemRef> {
  return requireData(
    VariantInventoryItemsPageSchema,
    body,
    'Variant inventory items'
  ).productVariants;
}

/** Deterministic PRNG, matching the generator's approach. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface Plan {
  inventoryItemId: string;
  sku: string;
  /** locationId -> on_hand quantity */
  quantities: Map<string, number>;
}

/**
 * Distribution is deliberately uneven so the report has something to find:
 *
 *   60% — shippable location only
 *   20% — both locations (multi-location split)
 *   10% — non-shipping location only (stock that exists but can't ship)
 *   10% — zero everywhere (out of stock, still tracked)
 */
function buildPlan(
  variant: InventoryItemRef,
  shipping: Location,
  nonShipping: Location | null,
  rng: () => number
): Plan {
  const quantities = new Map<string, number>();
  const roll = rng();
  const base = 1 + Math.floor(rng() * 80);

  if (roll < 0.6 || !nonShipping) {
    quantities.set(shipping.id, base);
  } else if (roll < 0.8) {
    quantities.set(shipping.id, base);
    quantities.set(nonShipping.id, 1 + Math.floor(rng() * 20));
  } else if (roll < 0.9) {
    quantities.set(nonShipping.id, base);
  } else {
    quantities.set(shipping.id, 0);
  }

  return {
    inventoryItemId: variant.inventoryItem.id,
    sku: variant.sku ?? variant.id,
    quantities,
  };
}

async function applyPlan(plan: Plan): Promise<{ ok: boolean; error?: string }> {
  try {
    // One activation per location — inventoryActivate takes a single ID.
    for (const locationId of plan.quantities.keys()) {
      const activateBody = await mutate(ACTIVATE, {
        mutationName: 'inventoryActivate',
        // Activating an already-active item is a no-op.
        idempotency: 'idempotent',
        variables: { inventoryItemId: plan.inventoryItemId, locationId },
      });

      requireData(
        InventoryActivateResponseSchema,
        activateBody,
        'inventoryActivate'
      );
    }

    const setBody = await mutate(SET_QUANTITIES, {
      mutationName: 'inventorySetQuantities',
      // Absolute values, not deltas — replaying is safe.
      idempotency: 'idempotent',
      variables: {
        input: {
          name: 'on_hand',
          reason: 'other',
          ignoreCompareQuantity: true,
          quantities: [...plan.quantities].map(([locationId, quantity]) => ({
            inventoryItemId: plan.inventoryItemId,
            locationId,
            quantity,
          })),
        },
      },
    });

    requireData(
      InventorySetQuantitiesResponseSchema,
      setBody,
      'inventorySetQuantities'
    );

    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<{ ok: boolean; error?: string }>,
  onProgress?: (done: number, total: number) => void
): Promise<{ ok: number; failed: number; firstError: string | undefined }> {
  let cursor = 0;
  let ok = 0;
  let failed = 0;
  let firstError: string | undefined;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;

      const outcome = await fn(item);

      if (outcome.ok) ok += 1;
      else {
        failed += 1;
        firstError ??= outcome.error;
      }

      if (onProgress && (ok + failed) % 100 === 0) {
        onProgress(ok + failed, items.length);
      }
    }
  }

  const count = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: count }, () => worker()));

  return { ok, failed, firstError };
}

async function main(): Promise<void> {
  const seed = Number(process.env.SEED ?? 7);
  const rng = makeRandom(seed);

  console.log('Fetching locations...');

  const locations: Location[] = [];
  for await (const page of paginate(LOCATIONS_QUERY, extractLocations, {
    pageSize: 50,
  })) {
    locations.push(...page.items);
  }

  const shipping = locations.find((l) => l.shipsInventory);
  const nonShipping = locations.find((l) => !l.shipsInventory) ?? null;

  if (!shipping) {
    throw new Error('No active location with shipsInventory: true');
  }

  console.log(`  shipping:     ${shipping.name}`);
  console.log(`  non-shipping: ${nonShipping?.name ?? '(none)'}\n`);

  console.log('Fetching generated variants...');

  const variants: InventoryItemRef[] = [];
  for await (const page of paginate(VARIANT_ITEMS_QUERY, extractVariants, {
    pageSize: 250,
  })) {
    for (const variant of page.items) {
      if (variant.inventoryItem.tracked) variants.push(variant);
    }
    console.log(`  ${variants.length} tracked variants so far...`);
  }

  if (variants.length === 0) {
    console.log('No generated variants found. Run generate-products.ts first.');
    return;
  }

  const plans = variants.map((v) => buildPlan(v, shipping, nonShipping, rng));

  const summary = { shipOnly: 0, both: 0, nonShipOnly: 0, zero: 0 };
  let plannedUnits = 0;

  for (const plan of plans) {
    const hasShip = plan.quantities.has(shipping.id);
    const hasOther = nonShipping ? plan.quantities.has(nonShipping.id) : false;
    const total = [...plan.quantities.values()].reduce((a, b) => a + b, 0);

    plannedUnits += total;

    if (hasShip && hasOther) summary.both += 1;
    else if (hasOther) summary.nonShipOnly += 1;
    else if (total === 0) summary.zero += 1;
    else summary.shipOnly += 1;
  }

  console.log(`\nPlan for ${plans.length} variants:`);
  console.log(`  shipping location only:     ${summary.shipOnly}`);
  console.log(`  both locations:             ${summary.both}`);
  console.log(`  non-shipping location only: ${summary.nonShipOnly}`);
  console.log(`  zero stock:                 ${summary.zero}`);
  console.log(`  total units:                ${plannedUnits}\n`);

  console.time('populate');

  const result = await mapWithConcurrency(plans, 6, applyPlan, (done, total) => {
    const s = limiter.snapshot();
    console.log(
      `  ${done}/${total} — bucket ${s.available}/${s.maximum}, est cost ${s.estimatedCost}`
    );
  });

  console.timeEnd('populate');

  console.log(`\nSucceeded: ${result.ok}`);
  console.log(`Failed:    ${result.failed}`);

  if (result.firstError) {
    console.log('\nFirst failure in full:\n');
    console.log(result.firstError);
  }

  console.log('\nLimiter:', limiter.snapshot());
  console.log('\nNow run: npx tsx src/inventory-report.ts');
}

main().catch(handleFatal);