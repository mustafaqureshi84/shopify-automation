import { writeFile, mkdir } from 'node:fs/promises';
import { shopifyGraphQL } from './shopify.js';
import { requireData } from './mutations.js';
import { assertScopes } from './preflight.js';
import { handleFatal } from './exit.js';
import { z } from 'zod';

const REQUIRED_SCOPES = ['read_orders'];

const ORDERS_QUERY = `
  query RecentOrders($first: Int!) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        test
        displayFinancialStatus
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        customer { email }
        lineItems(first: 50) {
          nodes {
            id
            title
            quantity
            sku
            variant { id }
            originalUnitPriceSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

const OrdersSchema = z.object({
  data: z
    .object({
      orders: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            createdAt: z.string(),
            test: z.boolean(),
            displayFinancialStatus: z.string().nullable(),
            displayFulfillmentStatus: z.string().nullable(),
            currentTotalPriceSet: z.object({
              shopMoney: z.object({
                amount: z.string(),
                currencyCode: z.string(),
              }),
            }),
            customer: z.object({ email: z.string().nullable() }).nullable(),
            lineItems: z.object({
              nodes: z.array(
                z.object({
                  id: z.string(),
                  title: z.string(),
                  quantity: z.number(),
                  sku: z.string().nullable(),
                  variant: z.object({ id: z.string() }).nullable(),
                  originalUnitPriceSet: z.object({
                    shopMoney: z.object({ amount: z.string() }),
                  }),
                })
              ),
            }),
          })
        ),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

/** Numeric ID from a GID, for the REST-shaped payload webhooks actually send. */
function numericId(gid: string): number {
  const tail = gid.split('/').pop() ?? '0';
  return Number(tail);
}

async function main(): Promise<void> {
  await assertScopes(REQUIRED_SCOPES);

  const count = Number(process.env['COUNT'] ?? 10);

  const { body } = await shopifyGraphQL(ORDERS_QUERY, { first: count });
  const orders = requireData(OrdersSchema, body, 'orders').orders.nodes;

  if (orders.length === 0) {
    console.log('No orders found. Place some test orders first.');
    return;
  }

  await mkdir('fixtures/orders', { recursive: true });

  console.log(`${orders.length} order(s) found\n`);

  for (const order of orders) {
    /**
     * Shopify sends REST-shaped payloads to webhooks, not GraphQL shapes.
     * Building the REST form here means the handler parses exactly what a
     * real `orders/create` delivery would contain.
     */
    const payload = {
      id: numericId(order.id),
      admin_graphql_api_id: order.id,
      name: order.name,
      created_at: order.createdAt,
      test: order.test,
      financial_status: order.displayFinancialStatus?.toLowerCase() ?? null,
      fulfillment_status: order.displayFulfillmentStatus?.toLowerCase() ?? null,
      total_price: order.currentTotalPriceSet.shopMoney.amount,
      currency: order.currentTotalPriceSet.shopMoney.currencyCode,
      email: order.customer?.email ?? null,
      line_items: order.lineItems.nodes.map((item) => ({
        id: numericId(item.id),
        admin_graphql_api_id: item.id,
        title: item.title,
        quantity: item.quantity,
        sku: item.sku,
        variant_id: item.variant ? numericId(item.variant.id) : null,
        admin_graphql_api_variant_id: item.variant?.id ?? null,
        price: item.originalUnitPriceSet.shopMoney.amount,
      })),
    };

    const file = `fixtures/orders/${order.name.replace('#', '')}.json`;
    await writeFile(file, JSON.stringify(payload, null, 2));

    const total = `${payload.total_price} ${payload.currency}`;
    const items = payload.line_items.length;

    console.log(`${order.name} — ${total}, ${items} line item(s)`);
    console.log(`  financial:   ${payload.financial_status}`);
    console.log(`  fulfillment: ${payload.fulfillment_status}`);
    console.log(`  test order:  ${payload.test}`);
    console.log(`  -> ${file}\n`);
  }

  console.log('Drive the pipeline with: $env:FIXTURE="fixtures/orders/1001.json"');
}

main().catch(handleFatal);