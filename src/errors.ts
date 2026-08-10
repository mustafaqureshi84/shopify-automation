export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ShopifyAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string | undefined
  ) {
    super(message);
    this.name = 'ShopifyAuthError';
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    public readonly detail?: unknown
  ) {
    super(message);
    this.name = 'ShopifyApiError';
  }
}