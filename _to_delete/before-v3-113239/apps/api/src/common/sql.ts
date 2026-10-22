/** Builds `SET a=$3, b=$4` from a column->value map. Column names come from code, never from the client. */
export function setClause(changes: Record<string, unknown>, startAt: number): { sql: string; params: unknown[] } {
  const entries = Object.entries(changes).filter(([, v]) => v !== undefined);
  if (entries.length === 0) throw new Error('empty update');
  return {
    sql: entries.map(([col], i) => `${col} = $${startAt + i}`).join(', '),
    params: entries.map(([, v]) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v)),
  };
}

/** Escape LIKE wildcards in user search text. */
export const likePattern = (s: string): string => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
