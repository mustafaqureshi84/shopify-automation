import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import 'dotenv/config';
import { ConfigError } from './errors.js';
import { handleFatal } from './exit.js';

const URL = process.env['WEBHOOK_URL'] ?? 'http://localhost:3000';
const TOPIC = process.env['TOPIC'] ?? 'orders/create';
const MODE = process.env['MODE'] ?? 'valid';
const FIXTURE = process.env['FIXTURE'];

const secret = process.env['SHOPIFY_CLIENT_SECRET'];

if (!secret) {
  throw new ConfigError('Missing SHOPIFY_CLIENT_SECRET');
}

/**
 * Real payloads captured by fetch-orders.ts, or a minimal synthetic one.
 * Using real fixtures means the handler parses exactly what Shopify sends,
 * including fields nobody thought to include in a hand-written stub.
 */
const payload = FIXTURE
  ? await readFile(FIXTURE, 'utf8')
  : JSON.stringify({
      id: 1234567890,
      admin_graphql_api_id: 'gid://shopify/Order/1234567890',
      name: '#TEST',
      total_price: '750.00',
      test: true,
    });

function sign(body: string, key: string): string {
  return createHmac('sha256', key).update(body, 'utf8').digest('base64');
}

async function main(): Promise<void> {
  let hmac: string | null;

  switch (MODE) {
    case 'valid':
      hmac = sign(payload, secret!);
      break;
    case 'wrong-secret':
      // A forged request: signature present and well-formed, but computed
      // with a key the sender doesn't actually have.
      hmac = sign(payload, 'not-the-real-secret');
      break;
    case 'tampered':
      // Signed correctly, then the body was modified in transit.
      hmac = sign(payload, secret!);
      break;
    case 'missing':
      hmac = null;
      break;
    default:
      throw new Error(`Unknown MODE: ${MODE}`);
  }

  const body =
    MODE === 'tampered' ? payload.replace(/"total_price": *"[^"]*"/, '"total_price":"0.01"') : payload;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Shopify-Topic': TOPIC,
    'X-Shopify-Shop-Domain': process.env['SHOP_DOMAIN'] ?? 'test.myshopify.com',
    'X-Shopify-Webhook-Id': `test-${Date.now()}`,
    'X-Shopify-Triggered-At': new Date().toISOString(),
  };

  if (hmac) headers['X-Shopify-Hmac-Sha256'] = hmac;

  console.log(`Mode:    ${MODE}`);
  console.log(`Topic:   ${TOPIC}`);
  console.log(`Fixture: ${FIXTURE ?? '(synthetic)'}`);
  console.log(`URL:     ${URL}/webhooks/${TOPIC}\n`);

  const res = await fetch(`${URL}/webhooks/${TOPIC}`, {
    method: 'POST',
    headers,
    body,
  });

  console.log(`Response: ${res.status} ${res.statusText}`);
  console.log(await res.text());
}

main().catch(handleFatal);