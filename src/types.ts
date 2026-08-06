import { z } from 'zod';

export const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
});

export type TokenResponse = z.infer<typeof TokenResponseSchema>;


export const ProductNodeSchema = z.object ({
  id: z.string(),
  title: z.string(),
  variants: z.object({
    edges: z.array(
        z.object({
            node: z.object({
                sku: z.string().nullable(),
                inventoryQuantity: z.number().nullable(),
            }),
        })
    ),
  }),
});

export type ProductNode = z.infer<typeof ProductNodeSchema>;

export const ProductsResponseSchema = z.object({
    data: z
    .object({
        products: z.object({
        edges: z.array(z.object({ node: ProductNodeSchema})),
    }),
  })
  .optional(),
  errors: z.unknown().optional(),
});

export type ProductsResponse = z.infer<typeof ProductsResponseSchema>;