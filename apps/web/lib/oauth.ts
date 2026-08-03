import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const COOKIE_VERSION = "v1";

export const ZOO_OAUTH_SCOPE = "user:read modeling";

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (base64Url(decoded) !== value)
    throw new Error("Non-canonical base64url value");
  return decoded;
}

function encryptionKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(
    createHash("sha256").update(verifier, "ascii").digest(),
  );
  return { verifier, challenge };
}

export function createOAuthState(): string {
  return base64Url(randomBytes(24));
}

export function createOAuthHomeUrl(
  redirectUri: string,
  fallbackUrl: string,
): URL {
  return new URL("/", redirectUri.trim() || fallbackUrl);
}

export function sealCookie<T>(value: T, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    COOKIE_VERSION,
    base64Url(iv),
    base64Url(ciphertext),
    base64Url(tag),
  ].join(".");
}

export function openCookie<T>(
  value: string | undefined,
  secret: string,
): T | null {
  if (!value) return null;

  try {
    const [version, ivValue, ciphertextValue, tagValue] = value.split(".");
    if (version !== COOKIE_VERSION || !ivValue || !ciphertextValue || !tagValue)
      return null;

    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(secret),
      decodeBase64Url(ivValue),
    );
    decipher.setAuthTag(decodeBase64Url(tagValue));
    const plaintext = Buffer.concat([
      decipher.update(decodeBase64Url(ciphertextValue)),
      decipher.final(),
    ]);

    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    return null;
  }
}
