import Link from 'next/link';
import type { ReactNode } from 'react';
import { submit, upload } from '@/lib/actions';
import { Icon } from './icons';

/** Flash message from ?ok= / ?error= (set by the shared server action). */
export function Flash({ sp }: { sp: { ok?: string; error?: string } }) {
  if (sp.error) return <p className="flash err" role="alert">{sp.error}</p>;
  if (sp.ok) return <p className="flash ok" role="status">{sp.ok}</p>;
  return null;
}

const HUES = [239, 262, 199, 160, 340, 25, 280, 190];
/** Initials avatar with a stable colour per name. */
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const parts = name.trim().split(/\s+/);
  const initials = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase();
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = HUES[h % HUES.length]!;
  return <span className={`avatar ${size}`} style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 70% 48%))` }} aria-hidden="true">{initials}</span>;
}

export function Page({ title, sub, actions, sp, avatar, children }: { title: string; sub?: ReactNode; actions?: ReactNode; sp?: { ok?: string; error?: string }; avatar?: ReactNode; children: ReactNode }) {
  return (
    <>
      {title && <div className="topbar"><div className="topbar-lead">{avatar}<div><h1>{title}</h1>{sub && <p className="muted">{sub}</p>}</div></div><div className="row">{actions}</div></div>}
      {sp && <Flash sp={sp} />}
      {children}
    </>
  );
}

export function Tabs({ base, current, items }: { base: string; current: string; items: Array<[key: string, label: string]> }) {
  return (
    <nav className="tabs" aria-label="Sections">
      {items.map(([k, l]) => <Link key={k} href={`${base}${base.includes('?') ? '&' : '?'}tab=${k}`} aria-current={k === current ? 'page' : undefined}>{l}</Link>)}
    </nav>
  );
}

export const Card = ({ title, children, wide }: { title?: string; children: ReactNode; wide?: boolean }) => (
  <section className="card" style={{ marginBottom: 16, ...(wide ? {} : { maxWidth: 760 }) }}>{title && <h2>{title}</h2>}{children}</section>
);

export const Empty = ({ children = 'Nothing here yet.' }: { children?: ReactNode }) => <div className="empty"><Icon name="inbox" /><div>{children}</div></div>;

/** KPI tile; pass href to make it a link. */
export function Stat({ label, value, icon, tone, href }: { label: string; value: ReactNode; icon: string; tone?: 'ok' | 'warn'; href?: string }) {
  const body = (
    <>
      <span className={`stat-ico ${tone ?? ''}`}><Icon name={icon} /></span>
      <span><span className="stat-label">{label}</span><br /><span className="stat-val">{value}</span></span>
    </>
  );
  return href ? <Link href={href} className="stat-card">{body}</Link> : <div className="stat-card">{body}</div>;
}
export const Pill = ({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) => <span className={`pill ${tone ?? ''}`}>{children}</span>;
export const humanize = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : '—');
export const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—');
export const fmtDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
export function inr(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const [i = '0', f] = String(v).split('.'); const neg = i.startsWith('-'); const d = neg ? i.slice(1) : i;
  const last3 = d.slice(-3); const rest = d.slice(0, -3);
  return `${neg ? '-' : ''}₹${rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : ''}${last3}${f ? `.${f}` : ''}`;
}

export function Table<T>({ rows, cols, empty, caption }: { rows: T[]; cols: Array<{ h: string; c: (r: T) => ReactNode; right?: boolean }>; empty?: string; caption?: string }) {
  return (
    <div className="scroll">
      <table>
        {caption && <caption className="sr">{caption}</caption>}
        <thead><tr>{cols.map((c) => <th key={c.h} style={c.right ? { textAlign: 'right' } : undefined}>{c.h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.h} style={c.right ? { textAlign: 'right' } : undefined}>{c.c(r)}</td>)}</tr>)}
          {rows.length === 0 && <tr><td colSpan={cols.length} className="muted">{empty ?? 'Nothing to show.'}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export interface FieldSpec {
  name: string;              // `type:path` (see lib/form-body.ts)
  label: string;
  kind?: 'multiselect' | 'text' | 'number' | 'date' | 'email' | 'password' | 'textarea' | 'select' | 'checkbox' | 'time' | 'datetime-local' | 'month' | 'tel' | 'url';
  options?: Array<[value: string, label: string]>;
  value?: string | number | boolean | string[] | null;
  required?: boolean;
  hint?: string;
  step?: string;
  min?: string | number;
  max?: string | number;
  maxLength?: number;
  placeholder?: string;
}
function Input({ f }: { f: FieldSpec }) {
  const common = { name: f.name, required: f.required, id: f.name };
  if (f.kind === 'textarea') return <textarea {...common} defaultValue={String(f.value ?? '')} rows={3} maxLength={f.maxLength ?? 4000} placeholder={f.placeholder} />;
  if (f.kind === 'multiselect') {
    const chosen = new Set(Array.isArray(f.value) ? f.value : []);
    return <select {...common} multiple defaultValue={[...chosen]} size={Math.min(6, (f.options ?? []).length || 2)}>{(f.options ?? []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
  }
  if (f.kind === 'select') {
    return (
      <select {...common} defaultValue={f.value === null || f.value === undefined ? '' : String(f.value)}>
        {!f.required && <option value="">—</option>}
        {(f.options ?? []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    );
  }
  if (f.kind === 'checkbox') return <><input type="hidden" name={f.name} value="false" /><input type="checkbox" {...common} value="true" defaultChecked={f.value === true} style={{ width: 20, height: 20 }} /></>;
  return <input type={f.kind ?? 'text'} {...common} defaultValue={f.value === null || f.value === undefined ? '' : String(f.value)} step={f.step} min={f.min} max={f.max} maxLength={f.maxLength} placeholder={f.placeholder} />;
}
export function Fields({ fields }: { fields: FieldSpec[] }) {
  return <>{fields.map((f) => <label key={f.name} htmlFor={f.name}>{f.label}{f.required ? ' *' : ''}<Input f={f} />{f.hint && <span className="muted hint">{f.hint}</span>}</label>)}</>;
}

/** A form that calls the API through the shared server action. Hidden inputs say what to call and where to return. */
export function ActionForm({ path, method = 'POST', back, ok, then, fields, button, tone, children, inline, confirm, values }: {
  path: string; method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; back: string; ok?: string; then?: string; fields?: FieldSpec[]; button: string; tone?: 'primary' | 'danger';
  children?: ReactNode; inline?: boolean; confirm?: string; values?: Record<string, string>;
}) {
  return (
    <form action={submit} className={inline ? 'row inline-form' : 'form'}>
      <input type="hidden" name="_path" value={path} /><input type="hidden" name="_method" value={method} /><input type="hidden" name="_back" value={back} />
      {ok && <input type="hidden" name="_ok" value={ok} />}{then && <input type="hidden" name="_then" value={then} />}
      {Object.entries(values ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {fields && <Fields fields={fields} />}
      {children}
      <button className={`btn ${tone ?? ''}`} {...(confirm ? { 'data-confirm': confirm } : {})}>{button}</button>
    </form>
  );
}
/** Single-button action (approve, activate…) that sends no fields. */
export const ActionButton = (p: { path: string; method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; back: string; ok?: string; button: string; tone?: 'primary' | 'danger'; then?: string; values?: Record<string, string>; confirm?: string }) => <ActionForm {...p} inline />;

export function UploadForm({ path, back, ok, accept, type, button = 'Upload', then, method }: { path: string; back: string; ok?: string; accept?: string; type?: string; button?: string; then?: string; method?: string }) {
  return (
    <form action={upload} className="row inline-form">
      <input type="hidden" name="_path" value={path} /><input type="hidden" name="_back" value={back} />
      {ok && <input type="hidden" name="_ok" value={ok} />}{type && <input type="hidden" name="_type" value={type} />}{then && <input type="hidden" name="_then" value={then} />}{method && <input type="hidden" name="_method" value={method} />}
      <label className="sr">File<input type="file" name="file" accept={accept} required /></label>
      <button className="btn">{button}</button>
    </form>
  );
}

export const Details = ({ summary, children }: { summary: string; children: ReactNode }) => <details className="more"><summary>{summary}</summary><div style={{ marginTop: 12 }}>{children}</div></details>;
export function KV({ items }: { items: Array<[string, ReactNode]> }) {
  return <dl className="kv">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}
export function Pager({ base, query, nextCursor }: { base: string; query: Record<string, string | undefined>; nextCursor: string | null }) {
  if (!nextCursor) return null;
  const q = Object.fromEntries(Object.entries(query).filter(([, v]) => v)) as Record<string, string>;
  return <p><Link className="btn" href={{ pathname: base, query: { ...q, cursor: nextCursor } }}>Next page →</Link></p>;
}
