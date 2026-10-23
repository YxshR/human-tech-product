'use client';
import { useEffect, useRef } from 'react';
import { Icon } from './icons';

/** Filters the rows of the table that follows it, as you type. Works on what is already on the page. */
export function TableFilter({ placeholder = 'Filter this list…' }: { placeholder?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const run = (v: string) => {
    const table = box.current?.nextElementSibling?.querySelector('table') ?? box.current?.parentElement?.querySelector('table');
    if (!table) return;
    const q = v.trim().toLowerCase();
    table.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((tr) => { if (tr.querySelector('td[colspan]')) return; tr.hidden = !!q && !(tr.textContent ?? '').toLowerCase().includes(q); });
  };
  useEffect(() => () => run(''), []);
  return (
    <div className="tablefilter" ref={box}>
      <Icon name="search" size={16} />
      <input type="search" placeholder={placeholder} aria-label={placeholder} onChange={(e) => run(e.target.value)} />
    </div>
  );
}
