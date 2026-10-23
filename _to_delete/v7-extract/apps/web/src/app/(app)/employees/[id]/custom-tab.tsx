import type { CustomFieldView } from '@humantech/contracts';
import { can, load } from '@/lib/data';
import { ActionForm, Card, Empty, KV, type FieldSpec } from '@/components/ui';

type Row = CustomFieldView & { value: unknown };

/** The company's own extra fields for an employee or candidate. */
export async function CustomTab({ kind, id, back }: { kind: 'employees' | 'candidates'; id: string; back: string }) {
  const rows = await load<Row[]>(`/${kind}/${id}/custom-values`);
  const edit = await can(kind === 'employees' ? 'employee.update' : 'candidate.update');
  if (rows === null) return <Empty>You do not have access to these fields.</Empty>;
  const active = rows.filter((r) => r.active);
  if (rows.length === 0) return <Card><Empty>Your company has not defined any custom fields. Admins can add them in Settings.</Empty></Card>;
  const spec = (r: Row): FieldSpec => {
    const base = { label: r.label, required: false, hint: r.required ? 'Required' : undefined };
    const v = r.value;
    switch (r.valueType) {
      case 'long_text': return { ...base, name: `z:values.${r.internalKey}`, kind: 'textarea', value: (v as string) ?? '' };
      case 'number': return { ...base, name: `n:values.${r.internalKey}`, kind: 'number', step: 'any', value: v === null ? '' : (v as number) };
      case 'date': return { ...base, name: `z:values.${r.internalKey}`, kind: 'date', value: (v as string) ?? '' };
      case 'email': return { ...base, name: `z:values.${r.internalKey}`, kind: 'email', value: (v as string) ?? '' };
      case 'phone': return { ...base, name: `z:values.${r.internalKey}`, kind: 'tel', value: (v as string) ?? '' };
      case 'url': return { ...base, name: `z:values.${r.internalKey}`, kind: 'url', value: (v as string) ?? '' };
      case 'checkbox': return { ...base, name: `b:values.${r.internalKey}`, kind: 'checkbox', value: v === true };
      case 'single_select': return { ...base, name: `z:values.${r.internalKey}`, kind: 'select', options: r.options.map((o) => [o, o]), value: (v as string) ?? '' };
      case 'multi_select': return { ...base, name: `l:values.${r.internalKey}`, kind: 'multiselect', options: r.options.map((o) => [o, o]), value: Array.isArray(v) ? (v as string[]) : [] };
      default: return { ...base, name: `z:values.${r.internalKey}`, value: (v as string) ?? '' };
    }
  };
  const show = (r: Row) => (r.value === null || r.value === undefined || r.value === '' ? '—' : Array.isArray(r.value) ? r.value.join(', ') : r.value === true ? 'Yes' : r.value === false ? 'No' : String(r.value));
  return (
    <Card title="Custom fields">
      {edit && active.length > 0
        ? <ActionForm method="PUT" path={`/${kind}/${id}/custom-values`} back={back} ok="Saved" button="Save" fields={active.map(spec)} />
        : <KV items={rows.map((r) => [r.label, show(r)] as [string, string])} />}
    </Card>
  );
}
