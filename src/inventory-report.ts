import { paginate } from './paginate.js';
import { LocationsPageSchema, VariantsPageSchema } from './types.js';
import type { Location, VariantWithInventory } from './types.js';
import type { Connection } from './paginate.js';
import { ShopifyApiError } from './errors.js';
import { handleFatal } from './exit.js';
import { limiter } from './shopify.js';

const LOCATIONS_QUERY = `
  query AllLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after, includeInactive: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        isActive
        shipsInventory
        fulfillsOnlineOrders
      }
    }
  }
`;

const VARIANTS_QUERY = `
  query AllVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        sku
        inventoryQuantity
        inventoryItem {
          id
          tracked
          inventoryLevels(first: 20) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              location { id name }
              quantities(names: ["available", "on_hand", "committed", "incoming"]) {
                name
                quantity
              }
            }
          }
        }
        product {
          id
          title
          status
          totalInventory
        }
      }
    }
  }
`;

function extractLocations(body: unknown): Connection<Location> {
  const parsed = LocationsPageSchema.safeParse(body);

  if (!parsed.success) {
    throw new ShopifyApiError(
      'Locations page did not match expected shape',
      parsed.error.issues
    );
  }

  if (parsed.data.errors) {
    throw new ShopifyApiError('GraphQL returned errors', parsed.data.errors);
  }

  if (!parsed.data.data) {
    throw new ShopifyApiError('Response contained no data', parsed.data);
  }

  return parsed.data.data.locations;
}

function extractVariants(body: unknown): Connection<VariantWithInventory> {
  const parsed = VariantsPageSchema.safeParse(body);

  if (!parsed.success) {
    throw new ShopifyApiError(
      'Variants page did not match expected shape',
      parsed.error.issues
    );
  }

  if (parsed.data.errors) {
    throw new ShopifyApiError('GraphQL returned errors', parsed.data.errors);
  }

  if (!parsed.data.data) {
    throw new ShopifyApiError('Response contained no data', parsed.data);
  }

  return parsed.data.data.productVariants;
}

function quantityNamed(
  quantities: ReadonlyArray<{ name: string; quantity: number }>,
  name: string
): number | null {
  const match = quantities.find((q) => q.name === name);
  return match ? match.quantity : null;
}

interface LocationStats {
  name: string;
  isActive: boolean;
  variantCount: number;
  available: number;
  onHand: number;
  committed: number;
  incoming: number;
}

interface Discrepancy {
  sku: string;
  product: string;
  location: string;
  available: number;
  onHand: number;
}

interface ProductTotals {
  title: string;
  reported: number | null;
  summed: number;
  tracked: boolean;
}

async function main(): Promise<void> {
  console.log('Fetching locations...\n');

  const locations: Location[] = [];

  for await (const location of iterate(LOCATIONS_QUERY, extractLocations)) {
    locations.push(location);
  }

  console.log(`${locations.length} location(s):`);
  for (const loc of locations) {
    const flags = [
      loc.isActive ? 'active' : 'INACTIVE',
      loc.shipsInventory ? 'ships' : 'no-ship',
      loc.fulfillsOnlineOrders ? 'online' : 'no-online',
    ].join(', ');
    console.log(`  ${loc.name} (${flags})`);
  }

  console.log('\nWalking variants...\n');

  const stats = new Map<string, LocationStats>();
  const discrepancies: Discrepancy[] = [];
  const productTotals = new Map<string, ProductTotals>();

  let variantCount = 0;
  let untrackedVariants = 0;
  let variantsWithNoLevels = 0;
  let truncatedLevels = 0;

  for (const loc of locations) {
    stats.set(loc.id, {
      name: loc.name,
      isActive: loc.isActive,
      variantCount: 0,
      available: 0,
      onHand: 0,
      committed: 0,
      incoming: 0,
    });
  }

  for await (const variant of iterate(VARIANTS_QUERY, extractVariants)) {
    variantCount += 1;

    const label = variant.sku ?? variant.id.split('/').pop() ?? '(no sku)';
    const item = variant.inventoryItem;

    const totals = productTotals.get(variant.product.id) ?? {
      title: variant.product.title,
      reported: variant.product.totalInventory,
      summed: 0,
      tracked: false,
    };

    if (!item || !item.tracked) {
      untrackedVariants += 1;
      productTotals.set(variant.product.id, totals);
      continue;
    }

    totals.tracked = true;

    if (item.inventoryLevels.pageInfo.hasNextPage) {
      truncatedLevels += 1;
    }

    if (item.inventoryLevels.nodes.length === 0) {
      variantsWithNoLevels += 1;
    }

    for (const level of item.inventoryLevels.nodes) {
      const available = quantityNamed(level.quantities, 'available') ?? 0;
      const onHand = quantityNamed(level.quantities, 'on_hand') ?? 0;
      const committed = quantityNamed(level.quantities, 'committed') ?? 0;
      const incoming = quantityNamed(level.quantities, 'incoming') ?? 0;

      totals.summed += available;

      const entry = stats.get(level.location.id);

      if (entry) {
        entry.variantCount += 1;
        entry.available += available;
        entry.onHand += onHand;
        entry.committed += committed;
        entry.incoming += incoming;
      }

      if (available !== onHand) {
        discrepancies.push({
          sku: label,
          product: variant.product.title,
          location: level.location.name,
          available,
          onHand,
        });
      }
    }

    productTotals.set(variant.product.id, totals);
  }

  console.log('=== Per-location totals ===\n');

  for (const entry of stats.values()) {
    const marker = entry.isActive ? '' : '  [inactive]';
    console.log(`${entry.name}${marker}`);
    console.log(`  variants stocked: ${entry.variantCount}`);
    console.log(`  available: ${entry.available}`);
    console.log(`  on_hand:   ${entry.onHand}`);
    console.log(`  committed: ${entry.committed}`);
    console.log(`  incoming:  ${entry.incoming}\n`);
  }

  console.log('=== available vs on_hand mismatches ===\n');

  if (discrepancies.length === 0) {
    console.log('None. Nothing is committed to unfulfilled orders.\n');
  } else {
    for (const d of discrepancies) {
      console.log(
        `${d.product} [${d.sku}] @ ${d.location}: ` +
          `available ${d.available}, on_hand ${d.onHand} ` +
          `(difference ${d.onHand - d.available})`
      );
    }
    console.log('');
  }

  console.log('=== totalInventory audit ===\n');

  let matched = 0;
  const mismatches: string[] = [];

  for (const totals of productTotals.values()) {
    if (!totals.tracked) continue;

    if (totals.reported === totals.summed) {
      matched += 1;
    } else {
      mismatches.push(
        `${totals.title}: reported ${totals.reported}, summed ${totals.summed}`
      );
    }
  }

  console.log(`${matched} product(s) matched.`);

  if (mismatches.length > 0) {
    console.log(`${mismatches.length} mismatch(es):`);
    for (const m of mismatches) console.log(`  ${m}`);
  }

  console.log('\n=== Summary ===\n');
  console.log(`Variants scanned:            ${variantCount}`);
  console.log(`Untracked variants:          ${untrackedVariants}`);
  console.log(`Tracked but stocked nowhere: ${variantsWithNoLevels}`);
  console.log(`Variants with >20 locations: ${truncatedLevels}`);
  console.log('Limiter:', limiter.snapshot());
}

/** Thin wrapper so both walks read the same way. */
async function* iterate<T>(
  query: string,
  extract: (body: unknown) => Connection<T>
): AsyncGenerator<T> {
  for await (const page of paginate(query, extract, { pageSize: 50 })) {
    for (const item of page.items) yield item;
  }
}

main().catch(handleFatal);