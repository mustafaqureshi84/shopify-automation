import 'dotenv/config';

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
        `Check your .env file at the project root.`
    );
  }

  return value;
}

export const SHOP = requireEnv('SHOP_DOMAIN');
export const CLIENT_ID = requireEnv('SHOPIFY_CLIENT_ID');
export const CLIENT_SECRET = requireEnv('SHOPIFY_CLIENT_SECRET');
export const API_VERSION = '2026-07';