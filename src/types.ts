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

export const CostSchema = z.object({
  requestedQueryCost: z.number(),
  actualQueryCost: z.number().nullable().optional(),
  throttleStatus: ThrottleStatusSchema,
});

export type Cost = z.infer<typeof CostSchema>;

export const ThrottleEnvelopeSchema = z.object({
  extensions: z.object({ cost: CostSchema }),
});

/** GraphQL errors arrive with HTTP 200, so they need their own schema. */
export const GraphQLErrorSchema = z.object({
  message: z.string(),
  extensions: z
    .object({
      code: z.string().optional(),
      documentation: z.string().optional(),
    })
    .nullable()
    .optional(),
});

export const GraphQLErrorEnvelopeSchema = z.object({
  errors: z.array(GraphQLErrorSchema).optional(),
  extensions: z.object({ cost: CostSchema }).optional(),
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

// ---------- inventory-report.ts ----------

export const LocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  shipsInventory: z.boolean(),
  fulfillsOnlineOrders: z.boolean(),
});

export type Location = z.infer<typeof LocationSchema>;

export const LocationsPageSchema = z.object({
  data: z
    .object({
      locations: z.object({
        pageInfo: PageInfoSchema,
        nodes: z.array(LocationSchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

export const InventoryQuantitySchema = z.object({
  name: z.string(),
  quantity: z.number(),
});

export const InventoryLevelSchema = z.object({
  id: z.string(),
  location: z.object({ id: z.string(), name: z.string() }),
  quantities: z.array(InventoryQuantitySchema),
});

export const InventoryItemSchema = z.object({
  id: z.string(),
  tracked: z.boolean(),
  inventoryLevels: z.object({
    pageInfo: PageInfoSchema,
    nodes: z.array(InventoryLevelSchema),
  }),
});

export const VariantWithInventorySchema = z.object({
  id: z.string(),
  title: z.string(),
  sku: z.string().nullable(),
  inventoryQuantity: z.number().nullable(),
  inventoryItem: InventoryItemSchema.nullable(),
  product: z.object({
    id: z.string(),
    title: z.string(),
    status: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT']),
    totalInventory: z.number().nullable(),
  }),
});

export type VariantWithInventory = z.infer<typeof VariantWithInventorySchema>;

export const VariantsPageSchema = z.object({
  data: z
    .object({
      productVariants: z.object({
        pageInfo: PageInfoSchema,
        nodes: z.array(VariantWithInventorySchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});