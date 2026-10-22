/**
 * Turns a submitted HTML form into the JSON body the API expects.
 * Field names look like `type:path`:  s:  text (empty is left out)   z:  text, empty becomes null   n: number   i: list of whole numbers   b: true/false
 *                                      l:  list (comma or new line)   j: JSON   d: date/decimal text (same as s)   t: date and time, taken as India time
 *                                      a:  'all' or a list of ids (every repeated value is collected; empty or `all` means `all`)
 * Repeated `l:` fields are collected into one list (multi-select).
 * `path` may be dotted (`changes.phone`) to build nested objects. Names starting with `_` are controls for the action, not data.
 */
export function buildBody(entries: Iterable<[string, unknown]>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const unsafe = (k: string) => k === '__proto__' || k === 'constructor' || k === 'prototype';
  const put = (path: string, value: unknown) => {
    const keys = path.split('.');
    if (keys.some(unsafe)) return;
    let at: Record<string, unknown> | unknown[] = body;
    keys.forEach((k, i) => {
      const slot = Array.isArray(at) ? Number(k) : k;
      if (i === keys.length - 1) { (at as Record<string, unknown>)[slot as string] = value; return; }
      const wantsArray = /^\d+$/.test(keys[i + 1]!);
      let next = (at as Record<string, unknown>)[slot as string];
      if (typeof next !== 'object' || next === null) { next = wantsArray ? [] : {}; (at as Record<string, unknown>)[slot as string] = next; }
      at = next as Record<string, unknown> | unknown[];
    });
  };
  const lists = new Map<string, string[]>(); const scopes = new Map<string, string[]>();
  for (const [name, raw] of entries) {
    if (name.startsWith('_') || typeof raw !== 'string') continue;
    const m = /^([a-z]):(.+)$/.exec(name);
    const type = m ? m[1]! : 's'; const path = m ? m[2]! : name;
    const v = raw.trim();
    switch (type) {
      case 's': case 'd': if (v !== '') put(path, v); break;
      case 'z': put(path, v === '' ? null : v); break;
      case 't': if (v !== '') { if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) throw new FormError(path, 'expected a date and time'); put(path, `${v}:00+05:30`); } break;   // India time
      case 'n': if (v !== '') { const n = Number(v); if (!Number.isFinite(n)) throw new FormError(path, 'expected a number'); put(path, n); } break;
      case 'b': if (v === 'true' || v === 'on') put(path, true); else if (v === 'false') put(path, false); break;
      case 'l': { const items = v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean); if (items.length) { const prev = lists.get(path) ?? []; prev.push(...items); lists.set(path, prev); put(path, prev); } break; }
      case 'i': { const items = v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean).map(Number); if (items.some((x) => !Number.isInteger(x))) throw new FormError(path, 'expected whole numbers'); if (items.length) { const prev = (lists.get(path) ?? []) as unknown as number[]; prev.push(...items); lists.set(path, prev as unknown as string[]); put(path, prev); } break; }
      case 'a': { const prev = scopes.get(path) ?? []; if (v) prev.push(v); scopes.set(path, prev); put(path, prev.length === 0 || prev.includes('all') ? 'all' : prev); break; }
      case 'j': if (v !== '') { try { put(path, JSON.parse(v)); } catch { throw new FormError(path, 'expected valid JSON'); } } break;
      default: throw new FormError(path, `unknown field type "${type}"`);
    }
  }
  return prune(body) as Record<string, unknown>;
}

/**
 * Table-style rows (`components.3.…`): every row carries a hidden `_row`, and is kept only when its `_on` box was ticked.
 * Neither marker is sent to the API.
 */
function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((r) => !(isObj(r) && '_row' in r && !('_on' in r))).map((r) => prune(r));
  if (isObj(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== '_on' && k !== '_row') o[k] = prune(x);
    return o;
  }
  return v;
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class FormError extends Error {
  constructor(public path: string, message: string) { super(message); }
}

/** Only same-app relative paths may be used as redirect targets. */
export function safePath(p: unknown, fallback = '/'): string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//') || p.includes('\\') || /[\r\n]/.test(p)) return fallback;
  return p;
}
/** API paths a form may call: absolute path on the API, no traversal, no scheme tricks. */
export function safeApiPath(p: unknown): string | null {
  if (typeof p !== 'string' || !/^\/[A-Za-z0-9_\-/.?=&%:,]*$/.test(p) || p.startsWith('//') || p.includes('..')) return null;
  return p;
}
export function withParam(path: string, key: string, value: string): string {
  const [base, hash] = path.split('#');
  const [p, qs = ''] = base!.split('?');
  const sp = new URLSearchParams(qs); sp.delete('ok'); sp.delete('error'); sp.set(key, value);
  return `${p}?${sp.toString()}${hash ? `#${hash}` : ''}`;
}
