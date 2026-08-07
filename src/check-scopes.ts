import { shopifyGraphQL } from './shopify.js';
import { handleFatal } from './exit.js';

const QUERY = `
  query CurrentScopes {
    currentAppInstallation {
      id
      accessScopes { handle }
    }
    shop { name myshopifyDomain }
  }
`;

async function main(): Promise<void> {
  const { body } = await shopifyGraphQL(QUERY);
  console.log(JSON.stringify(body, null, 2));
}

main().catch(handleFatal);