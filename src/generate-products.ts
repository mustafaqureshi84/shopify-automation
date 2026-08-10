import { mutate, requireData } from './mutations.js';
import { limiter } from './shopify.js';
import { assertScopes, applyLimit } from './preflight.js';
import { ProductSetResponseSchema } from './types.js';
import { handleFatal, describeError } from './exit.js';
import { GENERATED_TAG } from './constants.js';

const REQUIRED_SCOPES = ['read_products', 'write_products'];

/**
 * One atomic call. `synchronous: true` makes Shopify complete the write
 * before responding rather than returning an async operation handle.
 */
const PRODUCT_SET = `
  mutation SetProduct($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) {
      product {
        id
        handle
        title
        variants(first: 10) { nodes { id sku } }
      }
      userErrors { field message code }
    }
  }
`;

const CATEGORIES = [
  'Snowboard',
  'Ski',
  'Boot',
  'Binding',
  'Helmet',
  'Goggle',
  'Glove',
  'Jacket',
];

const MATERIALS = ['Carbon', 'Alloy', 'Composite', 'Titanium', 'Bamboo'];
const COLORS = ['Black', 'Red', 'Blue', 'Green', 'White', 'Orange'];

/** Deterministic PRNG so a given seed always produces the same catalog. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  return items[index] ?? items[0]!;
}

interface ProductSpec {
  title: string;
  status: 'ACTIVE' | 'DRAFT';
  tags: string[];
  variants: Array<{ color: string; sku: string; price: string }>;
}

function buildSpec(index: number, rng: () => number): ProductSpec {
  const category = pick(rng, CATEGORIES);
  const material = pick(rng, MATERIALS);
  const title = `${material} ${category} ${String(index).padStart(5, '0')}`;

  // ~8% drafts, so the catalog isn't uniformly ACTIVE.
  const status = rng() < 0.08 ? 'DRAFT' : 'ACTIVE';

  const variantCount = 2 + Math.floor(rng() * 3); // 2–4

  // Shuffle a copy so colours are unique within a product — duplicate
  // option values are rejected with VARIANT_ALREADY_EXISTS.
  const shuffled = [...COLORS].sort(() => rng() - 0.5);
  const colors = shuffled.slice(0, variantCount);

  const variants = colors.map((color, i) => ({
    color,
    // Index in the SKU guarantees global uniqueness.
    sku: `AL-${String(index).padStart(5, '0')}-${i}`,
    price: (49 + Math.floor(rng() * 700)).toFixed(2),
  }));

  return {
    title,
    status,
    tags: [GENERATED_TAG, category.toLowerCase(), material.toLowerCase()],
    variants,
  };
}

interface CreateOutcome {
  index: number;
  status: 'created' | 'failed';
  productId?: string;
  error?: string;
}

async function createOne(
  spec: ProductSpec,
  index: number
): Promise<CreateOutcome> {
  try {
    const body = await mutate(PRODUCT_SET, {
      mutationName: 'productSet',
      idempotency: 'not-idempotent',
      variables: {
        input: {
          title: spec.title,
          status: spec.status,
          tags: spec.tags,
          productOptions: [
            {
              name: 'Color',
              values: spec.variants.map((v) => ({ name: v.color })),
            },
          ],
          variants: spec.variants.map((v) => ({
            optionValues: [{ optionName: 'Color', name: v.color }],
            price: v.price,
            sku: v.sku,
            inventoryItem: { tracked: true },
          })),
        },
      },
    });

    const product = requireData(ProductSetResponseSchema, body, 'productSet')
      .productSet.product;

    if (!product) {
      return { index, status: 'failed', error: 'no product returned' };
    }

    return { index, status: 'created', productId: product.id };
  } catch (err) {
    return { index, status: 'failed', error: describeError(err) };
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;

      results[index] = await fn(item, index);
      completed += 1;

      if (onProgress && completed % 25 === 0) {
        onProgress(completed, items.length);
      }
    }
  }

  const count = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: count }, () => worker()));

  return results;
}

async function main(): Promise<void> {
  await assertScopes(REQUIRED_SCOPES);

  const total = Number(process.env.COUNT ?? 2000);
  const seed = Number(process.env.SEED ?? 42);
  const startAt = Number(process.env.START_AT ?? 1);

  const rng = makeRandom(seed);
  const allSpecs: ProductSpec[] = [];

  for (let i = 0; i < total; i++) {
    allSpecs.push(buildSpec(startAt + i, rng));
  }

  const specs = applyLimit(allSpecs, 'products');
  const variantTotal = specs.reduce((sum, s) => sum + s.variants.length, 0);

  console.log(`Generating ${specs.length} products (${variantTotal} variants)`);
  console.log(`Seed ${seed}, starting index ${startAt}\n`);

  console.time('generate');

  // Start conservative — the limiter has no cost data for these mutations yet.
  const results = await mapWithConcurrency(
    specs,
    4,
    (spec, i) => createOne(spec, startAt + i),
    (done, count) => {
      const s = limiter.snapshot();
      console.log(
        `  ${done}/${count} — bucket ${s.available}/${s.maximum}, ` +
          `est cost ${s.estimatedCost}, suggested concurrency ${limiter.suggestedConcurrency()}`
      );
    }
  );

  console.timeEnd('generate');

  const created = results.filter((r) => r.status === 'created');
  const failed = results.filter((r) => r.status === 'failed');

  console.log(`\nCreated: ${created.length}`);
  console.log(`Failed:  ${failed.length}`);

  if (failed.length > 0) {
    console.log('\nFirst failure in full:\n');
    console.log(failed[0]?.error);

    if (failed.length > 1) {
      console.log(`\n(${failed.length - 1} more failures suppressed)`);
    }

    console.log(
      '\nRerun with START_AT past the last successful index to fill gaps,'
    );
    console.log('or run teardown-products.ts and start clean.');
  }

  console.log('\nLimiter:', limiter.snapshot());
  console.log(`\nTagged: ${GENERATED_TAG}`);
}

main().catch(handleFatal);