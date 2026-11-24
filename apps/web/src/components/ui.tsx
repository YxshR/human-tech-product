import Link from 'next/link';
import type { ReactNode } from 'react';
import { submit, upload } from '@/lib/actions';
import { Icon, type IconName } from './icons';
import { Toast } from './toast';
import { SubmitButton } from './submit-button';
import { TableFilter } from './table-filter';

export { TableFilter };

export type Tone = 'ok' | 'warn' | 'bad' | 'info';

/** Flash message from ?ok= / ?error= (set by the shared server action). Errors stay on the page until the person acts. */
export function Flash({ sp }: { sp: { ok?: string; error?: string } }) {
  if (sp.error) return <div className="flash err" role="alert"><Icon name="alert" size={18} /><div><strong>That did not go through</strong><span>{sp.error}</span></div></div>;
  if (sp.ok) return <Toast message={sp.ok} />;
  return null;
}

/**
 * Standard page frame: where you are (back link), what this page is (title), what it is for (sub), and what you can do (actions).
 * Every page should pass `sub` so nobody has to guess what a screen is for.
 */
export function Page({ title, sub, actions, sp, children, back, lead }: {
  title: string; sub?: ReactNode; actions?: ReactNode; sp?: { ok?: string; error?: string }; children: ReactNode;
  back?: { href: string; label: string }; lead?: ReactNode;
}) {
  return (
    <>
      <div className="topbar">
        <div>
          {back && <Link className="backlink" href={back.href}><Icon name="chevronLeft" size={14} />{back.label}</Link>}
          <div className="title-row">{lead}<div><h1>{title}</h1>{sub && <p className="sub">{sub}</p>}</div></div>
        </div>
        {actions && <div className="row page-actions">{actions}</div>}
      </div>
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

/** A titled panel. `desc` is one plain sentence saying what the panel is for; `action` sits at the top right. */
export const Card = ({ title, desc, action, children, wide, tone }: { title?: string; desc?: ReactNode; action?: ReactNode; children: ReactNode; wide?: boolean; tone?: 'danger' }) => (
  <section className={`card ${tone === 'danger' ? 'danger-zone' : ''}`} style={wide ? undefined : { maxWidth: 760 }}>
    {(title || action) && (desc || action
      ? <div className="card-head"><div>{title && <h2>{title}</h2>}{desc && <p>{desc}</p>}</div>{action}</div>
      : <h2>{title}</h2>)}
    {children}
  </section>
);

/** Shown when a list has nothing in it. Say why and, where possible, offer the next step through `action`. */
export const Empty = ({ children = 'Nothing here yet.', icon = 'inbox', title, action }: { children?: ReactNode; icon?: IconName; title?: string; action?: ReactNode }) => (
  <div className="empty"><div className="ico"><Icon name={icon} size={24} /></div>{title && <strong>{title}</strong>}<div>{children}</div>{action && <div className="row">{action}</div>}</div>
);

/** The same polite message everywhere a person's role does not allow a screen or a section. */
export const NoAccess = ({ what = 'this page' }: { what?: string }) => (
  <Empty icon="lock" title="You do not have access">Your role does not include {what}. A company administrator can change what your role allows in Users &amp; roles.</Empty>
);

/** A short plain-language explanation next to the thing it explains. */
export function Callout({ tone = 'info', title, children, icon }: { tone?: Tone | 'plain'; title?: string; children?: ReactNode; icon?: IconName }) {
  const ico: IconName = icon ?? (tone === 'ok' ? 'check' : tone === 'warn' || tone === 'bad' ? 'alert' : 'info');
  return <div className={`callout ${tone === 'info' ? '' : tone}`} role={tone === 'bad' ? 'alert' : 'note'}><Icon name={ico} size={18} /><div>{title && <strong>{title}</strong>}{children}</div></div>;
}

/** Round initials badge. */
export const Avatar = ({ name, size, soft }: { name: string; size?: 'sm' | 'lg'; soft?: boolean }) => (
  <span className={`avatar ${size ?? ''} ${soft ? 'soft' : ''}`} aria-hidden="true">{name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?'}</span>
);

/** A row of headline numbers. Each can link somewhere. */
export function StatGrid({ items }: { items: Array<{ label: string; value: ReactNode; sub?: ReactNode; icon: IconName; tone?: Tone; href?: string }> }) {
  return (
    <div className="stats">
      {items.map((s) => {
        const body = <><span className={`stat-ico ${s.tone ?? ''}`}><Icon name={s.icon} size={20} /></span><div><div className="stat-lbl">{s.label}</div><div className="stat-val">{s.value}</div>{s.sub && <div className="stat-sub">{s.sub}</div>}</div></>;
        return s.href ? <Link key={s.label} href={s.href} className="stat-card">{body}</Link> : <div key={s.label} className="stat-card">{body}</div>;
      })}
    </div>
  );
}

/** Compact number tiles for a summary (days present, totals…). */
export function Tiles({ items }: { items: Array<{ label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'strong' }> }) {
  return <div className="tiles">{items.map((t) => <div key={t.label} className={`tile ${t.tone ?? ''}`}><b>{t.value}</b><span>{t.label}</span></div>)}</div>;
}

/** A labelled usage bar: "8 of 10 employees". */
export function Meter({ label, used, limit }: { label: string; used: number; limit?: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="meter">
      <div className="meter-top"><span>{label}</span><b>{used}{limit ? ` of ${limit}` : ''}</b></div>
      {limit ? <div className={`progress ${pct >= 90 ? 'warn' : ''}`} role="img" aria-label={`${pct}% used`}><i style={{ width: `${pct}%` }} /></div> : <span className="hint">No limit on your plan</span>}
    </div>
  );
}

/** One colour language for every status in the app, so "pending" is always amber and "approved" is always green. */
const TONES: Record<string, Tone> = {};
const tones = (tone: Tone, words: string) => words.split(' ').forEach((w) => { TONES[w] = tone; });
tones('ok', 'active approved verified paid done completed present accepted locked payslips_generated on issued resolved work_from_home hired joined yes fulfilled new');
tones('warn', 'pending pending_verification under_review in_progress probation on_notice needs_confirmation completed_with_errors not_yet not_marked half_day trial trialing suspended not_active overdue notice_period clearance settlement_pending past_due');
tones('bad', 'rejected failed absent revoked expired terminated');
tones('info', 'onboarding draft processing calculated submitted scheduled invited open leave holiday weekly_off validated uploaded received');
export const statusTone = (s: string | null | undefined): Tone | undefined => (s ? TONES[s.trim().toLowerCase().replace(/[\s-]+/g, '_')] : undefined);

/** Status chip. Pass a status word and it picks the colour and tidies the wording; pass `tone` to override. */
export const Pill = ({ children, tone, tag }: { children: ReactNode; tone?: Tone; tag?: boolean }) => {
  const text = typeof children === 'string' ? children : null;
  return <span className={`pill ${tone ?? (tag ? '' : statusTone(text)) ?? ''} ${tag ? 'tag' : ''}`}>{text !== null ? humanize(text) : children}</span>;
};

/** `work_from_home` / `currentAddress` → "Work from home" / "Current address". */
export const humanize = (s: string | null | undefined) => {
  if (!s) return '—';
  const t = s.replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`).replace(/[_.]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
export const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—');
export const fmtDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
/** "2026-11" → "November 2026". */
export const fmtMonth = (m: string) => { const [y, mo] = m.split('-').map(Number); return y && mo ? new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : m; };
export function inr(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const [i = '0', f] = String(v).split('.'); const neg = i.startsWith('-'); const d = neg ? i.slice(1) : i;
  const last3 = d.slice(-3); const rest = d.slice(0, -3);
  return `${neg ? '-' : ''}₹${rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : ''}${last3}${f ? `.${f}` : ''}`;
}

/** Data table. A column with an empty heading is the row's actions column (right-aligned, compact buttons). */
export function Table<T>({ rows, cols, empty, caption, foot }: { rows: T[]; cols: Array<{ h: string; c: (r: T) => ReactNode; right?: boolean }>; empty?: ReactNode; caption?: string; foot?: ReactNode }) {
  const cls = (c: { h: string; right?: boolean }) => (c.h === '' ? 'cell-actions' : c.right ? 'num' : undefined);
  return (
    <div className="scroll">
      <table>
        {caption && <caption className="sr">{caption}</caption>}
        <thead><tr>{cols.map((c, i) => <th key={c.h || `a${i}`} className={c.right ? 'num' : undefined} scope="col">{c.h || <span className="sr">Actions</span>}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{cols.map((c, j) => <td key={c.h || `a${j}`} className={cls(c)}>{c.c(r)}</td>)}</tr>)}
          {rows.length === 0 && <tr><td colSpan={cols.length}>{typeof empty === 'string' || empty === undefined ? <Empty>{empty ?? 'Nothing to show.'}</Empty> : empty}</td></tr>}
        </tbody>
        {foot && rows.length > 0 && <tfoot>{foot}</tfoot>}
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
const Req = () => <span className="req" aria-hidden="true">*</span>;

/**
 * One labelled control. The label wraps its control, so no ids are needed: the same field can appear in many rows of a table
 * without a click on one row's label reaching another row's input.
 */
function Field({ f }: { f: FieldSpec }) {
  const hint = f.hint && <span className="hint">{f.hint}</span>;
  if (f.kind === 'checkbox') {
    return (
      <label className="check full">
        <input type="hidden" name={f.name} value="false" /><input type="checkbox" name={f.name} value="true" defaultChecked={f.value === true} />
        <span>{f.label}{hint}</span>
      </label>
    );
  }
  if (f.kind === 'multiselect') {
    const chosen = new Set(Array.isArray(f.value) ? f.value : []);
    const opts = f.options ?? [];
    return (
      <fieldset className="field full">
        <legend>{f.label}{f.required && <Req />}</legend>
        {opts.length === 0 ? <span className="hint">Nothing to choose from yet.</span> : (
          <div className="checks">{opts.map(([v, l]) => <label key={v}><input type="checkbox" name={f.name} value={v} defaultChecked={chosen.has(v)} />{l}</label>)}</div>
        )}
        {hint}
      </fieldset>
    );
  }
  const common = { name: f.name, required: f.required };
  let control: ReactNode;
  if (f.kind === 'textarea') control = <textarea {...common} defaultValue={String(f.value ?? '')} rows={3} maxLength={f.maxLength ?? 4000} placeholder={f.placeholder} />;
  else if (f.kind === 'select') {
    const opts = f.options ?? [];
    const has = !(f.value === null || f.value === undefined || f.value === '');
    // A required choice is never pre-picked silently (unless there is only one): the person must choose it deliberately.
    const only = f.required && !has && opts.length === 1 ? opts[0]![0] : undefined;
    control = (
      <select {...common} defaultValue={has ? String(f.value) : only ?? ''}>
        {f.required ? (!has && only === undefined && <option value="" disabled>{opts.length ? 'Choose…' : 'Nothing to choose yet'}</option>) : <option value="">{f.placeholder ?? '— None —'}</option>}
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    );
  } else control = <input type={f.kind ?? 'text'} {...common} defaultValue={f.value === null || f.value === undefined ? '' : String(f.value)} step={f.step} min={f.min} max={f.max} maxLength={f.maxLength} placeholder={f.placeholder} />;
  return <label className={f.kind === 'textarea' ? 'full' : undefined}><span>{f.label}{f.required && <Req />}</span>{control}{hint}</label>;
}
export function Fields({ fields }: { fields: FieldSpec[] }) {
  return <>{fields.map((f) => <Field key={f.name} f={f} />)}</>;
}

/** A form that calls the API through the shared server action. Hidden inputs say what to call and where to return. */
export function ActionForm({ path, method = 'POST', back, ok, then, fields, button, tone, children, inline, confirm, values, cols }: {
  path: string; method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; back: string; ok?: string; then?: string; fields?: FieldSpec[]; button: string; tone?: 'primary' | 'danger';
  children?: ReactNode; inline?: boolean; confirm?: string; values?: Record<string, string>; cols?: boolean;
}) {
  // Longer forms lay out in two columns; short ones stay in a single readable column.
  const two = cols ?? (!inline && (fields ?? []).filter((f) => f.kind !== 'checkbox' && f.kind !== 'textarea' && f.kind !== 'multiselect').length >= 4);
  // The main button of a full form is the page's primary action unless told otherwise.
  const btnTone = tone ?? (inline ? undefined : 'primary');
  return (
    <form action={submit} className={inline ? 'row inline-form' : `form ${two ? 'cols' : ''}`}>
      <input type="hidden" name="_path" value={path} /><input type="hidden" name="_method" value={method} /><input type="hidden" name="_back" value={back} />
      {ok && <input type="hidden" name="_ok" value={ok} />}{then && <input type="hidden" name="_then" value={then} />}
      {Object.entries(values ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {fields && <Fields fields={fields} />}
      {children}
      <SubmitButton tone={btnTone} confirm={confirm}>{button}</SubmitButton>
    </form>
  );
}
/** Single-button action (approve, activate…) that sends no fields. */
export const ActionButton = (p: { path: string; method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; back: string; ok?: string; button: string; tone?: 'primary' | 'danger'; then?: string; values?: Record<string, string>; confirm?: string }) => <ActionForm {...p} inline />;

export function UploadForm({ path, back, ok, accept, type, button = 'Upload', then, method, label = 'File' }: { path: string; back: string; ok?: string; accept?: string; type?: string; button?: string; then?: string; method?: string; label?: string }) {
  return (
    <form action={upload} className="form">
      <input type="hidden" name="_path" value={path} /><input type="hidden" name="_back" value={back} />
      {ok && <input type="hidden" name="_ok" value={ok} />}{type && <input type="hidden" name="_type" value={type} />}{then && <input type="hidden" name="_then" value={then} />}{method && <input type="hidden" name="_method" value={method} />}
      <label><span>{label}<Req /></span><input type="file" name="file" accept={accept} required /></label>
      <SubmitButton tone="primary">{button}</SubmitButton>
    </form>
  );
}

export const Details = ({ summary, children }: { summary: string; children: ReactNode }) => <details className="more"><summary>{summary}</summary><div>{children}</div></details>;
export function KV({ items }: { items: Array<[string, ReactNode]> }) {
  return <dl className="kv">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}
/** Lists are read a page at a time. `started` (a cursor is in the address) offers a way back to the first page. */
export function Pager({ base, query, nextCursor, started }: { base: string; query: Record<string, string | undefined>; nextCursor: string | null; started?: boolean }) {
  if (!nextCursor && !started) return null;
  const q = Object.fromEntries(Object.entries(query).filter(([, v]) => v)) as Record<string, string>;
  return (
    <nav className="pager" aria-label="Pages">
      {started && <Link className="btn sm" href={{ pathname: base, query: q }}><Icon name="chevronLeft" size={14} />First page</Link>}
      {nextCursor ? <Link className="btn sm" href={{ pathname: base, query: { ...q, cursor: nextCursor } }}>Next page<Icon name="chevronRight" size={14} /></Link> : <span className="muted">End of the list</span>}
    </nav>
  );
}
