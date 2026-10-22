'use client';
import { useEffect } from 'react';

/** Asks before any button marked data-confirm submits its form. Without JavaScript the action simply goes ahead after the server checks it. */
export function ConfirmGuard() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-confirm]');
      if (el && !window.confirm(el.dataset.confirm)) e.preventDefault();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
  return null;
}
