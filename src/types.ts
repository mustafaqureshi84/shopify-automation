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

// ---------- Mutations ----------

/**
 * `code` exists on some mutations' error types but not others.
 * productCreate and productDelete return plain UserError (field + message
 * only). Requesting `code` where it doesn't exist fails at query validation.
 */
export const UserErrorSchema = z.object({
  field: z.array(z.string()).nullable(),
  message: z.string(),
  code: z.string().nullable().optional(),
});

export type UserError = z.infer<typeof UserErrorSchema>;

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

// ---------- metafields.ts ----------

export const MetafieldDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  namespace: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  type: z.object({ name: z.string() }),
  ownerType: z.string(),
});

export type MetafieldDefinition = z.infer<typeof MetafieldDefinitionSchema>;

export const DefinitionCreateResponseSchema = z.object({
  data: z
    .object({
      metafieldDefinitionCreate: z.object({
        createdDefinition: MetafieldDefinitionSchema.nullable(),
        userErrors: z.array(UserErrorSchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

export const DefinitionListResponseSchema = z.object({
  data: z
    .object({
      metafieldDefinitions: z.object({
        nodes: z.array(MetafieldDefinitionSchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

export const MetafieldValueSchema = z.object({
  id: z.string(),
  namespace: z.string(),
  key: z.string(),
  value: z.string(),
  type: z.string(),
  updatedAt: z.string(),
});

export type MetafieldValue = z.infer<typeof MetafieldValueSchema>;

export const MetafieldsSetResponseSchema = z.object({
  data: z
    .object({
      metafieldsSet: z.object({
        metafields: z.array(MetafieldValueSchema),
        userErrors: z.array(UserErrorSchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

export const ProductWithMetafieldsSchema = z.object({
  id: z.string(),
  title: z.string(),
  metafields: z.object({
    nodes: z.array(MetafieldValueSchema),
  }),
});

export type ProductWithMetafields = z.infer<typeof ProductWithMetafieldsSchema>;

export const ProductsWithMetafieldsPageSchema = z.object({
  data: z
    .object({
      products: z.object({
        pageInfo: PageInfoSchema,
        nodes: z.array(ProductWithMetafieldsSchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

// ---------- generate-products.ts ----------

/**
 * productSet creates the product, its options, and its fully-specified
 * variants in one atomic call. productCreate followed by
 * productVariantsBulkCreate leaves an orphan when the second call fails.
 */
export const ProductSetResponseSchema = z.object({
  data: z
    .object({
      productSet: z.object({
        product: z
          .object({
            id: z.string(),
            handle: z.string(),
            title: z.string(),
            variants: z.object({
              nodes: z.array(
                z.object({ id: z.string(), sku: z.string().nullable() })
              ),
            }),
          })
          .nullable(),
        userErrors: z.array(UserErrorSchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

// ---------- teardown-products.ts ----------

export const ProductDeleteResponseSchema = z.object({
  data: z
    .object({
      productDelete: z.object({
        deletedProductId: z.string().nullable(),
        userErrors: z.array(UserErrorSchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

export const GeneratedProductSchema = z.object({
  id: z.string(),
  handle: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
});

export type GeneratedProduct = z.infer<typeof GeneratedProductSchema>;

export const GeneratedProductsPageSchema = z.object({
  data: z
    .object({
      products: z.object({
        pageInfo: PageInfoSchema,
        nodes: z.array(GeneratedProductSchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

// ---------- bulk-export.ts ----------

export const BulkOperationSchema = z.object({
  id: z.string(),
  status: z.enum([
    'CREATED',
    'RUNNING',
    'COMPLETED',
    'CANCELING',
    'CANCELED',
    'FAILED',
    'EXPIRED',
  ]),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  objectCount: z.string(),
  fileSize: z.string().nullable(),
  url: z.string().nullable(),
  partialDataUrl: z.string().nullable(),
});

export type BulkOperation = z.infer<typeof BulkOperationSchema>;

export const BulkRunQueryResponseSchema = z.object({
  data: z
    .object({
      bulkOperationRunQuery: z.object({
        bulkOperation: BulkOperationSchema.nullable(),
        userErrors: z.array(UserErrorSchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

export const CurrentBulkOperationResponseSchema = z.object({
  data: z
    .object({
      currentBulkOperation: BulkOperationSchema.nullable(),
    })
    .optional(),
  errors: z.unknown().optional(),
});

export const BulkCancelResponseSchema = z.object({
  data: z
    .object({
      bulkOperationCancel: z.object({
        bulkOperation: BulkOperationSchema.nullable(),
        userErrors: z.array(UserErrorSchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

/** A JSONL line: any object, always with `id`, sometimes with `__parentId`. */
export const BulkLineSchema = z.looseObject({
  id: z.string(),
  __parentId: z.string().optional(),
});

export type BulkLine = z.infer<typeof BulkLineSchema>;

// ---------- populate-inventory.ts ----------

export const InventoryItemRefSchema = z.object({
  id: z.string(),
  sku: z.string().nullable(),
  inventoryItem: z.object({ id: z.string(), tracked: z.boolean() }),
  product: z.object({ id: z.string(), tags: z.array(z.string()) }),
});

export type InventoryItemRef = z.infer<typeof InventoryItemRefSchema>;

export const VariantInventoryItemsPageSchema = z.object({
  data: z
    .object({
      productVariants: z.object({
        pageInfo: PageInfoSchema,
        nodes: z.array(InventoryItemRefSchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

/**
 * inventoryActivate takes a single locationId, not an array, and requires
 * an @idempotent directive with a caller-supplied key. Shopify deduplicates
 * on that key, so a replayed call is a no-op rather than a second write.
 *
 * Note: this mutation's payload has no `userErrors` field — requesting one
 * fails at query validation.
 */
export const InventoryActivateResponseSchema = z.object({
  data: z
    .object({
      inventoryActivate: z.object({
        inventoryLevel: z
          .object({
            id: z.string(),
            item: z.object({ id: z.string() }),
            location: z.object({ id: z.string() }),
          })
          .nullable(),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});

/**
 * inventorySetQuantities replaces absolute values rather than adjusting
 * deltas, which makes it idempotent — the same payload twice produces the
 * same end state. inventoryAdjustQuantities is the delta variant and is not.
 */
export const InventorySetQuantitiesResponseSchema = z.object({
  data: z
    .object({
      inventorySetQuantities: z.object({
        inventoryAdjustmentGroup: z
          .object({
            createdAt: z.string(),
            reason: z.string().nullable(),
            changes: z.array(
              z.object({
                name: z.string(),
                delta: z.number(),
              })
            ),
          })
          .nullable(),
        userErrors: z.array(UserErrorSchema),
      }),
    })
    .optional(),
  errors: z.unknown().optional(),
});