import { createHash, randomBytes } from 'node:crypto';

const b64url = (b: Buffer) => b.toString('base64url');
export const randomToken = (bytes = 32): string => b64url(randomBytes(bytes));
export const challengeFor = (verifier: string): string => b64url(createHash('sha256').update(verifier).digest());

/** Only same-origin relative paths are allowed as post-login destinations (no open redirect). */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\r\n]/.test(value)) return '/employees';
  return value;
}
