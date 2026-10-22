'use client';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';

/**
 * Asks before any button marked data-confirm submits its form, in a proper dialog rather than the browser's plain box.
 * Without JavaScript the action simply goes ahead after the server checks it.
 */
export function ConfirmGuard() {
  const ref = useRef<HTMLDialogElement>(null);
  const pending = useRef<HTMLButtonElement | null>(null);
  const approved = useRef(false);
  const [ask, setAsk] = useState<{ text: string; action: string; danger: boolean } | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-confirm]');
      if (!el) return;
      if (approved.current) { approved.current = false; return; }
      e.preventDefault();
      pending.current = el;
      setAsk({ text: el.dataset.confirm ?? 'Are you sure?', action: (el.textContent ?? 'Confirm').trim() || 'Confirm', danger: el.classList.contains('danger') });
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
  useEffect(() => { const d = ref.current; if (d && ask && !d.open) d.showModal(); }, [ask]);

  const close = () => { ref.current?.close(); setAsk(null); pending.current = null; };
  const yes = () => { const b = pending.current; approved.current = true; ref.current?.close(); setAsk(null); pending.current = null; b?.click(); };

  return (
    <dialog ref={ref} className="confirm" onClose={() => setAsk(null)} onClick={(e) => { if (e.target === ref.current) close(); }} aria-label="Please confirm">
      <div className="c-ico"><Icon name="alert" size={22} /></div>
      <h3>Please confirm</h3>
      <p>{ask?.text}</p>
      <div className="row">
        <button type="button" className="btn" onClick={close} autoFocus>Cancel</button>
        <button type="button" className={`btn ${ask?.danger ? 'danger' : 'primary'}`} onClick={yes}>{ask?.action}</button>
      </div>
    </dialog>
  );
}
