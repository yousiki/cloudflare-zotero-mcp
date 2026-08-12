#!/usr/bin/env bun
/**
 * Runs the OAuth 2.1 authorization-code flow headlessly and prints an access
 * token, for MCP clients that want a plain bearer token instead of a browser
 * round trip (and for scripts/e2e.ts).
 *
 *   bun run scripts/get-token.ts https://zotero-mcp.example.workers.dev
 *   bun run scripts/get-token.ts https://... --out .token   # keeps it off stdout
 *
 * Reads the server password from ZOTERO_MCP_PASSWORD, or prompts for it.
 */

import { chmodSync } from 'node:fs';

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outPath = outFlag >= 0 ? args[outFlag + 1] : undefined;
const positional = args.filter(
  (argument, index) => !argument.startsWith('--') && index !== outFlag + 1,
);

const origin = positional[0]?.replace(/\/+$/, '');
if (!origin) {
  console.error('usage: bun run scripts/get-token.ts <server-origin> [--out <file>]');
  process.exit(2);
}

const password = await readPassword();
if (!password) {
  console.error(
    'No password given. Set ZOTERO_MCP_PASSWORD, pipe it in, or run this from a real terminal.',
  );
  process.exit(2);
}

/**
 * Prompting only works with a TTY, which agent harnesses and CI do not provide.
 * Fall back to stdin so `... | get-token.ts` works there.
 */
async function readPassword(): Promise<string> {
  if (process.env.ZOTERO_MCP_PASSWORD) return process.env.ZOTERO_MCP_PASSWORD;
  if (process.stdin.isTTY) return prompt('Server password: ') ?? '';
  return (await Bun.stdin.text()).trim();
}

const REDIRECT_URI = 'http://localhost:9998/callback';
const SCOPES = 'zotero:read zotero:write';

// 1. Register a client. DCR is deprecated in the 2026 spec but remains the only
//    self-service option for a script with no metadata document to publish.
const registration = await fetch(`${origin}/oauth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    client_name: 'zotero-mcp CLI',
    redirect_uris: [REDIRECT_URI],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPES,
  }),
});
if (!registration.ok) {
  console.error(
    `Client registration failed (${registration.status}): ${await registration.text()}`,
  );
  process.exit(1);
}
const client = (await registration.json()) as { client_id: string };

// 2. PKCE.
const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = base64Url(
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
);

const authorizeUrl = new URL(`${origin}/authorize`);
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('client_id', client.client_id);
authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authorizeUrl.searchParams.set('scope', SCOPES);
authorizeUrl.searchParams.set('state', base64Url(crypto.getRandomValues(new Uint8Array(12))));
authorizeUrl.searchParams.set('code_challenge', challenge);
authorizeUrl.searchParams.set('code_challenge_method', 'S256');
authorizeUrl.searchParams.set('resource', `${origin}/mcp`);

// 3. Approve, by posting the same form the login page would.
const form = new URLSearchParams({ password });
for (const scope of SCOPES.split(' ')) form.append('scope', scope);

const approval = await fetch(authorizeUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form,
  redirect: 'manual',
});
if (approval.status !== 302 && approval.status !== 303) {
  console.error(`Authorization failed (${approval.status}). Wrong password?`);
  process.exit(1);
}
const code = new URL(approval.headers.get('Location') as string).searchParams.get('code');
if (!code) {
  console.error('The server redirected without an authorization code.');
  process.exit(1);
}

// 4. Exchange the code.
const tokenResponse = await fetch(`${origin}/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: `${origin}/mcp`,
  }),
});
if (!tokenResponse.ok) {
  console.error(`Token exchange failed (${tokenResponse.status}): ${await tokenResponse.text()}`);
  process.exit(1);
}

const tokens = (await tokenResponse.json()) as {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};
if (outPath) {
  // Keeps the token out of stdout, shell history and terminal scrollback.
  await Bun.write(outPath, tokens.access_token);
  chmodSync(outPath, 0o600);
  console.log(`Access token written to ${outPath}`);
} else {
  console.log(tokens.access_token);
}
if (tokens.expires_in) {
  console.error(
    `(expires in ${tokens.expires_in}s; refresh token ${tokens.refresh_token ? 'issued' : 'not issued'})`,
  );
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
