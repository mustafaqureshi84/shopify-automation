import { shopifyGraphQL, limiter } from './shopify.js';
import { mutate, UserErrorsFailure, requireData } from './mutations.js';
import { paginate } from './paginate.js';
import {
  DefinitionCreateResponseSchema,
  DefinitionListResponseSchema,
  MetafieldsSetResponseSchema,
  ProductsWithMetafieldsPageSchema,
} from './types.js';
import type { ProductWithMetafields } from './types.js';
import type { Connection } from './paginate.js';
import { handleFatal } from './exit.js';

const NAMESPACE = '$app:automation_lab';
const KEY = 'sync_state';

const DEFINITION_QUERY = `
  query ExistingDefinitions($namespace: String!) {
    metafieldDefinitions(
      first: 50
      ownerType: PRODUCT
      namespace: $namespace
    ) {
      nodes {
        id
        name
        namespace
        key
        description
        type { name }
        ownerType
      }
    }
  }
`;

const DEFINITION_CREATE = `
  mutation CreateDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        name
        namespace
        key
        description
        type { name }
        ownerType
      }
      userErrors { field message code }
    }
  }
`;

const METAFIELDS_SET = `
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value type updatedAt }
      userErrors { field message code }
    }
  }
`;

const PRODUCTS_WITH_METAFIELDS = `
  query ProductsWithMetafields($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        metafields(first: 10, namespace: "${NAMESPACE}") {
          nodes { id namespace key value type updatedAt }
        }
      }
    }
  }
`;

function extractProducts(body: unknown): Connection<ProductWithMetafields> {
  return requireData(
    ProductsWithMetafieldsPageSchema,
    body,
    'Products with metafields'
  ).products;
}

async function ensureDefinition(): Promise<string> {
  const { body } = await shopifyGraphQL(DEFINITION_QUERY, {
    namespace: NAMESPACE,
  });

  const definitions = requireData(
    DefinitionListResponseSchema,
    body,
    'Definition list'
  ).metafieldDefinitions.nodes;

  const existing = definitions.find((d) => d.key === KEY);

  if (existing) {
    console.log(
      `Definition exists: ${existing.namespace}.${existing.key} ` +
        `(${existing.type.name})`
    );
    return existing.id;
  }

  console.log('Creating definition...');

  const created = await mutate(DEFINITION_CREATE, {
    mutationName: 'metafieldDefinitionCreate',
    idempotency: 'not-idempotent',
    variables: {
      definition: {
        name: 'Sync state',
        namespace: NAMESPACE,
        key: KEY,
        description: 'Last automation sync timestamp and source',
        type: 'json',
        ownerType: 'PRODUCT',
      },
    },
  });

  const definition = requireData(
    DefinitionCreateResponseSchema,
    created,
    'Definition create'
  ).metafieldDefinitionCreate.createdDefinition;

  if (!definition) {
    throw new Error('Definition create returned no definition');
  }

  console.log(`Created: ${definition.namespace}.${definition.key}`);
  return definition.id;
}

interface SyncState {
  syncedAt: string;
  source: string;
  runCount: number;
}

async function writeMetafields(
  products: ReadonlyArray<{ id: string; title: string }>,
  state: SyncState
): Promise<number> {
  const BATCH_SIZE = 25;
  let written = 0;

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);

    const body = await mutate(METAFIELDS_SET, {
      mutationName: 'metafieldsSet',
      idempotency: 'idempotent',
      variables: {
        metafields: batch.map((p) => ({
          ownerId: p.id,
          namespace: NAMESPACE,
          key: KEY,
          type: 'json',
          value: JSON.stringify(state),
        })),
      },
    });

    const result = requireData(
      MetafieldsSetResponseSchema,
      body,
      'metafieldsSet'
    ).metafieldsSet;

    written += result.metafields.length;
  }

  return written;
}

async function readAll(): Promise<ProductWithMetafields[]> {
  const out: ProductWithMetafields[] = [];

  for await (const page of paginate(PRODUCTS_WITH_METAFIELDS, extractProducts, {
    pageSize: 50,
  })) {
    out.push(...page.items);
  }

  return out;
}

async function main(): Promise<void> {
  await ensureDefinition();

  console.log('\nReading products...');
  const before = await readAll();
  console.log(`${before.length} products found\n`);

  const state: SyncState = {
    syncedAt: new Date().toISOString(),
    source: 'automation-lab',
    runCount: 1,
  };

  console.log('=== First write ===');
  const firstCount = await writeMetafields(before, state);
  console.log(`${firstCount} metafields written`);

  const afterFirst = await readAll();

  const firstIds = new Map<string, string>();
  for (const product of afterFirst) {
    const metafield = product.metafields.nodes.find((m) => m.key === KEY);
    if (metafield) firstIds.set(product.id, metafield.id);
  }

  console.log('\n=== Second write (identical payload) ===');
  const secondCount = await writeMetafields(before, state);
  console.log(`${secondCount} metafields written`);

  const afterSecond = await readAll();

  let sameId = 0;
  let newId = 0;
  let valuesMatch = 0;

  for (const product of afterSecond) {
    const metafield = product.metafields.nodes.find((m) => m.key === KEY);
    if (!metafield) continue;

    if (firstIds.get(product.id) === metafield.id) sameId += 1;
    else newId += 1;

    if (metafield.value === JSON.stringify(state)) valuesMatch += 1;
  }

  console.log('\n=== Idempotency check ===\n');
  console.log(`Metafields reusing the same ID: ${sameId}`);
  console.log(`Metafields with a new ID:       ${newId}`);
  console.log(`Values matching payload:        ${valuesMatch}`);

  const total = afterSecond.reduce(
    (sum, p) => sum + p.metafields.nodes.length,
    0
  );
  console.log(`Total metafields in namespace:  ${total}`);

  if (newId === 0 && total === afterSecond.length) {
    console.log(
      '\nIdempotent: writing twice produced one metafield per product.'
    );
  } else {
    console.log('\nNot idempotent — duplicates were created.');
  }

  console.log('\nLimiter:', limiter.snapshot());
}

main().catch((err: unknown) => {
  if (err instanceof UserErrorsFailure) {
    console.error(`[userErrors] ${err.message}`);
    console.error(JSON.stringify(err.userErrors, null, 2));
    process.exit(65);
  }

  handleFatal(err);
});