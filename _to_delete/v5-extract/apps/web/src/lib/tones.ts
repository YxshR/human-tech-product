/** Pill colours for statuses shared by several pages. */
export type Tone = 'ok' | 'warn' | 'bad' | undefined;
export const runTone = (s: string): Tone => (s === 'approved' || s === 'locked' || s === 'payslips_generated' ? 'ok' : s === 'rejected' || s === 'cancelled' ? 'bad' : s === 'under_review' ? 'warn' : undefined);
export const importTone = (s: string): Tone => (s === 'completed' ? 'ok' : s === 'failed' || s === 'cancelled' ? 'bad' : s === 'needs_confirmation' || s === 'completed_with_errors' ? 'warn' : undefined);
