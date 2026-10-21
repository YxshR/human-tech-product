import { describe, expect, it } from 'vitest';
import { challengeFor, randomToken, safeReturnTo } from '../src/lib/pkce';

describe('pkce', () => {
  it('matches the RFC 7636 example', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('mints unguessable, url-safe tokens', () => {
    const a = randomToken(), b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('safeReturnTo (open-redirect guard)', () => {
  it.each(['/employees', '/employees/abc?x=1'])('allows %s', (p) => expect(safeReturnTo(p)).toBe(p));
  it.each(['//evil.test', 'https://evil.test', '/\\evil.test', 'javascript:alert(1)', '/a\r\nSet-Cookie: x=1', '', null, undefined])('blocks %j', (p) =>
    expect(safeReturnTo(p as string | null)).toBe('/employees'));
});
