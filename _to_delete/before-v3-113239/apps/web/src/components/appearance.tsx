'use client';
import { useEffect, useState } from 'react';
import { Icon } from './icons';

type Theme = 'light' | 'dark' | 'system';
const ACCENTS: Array<[key: string, label: string, color: string]> = [
  ['indigo', 'Indigo', '#4f46e5'], ['violet', 'Violet', '#7c3aed'], ['sky', 'Sky', '#0284c7'], ['emerald', 'Emerald', '#059669'],
  ['amber', 'Amber', '#d97706'], ['rose', 'Rose', '#e11d48'], ['slate', 'Slate', '#475569'],
];
const root = () => document.documentElement;
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable: setting just won't persist */ } };
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
function applyTheme(t: Theme) { root().dataset.theme = t === 'system' ? (systemDark() ? 'dark' : 'light') : t; }

/** Theme (light / dark / system) and accent colour, remembered per browser. */
export function Appearance() {
  const [theme, setTheme] = useState<Theme>('system');
  const [accent, setAccent] = useState('indigo');
  useEffect(() => {
    const t = (read('ht-theme') as Theme | null) ?? 'system';
    setTheme(t); setAccent(read('ht-accent') ?? 'indigo');
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if ((read('ht-theme') ?? 'system') === 'system') applyTheme('system'); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const pickTheme = (t: Theme) => { setTheme(t); store('ht-theme', t); applyTheme(t); };
  const pickAccent = (a: string) => { setAccent(a); store('ht-accent', a); if (a === 'indigo') delete root().dataset.accent; else root().dataset.accent = a; };
  const opts: Array<[Theme, string, string]> = [['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'System', 'monitor']];
  return (
    <details className="menu">
      <summary className="icon-btn" aria-label="Appearance"><Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor'} /></summary>
      <div className="menu-pop">
        <div className="pop-title">Theme</div>
        <div className="seg" role="radiogroup" aria-label="Theme">
          {opts.map(([k, l, ic]) => (
            <button key={k} type="button" role="radio" aria-checked={theme === k} className={theme === k ? 'on' : ''} onClick={() => pickTheme(k)}><Icon name={ic} />{l}</button>
          ))}
        </div>
        <div className="pop-title">Accent colour</div>
        <div className="swatches" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map(([k, l, c]) => (
            <button key={k} type="button" role="radio" aria-checked={accent === k} aria-label={l} title={l} className={accent === k ? 'on' : ''} style={{ background: c }} onClick={() => pickAccent(k)}>{accent === k && <Icon name="check" />}</button>
          ))}
        </div>
      </div>
    </details>
  );
}

/** Collapses the sidebar to an icon rail (desktop). */
export function SidebarToggle() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(root().dataset.side === 'collapsed'); }, []);
  const toggle = () => {
    const next = !collapsed; setCollapsed(next);
    if (next) root().dataset.side = 'collapsed'; else delete root().dataset.side;
    store('ht-side', next ? 'collapsed' : 'open');
  };
  return <button type="button" className="icon-btn collapse-btn" onClick={toggle} aria-pressed={collapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><Icon name="panel" /></button>;
}
