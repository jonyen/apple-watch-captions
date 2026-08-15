import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

/**
 * Authenticated encryption for the secrets in `export_destinations`.
 *
 * GCM rather than plain CBC because a tampered ciphertext must fail loudly:
 * these values are used to authenticate against someone else's account, and a
 * silently corrupted token would surface as a confusing 401 from Notion rather
 * than as the storage fault it is.
 */
const VERSION = "v1";
const IV_BYTES = 12;

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function open(sealed: string, key: Buffer): string {
  const parts = sealed.split(".");
  if (parts.length !== 4) throw new Error("sealed value is malformed");
  const [version, iv, tag, ciphertext] = parts as [string, string, string, string];
  if (version !== VERSION) throw new Error(`unknown sealed value version: ${version}`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Read the master key. Fails loudly rather than defaulting: a relay that
 * silently generated a key per boot would encrypt tokens it could never read
 * again, and the failure would look like every user spontaneously losing
 * their Notion connection.
 */
export function keyFromEnv(value: string | undefined): Buffer {
  if (!value) throw new Error("ENCRYPTION_KEY is required to store export secrets");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}
