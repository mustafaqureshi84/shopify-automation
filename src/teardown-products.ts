import { mutate, requireData } from './mutations.js';
import { paginate } from './paginate.js';
import { limiter } from './shopify.js';
import {
  GeneratedProductsPageSchema,
  ProductDeleteResponseSchema,
} from './types.js';
import type { GeneratedProduct } from './types.js';
import type { Connection } from './paginate.js';
import { handleFatal, describeError } from './exit.js';
import { GENERATED_TAG } from './constants.js';

const TAGGED_PRODUCTS = `
  query GeneratedProducts($first: Int!, $after: String) {
    products(
      first: $first
      after: $after
      query: "tag:'${GENERATED_TAG}'"
      sortKey: ID
    ) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle title tags }
    }
  }
`;

// productDelete returns plain UserError — no `code` field.
const PRODUCT_DELETE = `
  mutation DeleteProduct($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

function extract(body: unknown): Connection<GeneratedProduct> {
  return requireData(GeneratedProductsPageSchema, body, 'Generated products')
    .products;
}

async function collectIds(): Promise<string[]> {
  const ids: string[] = [];

  for await (const page of paginate(TAGGED_PRODUCTS, extract, {
    pageSize: 250,
  })) {
    for (const product of page.items) {
      // Belt and braces: the search index can lag, so verify the tag.
      if (product.tags.includes(GENERATED_TAG)) ids.push(product.id);
    }
    console.log(`  found ${ids.length} so far...`);
  }

  return ids;
}

interface DeleteOutcome {
  ok: boolean;
  error?: string;
}

async function deleteOne(id: string): Promise<DeleteOutcome> {
  try {
    const body = await mutate(PRODUCT_DELETE, {
      mutationName: 'productDelete',
      // Deleting an already-deleted product leaves the same end state.
      // Unlike create, delete IS idempotent.
      idempotency: 'idempotent',
      variables: { input: { id } },
    });

    requireData(ProductDeleteResponseSchema, body, 'productDelete');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

async function main(): Promise<void> {
  if (process.env.CONFIRM !== 'yes') {
    console.log('This deletes every product tagged:', GENERATED_TAG);
    console.log('Seeded test data is not affected.\n');
    console.log('Rerun with CONFIRM=yes to proceed:');
    console.log('  $env:CONFIRM="yes"; npx tsx src/teardown-products.ts');
    return;
  }

  console.log(`Finding products tagged ${GENERATED_TAG}...`);
  const ids = await collectIds();

  if (ids.length === 0) {
    console.log('Nothing to delete.');
    return;
  }

  console.log(`\nDeleting ${ids.length} products...`);
  console.time('teardown');

  let deleted = 0;
  let failed = 0;
  let firstError: string | undefined;
  let cursor = 0;

  const concurrency = Math.max(2, limiter.suggestedConcurrency());

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      const id = ids[index];
      if (id === undefined) return;

      const outcome = await deleteOne(id);

      if (outcome.ok) {
        deleted += 1;
      } else {
        failed += 1;
        firstError ??= outcome.error;
      }

      if ((deleted + failed) % 50 === 0) {
        console.log(`  ${deleted + failed}/${ids.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  console.timeEnd('teardown');
  console.log(`\nDeleted: ${deleted}`);
  console.log(`Failed:  ${failed}`);

  if (firstError) {
    console.log('\nFirst failure in full:\n');
    console.log(firstError);
  }

  console.log('\nLimiter:', limiter.snapshot());
}

main().catch(handleFatal);