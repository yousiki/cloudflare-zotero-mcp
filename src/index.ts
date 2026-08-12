import { WorkerEntrypoint } from 'cloudflare:workers';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { type AuthProps, authorizationHandler } from './auth/handler.js';
import { ALL_SCOPES, SCOPE_READ } from './context.js';
import type { Env } from './env.js';
import { buildContext, semanticIndex, syncBatchLimit, textCache, zoteroClient } from './env.js';
import { syncVectorIndex } from './jobs/vectorize-sync.js';
import { createServer } from './server.js';

/**
 * The MCP endpoint. OAuthProvider has already validated the bearer token by the
 * time this runs and hands us the grant's props.
 */
class ZoteroMcpApi extends WorkerEntrypoint<Env, AuthProps> {
  override async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props ?? { userId: 'owner', scopes: [SCOPE_READ] };
    const scopes = props.scopes?.length ? props.scopes : [SCOPE_READ];

    const handler = createMcpHandler(() => createServer(buildContext(this.env, scopes)));
    return handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: props.userId,
        scopes,
      },
    });
  }
}

const provider = new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: ZoteroMcpApi,
  defaultHandler: authorizationHandler,

  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  // Deprecated in the 2026-07-28 spec but still the only path some clients have.
  clientRegistrationEndpoint: '/oauth/register',
  // Client ID Metadata Documents: the spec's preferred replacement for DCR.
  clientIdMetadataDocumentEnabled: true,

  scopesSupported: [...ALL_SCOPES],
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => provider.fetch(request, env, ctx),

  /** Keeps the semantic index in step with the library. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      syncVectorIndex({
        zotero: zoteroClient(env),
        index: semanticIndex(env),
        store: textCache(env),
        limit: syncBatchLimit(env),
      })
        .then((report) => console.log('vectorize sync:', report.message))
        .catch((error) => console.error('vectorize sync failed:', error)),
    );
  },
} satisfies ExportedHandler<Env>;

export { ZoteroMcpApi };
