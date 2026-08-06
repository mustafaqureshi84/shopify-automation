import 'dotenv/config';
import { ConfigError } from './errors.js';

export interface Config {
  shop: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;

  const missing: string[] = [];

  const read = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      missing.push(name);
      return '';
    }
    return value;
  };

  const config: Config = {
    shop: read('SHOP_DOMAIN'),
    clientId: read('SHOPIFY_CLIENT_ID'),
    clientSecret: read('SHOPIFY_CLIENT_SECRET'),
    apiVersion: '2026-07',
  };

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}\n` +
        'Check your .env file at the project root.'
    );
  }

  cached = config;
  return cached;
}