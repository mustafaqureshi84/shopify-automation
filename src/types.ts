import { z } from 'zod';

// ---------- Auth ----------

export const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
});

export type TokenResponse = z.infer<typeof TokenResponseSchema>;

// ---------- Rate limiting ----------

export const ThrottleStatusSchema = z.object({
  maximumAvailable: z.number(),
  currentlyAvailable: z.number(),
  restoreRate: z.number(),
});

export type ThrottleStatus = z.infer<typeof ThrottleStatusSchema>;

export const ThrottleEnvelopeSchema = z.object({
  extensions: z.object({
    cost: z.object({
      requestedQueryCost: z.number(),
      actualQueryCost: z.number().optional(),
      throttleStatus: ThrottleStatusSchema,
    }),
  }),
});

// ---------- Pagination ----------

export const PageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

// ---------- first-query.ts ----------

export const ProductNodeSchema = z.object({
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
        edges: z.array(z.object({ node: ProductNodeSchema })),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

export type ProductsResponse = z.infer<typeof ProductsResponseSchema>;

// ---------- async-patterns.ts ----------

export const ProductIdListSchema = z.object({
  data: z
    .object({
      products: z.object({
        edges: z.array(
          z.object({
            node: z.object({ id: z.string(), title: z.string() }),
          })
        ),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

export const ProductInventorySchema = z.object({
  data: z
    .object({
      product: z
        .object({
          title: z.string(),
          variants: z.object({
            edges: z.array(
              z.object({
                node: z.object({
                  sku: z.string().nullable(),
                  inventoryItem: z
                    .object({
                      inventoryLevels: z.object({
                        edges: z.array(
                          z.object({
                            node: z.object({
                              location: z.object({ name: z.string() }),
                              quantities: z.array(
                                z.object({
                                  name: z.string(),
                                  quantity: z.number(),
                                })
                              ),
                            }),
                          })
                        ),
                      }),
                    })
                    .nullable(),
                }),
              })
            ),
          }),
        })
        .nullable(),
    })
    .optional(),
  errors: z.unknown().optional(),
});

// ---------- export-products.ts ----------

export const ProductListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  handle: z.string(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT']),
  totalInventory: z.number().nullable(),
  variantsCount: z.object({ count: z.number() }).nullable().optional(),
});

export type ProductListItem = z.infer<typeof ProductListItemSchema>;

export const ProductsPageSchema = z.object({
  data: z
    .object({
      products: z.object({
        pageInfo: PageInfoSchema,
        nodes: z.array(ProductListItemSchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});