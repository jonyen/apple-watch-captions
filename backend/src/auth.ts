import { IdentityStore, Principal } from "./identityStore";

/**
 * The token from an `Authorization: Bearer …` header, if there is one.
 *
 * Tokens moved out of the query string when they stopped being one shared
 * development secret and became a per-user credential: query strings are
 * recorded in access logs, proxy logs, and `Referer` headers.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

/** The principal a token belongs to, or null when it belongs to nobody. */
export function resolveToken(
  identity: IdentityStore,
  token: string | undefined,
): Principal | null {
  return identity.resolve(token);
}

/**
 * Superseded single-shared-secret check: every device used to present the
 * same `expected` token. Retained only until the routes in server.ts move to
 * `resolveToken`'s per-device tokens (Task 6), at which point this and its
 * tests should be deleted.
 *
 * Returns true only when a non-empty expected token is configured
 * and the provided token matches it exactly.
 */
export function verifyToken(
  provided: string | undefined,
  expected: string,
): boolean {
  if (!expected) return false;
  return provided === expected;
}
