import { randomUUID } from 'node:crypto';
import { mutate, requireData } from './mutations.js';
import { shopifyGraphQL } from './shopify.js';
import { assertScopes } from './preflight.js';
import { handleFatal } from './exit.js';
import { z } from 'zod';

const REQUIRED_SCOPES = ['read_products', 'read_inventory', 'write_inventory'];

const FIND_VARIANT = `
  query FindVariant($sku: String!) {
    productVariants(first: 1, query: $sku) {
      nodes {
        id
        sku
        inventoryItem {
          id
          inventoryLevels(first: 5) {
            nodes {
              location { id name }
              quantities(names: ["on_hand", "available"]) { name quantity }
            }
          }
        }
      }
    }
  }
`;

const SET_QUANTITIES = `
  mutation SetQuantities(
    $input: InventorySetQuantitiesInput!
    $idempotencyKey: String!
  ) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup {
        reason
        changes { name delta }
      }
      userErrors { field message code }
    }
  }
`;

const VariantSchema = z.object({
  data: z
    .object({
      productVariants: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            sku: z.string().nullable(),
            inventoryItem: z.object({
              id: z.string(),
              inventoryLevels: z.object({
                nodes: z.array(
                  z.object({
                    location: z.object({ id: z.string(), name: z.string() }),
                    quantities: z.array(
                      z.object({ name: z.string(), quantity: z.number() })
                    ),
                  })
                ),
              }),
            }),
          })
        ),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

const SetSchema = z.object({
  data: z
    .object({
      inventorySetQuantities: z.object({
        inventoryAdjustmentGroup: z
          .object({
            reason: z.string().nullable(),
            changes: z.array(
              z.object({ name: z.string(), delta: z.number() })
            ),
          })
          .nullable(),
        userErrors: z.array(
          z.object({
            field: z.array(z.string()).nullable(),
            message: z.string(),
            code: z.string().nullable().optional(),
          })
        ),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

async function main(): Promise<void> {
  await assertScopes(REQUIRED_SCOPES);

  const sku = process.env['SKU'];
  const target = Number(process.env['TO'] ?? 5);

  if (!sku) {
    console.log('Usage: $env:SKU="AL-00500-0"; npx tsx src/test-flow-trigger.ts');
    return;
  }

  const { body } = await shopifyGraphQL(FIND_VARIANT, { sku: `sku:${sku}` });
  const variant = requireData(VariantSchema, body, 'findVariant')
    .productVariants.nodes[0];

  if (!variant) {
    console.log(`No variant found with SKU ${sku}`);
    return;
  }

  console.log(`Variant ${variant.sku} (${variant.id})\n`);

  for (const level of variant.inventoryItem.inventoryLevels.nodes) {
    const parts = level.quantities
      .map((q) => `${q.name}=${q.quantity}`)
      .join(', ');
    console.log(`  ${level.location.name}: ${parts}`);
  }

  const level = variant.inventoryItem.inventoryLevels.nodes[0];

  if (!level) {
    console.log('\nVariant is not stocked at any location.');
    return;
  }

  const onHand = level.quantities.find((q) => q.name === 'on_hand')?.quantity;

  console.log(`\nSetting on_hand at ${level.location.name}: ${onHand} -> ${target}`);

  const setBody = await mutate(SET_QUANTITIES, {
    mutationName: 'inventorySetQuantities',
    idempotency: 'idempotent',
    variables: {
      idempotencyKey: randomUUID(),
      input: {
        name: 'on_hand',
        reason: 'other',
        quantities: [
          {
            inventoryItemId: variant.inventoryItem.id,
            locationId: level.location.id,
            quantity: target,
            changeFromQuantity: null,
          },
        ],
      },
    },
  });

  const result = requireData(SetSchema, setBody, 'inventorySetQuantities')
    .inventorySetQuantities;

  console.log('\nAdjustment group:', JSON.stringify(result.inventoryAdjustmentGroup, null, 2));
  console.log('\nDone. Check Flow Activity in 2-3 minutes.');
}

main().catch(handleFatal);