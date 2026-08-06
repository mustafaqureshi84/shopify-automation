export interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

export interface ProductNode {
  id: string;
  title: string;
  variants: {
    edges: Array<{
      node: { sku: string | null; inventoryQuantity: number | null };
    }>;
  };
}

export interface ProductsResponse {
  data?: {
    products: {
      edges: Array<{ node: ProductNode }>;
    };
  };
  errors?: unknown;
}