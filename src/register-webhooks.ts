import { mutate, requireData } from './mutations.js';
import { shopifyGraphQL } from './shopify.js';
import { assertScopes } from './preflight.js';
import { handleFatal } from './exit.js';
import { z } from 'zod';

const REQUIRED_SCOPES = ['read_products', 'read_orders'];

const LIST = `
  query WebhookSubscriptions {
    webhookSubscriptions(first: 50) {
      nodes {
        id
        topic
        endpoint {
          __typename
          ... on WebhookHttpEndpoint { callbackUrl }
        }
      }
    }
  }
`;

const CREATE = `
  mutation CreateWebhook(
    $topic: WebhookSubscriptionTopic!
    $subscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }
`;

const DELETE = `
  mutation DeleteWebhook($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`;

const ListSchema = z.object({
  data: z
    .object({
      webhookSubscriptions: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            topic: z.string(),
            endpoint: z.looseObject({
              __typename: z.string(),
              callbackUrl: z.string().optional(),
            }),
          })
        ),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

const CreateSchema = z.object({
  data: z
    .object({
      webhookSubscriptionCreate: z.object({
        webhookSubscription: z
          .object({ id: z.string(), topic: z.string() })
          .nullable(),
        userErrors: z.array(
          z.object({
            field: z.array(z.string()).nullable(),
            message: z.string(),
          })
        ),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

const DeleteSchema = z.object({
  data: z
    .object({
      webhookSubscriptionDelete: z.object({
        deletedWebhookSubscriptionId: z.string().nullable(),
        userErrors: z.array(
          z.object({
            field: z.array(z.string()).nullable(),
            message: z.string(),
          })
        ),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

/** Topics to subscribe. Start narrow — every topic is traffic to handle.
 *  ORDERS_CREATE requires protected customer data approval and is rejected
 *  without it, even with read_orders granted. */
const TOPICS = ['PRODUCTS_UPDATE'];

async function main(): Promise<void> {
  await assertScopes(REQUIRED_SCOPES);

  const base = process.env['TUNNEL_URL'];

  if (!base) {
    console.log('Set TUNNEL_URL to your public tunnel address:');
    console.log('  $env:TUNNEL_URL="https://xyz.trycloudflare.com"');
    console.log('\nListing current subscriptions only.\n');
  }

  const { body } = await shopifyGraphQL(LIST);
  const existing = requireData(ListSchema, body, 'webhookSubscriptions')
    .webhookSubscriptions.nodes;

  console.log(`Existing subscriptions: ${existing.length}`);
  for (const sub of existing) {
    console.log(`  ${sub.topic} -> ${sub.endpoint.callbackUrl ?? sub.endpoint.__typename}`);
  }

  if (!base) return;

  // The tunnel URL changes every restart, so stale subscriptions accumulate
  // and point at dead endpoints. Clear them before registering.
  if (existing.length > 0) {
    console.log('\nRemoving stale subscriptions...');
    for (const sub of existing) {
      const delBody = await mutate(DELETE, {
        mutationName: 'webhookSubscriptionDelete',
        idempotency: 'idempotent',
        variables: { id: sub.id },
      });
      requireData(DeleteSchema, delBody, 'webhookSubscriptionDelete');
      console.log(`  deleted ${sub.topic}`);
    }
  }

  console.log('\nRegistering...');

  for (const topic of TOPICS) {
    const createBody = await mutate(CREATE, {
      mutationName: 'webhookSubscriptionCreate',
      idempotency: 'not-idempotent',
      variables: {
        topic,
        subscription: {
          callbackUrl: `${base}/webhooks/${topic.toLowerCase().replace('_', '/')}`,
          format: 'JSON',
        },
      },
    });

    const created = requireData(
      CreateSchema,
      createBody,
      'webhookSubscriptionCreate'
    ).webhookSubscriptionCreate.webhookSubscription;

    console.log(`  ${created?.topic} -> ${base}`);
  }

  console.log('\nDone. Trigger an event and watch the server terminal.');
}

main().catch(handleFatal);