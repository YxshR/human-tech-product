'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from './icons';
import type { NavGroup, QuickAction } from '@/lib/nav-items';

interface Entry { key: string; group: string; label: string; hint?: string; icon: IconName; href: string }
interface Found { employees: Array<{ id: string; name: string; number: string; status: string }>; candidates: Array<{ id: string; name: string; code: string; stage: string }> }

/** Cmd/Ctrl+K: jump to any page you may open, run a common action, or find an employee/candidate by name. */
export function CommandPalette({ open, onClose, groups, actions }: { open: boolean; onClose: () => void; groups: NavGroup[]; actions: QuickAction[] }) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [found, setFound] = useState<Found | null>(null);

  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) { d.showModal(); setQ(''); setSel(0); setFound(null); setTimeout(() => input.current?.focus(), 0); }
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setFound(null); return; }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try { const r = await fetch(`/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal, headers: { accept: 'application/json' } }); if (r.ok) setFound((await r.json()) as Found); } catch { /* typing continues; ignore aborted/failed lookups */ }
    }, 180);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);

  const entries = useMemo<Entry[]>(() => {
    const term = q.trim().toLowerCase();
    const pages: Entry[] = groups.flatMap((g) => g.items.map((i) => ({ key: `p:${i.href}`, group: 'Go to', label: i.label, hint: i.hint ?? g.title, icon: i.icon, href: i.href })));
    const acts: Entry[] = actions.map((a) => ({ key: `a:${a.href}`, group: 'Quick actions', label: a.label, icon: a.icon, href: a.href }));
    const match = (e: Entry) => !term || `${e.label} ${e.hint ?? ''}`.toLowerCase().includes(term);
    const people: Entry[] = (found?.employees ?? []).map((e) => ({ key: `e:${e.id}`, group: 'Employees', label: e.name, hint: `${e.number} · ${e.status.replace(/_/g, ' ')}`, icon: 'user', href: `/employees/${e.id}` }));
    const cands: Entry[] = (found?.candidates ?? []).map((c) => ({ key: `c:${c.id}`, group: 'Candidates', label: c.name, hint: `${c.code} · ${c.stage.replace(/_/g, ' ')}`, icon: 'briefcase', href: `/recruitment/candidates/${c.id}` }));
    return [...people, ...cands, ...(term ? [] : acts), ...pages.filter(match)].slice(0, 40);
  }, [q, groups, actions, found]);

  useEffect(() => { setSel(0); }, [q, found]);
  useEffect(() => { document.getElementById(`pal-${sel}`)?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const go = (e: Entry | undefined) => { if (!e) return; onClose(); router.push(e.href); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(entries.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(entries[sel]); }
  };

  let last = '';
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }} aria-label="Command palette">
      <div className="palette" onKeyDown={onKey}>
        <div className="palette-input">
          <Icon name="search" size={20} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages, actions, people…" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="pal-list" autoComplete="off" spellCheck={false} />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" id="pal-list" role="listbox">
          {entries.length === 0 && <div className="palette-empty">{q.trim().length >= 2 ? 'Nothing found. Try a name, an employee number or a page.' : 'Nothing matches.'}</div>}
          {entries.map((e, i) => {
            const head = e.group !== last ? <div className="palette-group" key={`g-${e.group}`}>{e.group}</div> : null; last = e.group;
            return (
              <div key={e.key}>
                {head}
                <div id={`pal-${i}`} role="option" aria-selected={i === sel} className="palette-item" onMouseMove={() => setSel(i)} onClick={() => go(e)}>
                  <Icon name={e.icon} /><span>{e.label}</span>{e.hint && <small>{e.hint}</small>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span><span style={{ marginLeft: 'auto' }}>Press <kbd>/</kbd> anywhere to search</span></div>
      </div>
    </dialog>
  );
}
