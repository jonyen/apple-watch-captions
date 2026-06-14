
/**
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
