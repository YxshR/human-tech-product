import { describe, expect, it } from 'vitest';
import { FormError, buildBody, safeApiPath, safePath, withParam } from '../src/lib/form-body';

const body = (e: Array<[string, string]>) => buildBody(e);

describe('buildBody', () => {
  it('types fields by prefix and leaves empty text out', () => {
    expect(body([['s:name', ' Asha '], ['s:blank', ''], ['n:days', '1.5'], ['n:none', ''], ['b:on', 'true'], ['z:clear', ''], ['z:keep', 'x'], ['d:when', '2026-01-02']]))
      .toEqual({ name: 'Asha', days: 1.5, on: true, clear: null, keep: 'x', when: '2026-01-02' });
  });
  it('reads date-times as India time', () => {
    expect(body([['t:dueAt', '2026-11-02T10:00'], ['t:none', '']])).toEqual({ dueAt: '2026-11-02T10:00:00+05:30' });
    expect(() => body([['t:dueAt', 'tomorrow']])).toThrow(FormError);
  });
  it('builds nested objects and lists', () => {
    expect(body([['s:address.city', 'Pune'], ['s:address.line1', 'MG Road'], ['l:roleKeys', 'a'], ['l:roleKeys', 'b, c']])).toEqual({ address: { city: 'Pune', line1: 'MG Road' }, roleKeys: ['a', 'b', 'c'] });
    expect(body([['j:cfg', '{"a":1}']])).toEqual({ cfg: { a: 1 } });
  });
  it('whole-number lists for multi-selects', () => {
    expect(body([['i:days', '0'], ['i:days', '6']])).toEqual({ days: [0, 6] });
    expect(() => body([['i:days', '1.5']])).toThrow('whole numbers');
  });
  it('checkbox pairs: the later value wins', () => {
    expect(body([['b:x', 'false'], ['b:x', 'true']])).toEqual({ x: true });
    expect(body([['b:x', 'false']])).toEqual({ x: false });
  });
  it('scope: nothing or "all" means all, otherwise the list', () => {
    expect(body([])).toEqual({});
    expect(body([['a:scope', '']])).toEqual({ scope: 'all' });
    expect(body([['a:scope', 'all']])).toEqual({ scope: 'all' });
    expect(body([['a:scope', 'b1'], ['a:scope', 'b2']])).toEqual({ scope: ['b1', 'b2'] });
  });
  it('table rows are kept only when ticked, and the tick is not sent', () => {
    expect(body([['s:components.0._row', '1'], ['s:components.0._on', 'on'], ['s:components.0.componentVersionId', 'v1'], ['s:components.0.amount', '100'],
      ['s:components.1._row', '1'], ['s:components.1.componentVersionId', 'v2'], ['s:components.1.amount', '5'],
      ['s:components.2._row', '1'], ['s:components.2._on', 'on'], ['s:components.2.componentVersionId', 'v3'], ['n:components.2.displayOrder', '3']]))
      .toEqual({ components: [{ componentVersionId: 'v1', amount: '100' }, { componentVersionId: 'v3', displayOrder: 3 }] });
    expect(body([['s:rows.0._row', '1'], ['s:rows.0.id', 'x']])).toEqual({ rows: [] });          // nothing ticked, nothing sent
  });
  it('ignores control fields and cannot pollute prototypes', () => {
    const b = body([['_path', '/x'], ['s:__proto__.polluted', 'yes'], ['s:a.constructor.b', 'x'], ['s:ok', '1']]);
    expect(b).toEqual({ ok: '1' }); expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('rejects non-numbers and bad JSON with the field name', () => {
    expect(() => body([['n:days', 'abc']])).toThrow(FormError);
    expect(() => body([['j:x', '{']])).toThrow('valid JSON');
    expect(() => body([['q:x', '1']])).toThrow('unknown field type');
  });
});

describe('paths', () => {
  it('only same-app paths are redirect targets', () => {
    expect(safePath('/leave?tab=a')).toBe('/leave?tab=a');
    for (const bad of ['//evil.test', 'https://evil.test', '/\\x', '/a\r\nb', null, 5]) expect(safePath(bad, '/home')).toBe('/home');
  });
  it('only plain API paths can be called from a form', () => {
    expect(safeApiPath('/leave/requests/abc-123/approve')).toBe('/leave/requests/abc-123/approve');
    expect(safeApiPath('/org/cost-centres')).toBe('/org/cost-centres');
    for (const bad of ['//evil', 'http://evil', '/a/../b', '/a b', '/a\n', '', 'noslash', null]) expect(safeApiPath(bad)).toBeNull();
  });
  it('withParam replaces earlier messages and keeps other query values', () => {
    expect(withParam('/org?tab=holidays&ok=old', 'ok', 'Saved')).toBe('/org?tab=holidays&ok=Saved');
    expect(withParam('/org?error=x', 'error', 'A b')).toBe('/org?error=A+b');
  });
});
