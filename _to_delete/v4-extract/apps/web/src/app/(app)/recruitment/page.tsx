import { CANDIDATE_STAGES, JOB_STATUSES, CLIENT_STATUSES, type CandidateView, type ClientView, type JobView } from '@humantech/contracts';
import { can, load, loadPaged, options, type PageProps } from '@/lib/data';
import { ActionForm, Card, Empty, Page, Pager, Pill, Table, Tabs, humanize } from '@/components/ui';

export const metadata = { title: 'Recruitment' };

export default async function Recruitment({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tabs: Array<[string, string]> = [['candidates', 'Candidates'], ['jobs', 'Job requirements'], ['clients', 'Clients']];
  const tab = tabs.some(([k]) => k === sp.tab) ? sp.tab! : 'candidates';
  return (
    <Page title="Recruitment" sub="Candidates, jobs and clients" sp={sp}>
      <Tabs base="/recruitment" current={tab} items={tabs} />
      {tab === 'candidates' && <Candidates sp={sp} />}
      {tab === 'jobs' && <Jobs back="/recruitment?tab=jobs" />}
      {tab === 'clients' && <Clients back="/recruitment?tab=clients" />}
    </Page>
  );
}

async function Candidates({ sp }: { sp: Record<string, string | undefined> }) {
  const stage = CANDIDATE_STAGES.find((s) => s === sp.stage);
  const show = sp.show === 'archived' || sp.show === 'followup' ? sp.show : 'active';
  const q = { tab: 'candidates', q: sp.q, stage, show: show === 'active' ? undefined : show, archived: show === 'archived' ? 'true' : undefined, followUpDue: show === 'followup' ? 'true' : undefined };
  const res = await loadPaged<CandidateView>('/candidates', { q: sp.q, stage, archived: q.archived, followUpDue: q.followUpDue, cursor: sp.cursor, limit: '25' });
  const create = await can('candidate.create');
  const jobs = create ? ((await load<JobView[]>('/job-requirements', { status: 'open' })) ?? []) : [];
  const clients = create ? ((await load<ClientView[]>('/clients')) ?? []) : [];
  if (res === null) return <Empty>You do not have access to candidates.</Empty>;
  return (
    <>
      <form className="row card" role="search" style={{ marginBottom: 16 }}>
        <input type="hidden" name="tab" value="candidates" />
        <label>Search<input name="q" defaultValue={sp.q} placeholder="Name, email, phone or code" /></label>
        <label>Stage<select name="stage" defaultValue={stage ?? ''}><option value="">All</option>{CANDIDATE_STAGES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select></label>
        <label>Show<select name="show" defaultValue={show}><option value="active">Active</option><option value="followup">Follow-up due</option><option value="archived">Archived</option></select></label>
        <button className="btn">Filter</button>
      </form>
      <Card wide>
        <Table rows={res.rows} cols={[
          { h: 'Code', c: (c) => c.candidateCode }, { h: 'Name', c: (c) => <a href={`/recruitment/candidates/${c.id}`}>{c.firstName} {c.lastName ?? ''}</a> }, { h: 'Role', c: (c) => c.roleTitle ?? '—' },
          { h: 'Contact', c: (c) => c.email ?? c.phone ?? '—' }, { h: 'Stage', c: (c) => <Pill tone={c.stage === 'joined' ? 'ok' : c.stage === 'rejected' || c.stage === 'withdrawn' ? 'bad' : undefined}>{humanize(c.stage)}</Pill> },
        ]} empty="No candidates found." />
      </Card>
      <Pager base="/recruitment" query={{ tab: 'candidates', q: sp.q, stage, show: q.show }} nextCursor={res.next} />
      {create && (
        <Card title="Add a candidate">
          <ActionForm path="/candidates" back="/recruitment?tab=candidates" then="/recruitment/candidates/{id}" ok="Candidate added" button="Add candidate" fields={[
            { name: 's:firstName', label: 'First name', required: true }, { name: 's:lastName', label: 'Last name' }, { name: 's:email', label: 'Email', kind: 'email' }, { name: 's:phone', label: 'Phone', kind: 'tel', hint: 'Email or phone is required' },
            { name: 's:city', label: 'City' }, { name: 's:source', label: 'Source' }, { name: 's:roleTitle', label: 'Role' },
            { name: 'z:jobRequirementId', label: 'Job requirement', kind: 'select', options: jobs.map((j) => [j.id, `${j.code} · ${j.title}`]) },
            { name: 'z:clientId', label: 'Client', kind: 'select', options: options(clients.filter((c) => c.status === 'active'), (c) => c.id, (c) => c.name) },
            { name: 'n:totalExperienceMonths', label: 'Total experience (months)', kind: 'number', min: 0 }, { name: 'n:noticePeriodDays', label: 'Notice period (days)', kind: 'number', min: 0 },
          ]} />
        </Card>
      )}
    </>
  );
}

async function Jobs({ back }: { back: string }) {
  const rows = await load<JobView[]>('/job-requirements');
  const clients = (await load<ClientView[]>('/clients')) ?? [];
  const manage = await can('recruitment.manage');
  if (rows === null) return <Empty>You do not have access.</Empty>;
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Code', c: (j) => j.code }, { h: 'Title', c: (j) => j.title }, { h: 'Client', c: (j) => clients.find((c) => c.id === j.clientId)?.name ?? '—' }, { h: 'Location', c: (j) => j.location ?? '—' },
          { h: 'Filled', right: true, c: (j) => `${j.filled} / ${j.openings}` }, { h: 'Status', c: (j) => <Pill tone={j.status === 'open' ? 'ok' : undefined}>{humanize(j.status)}</Pill> },
          { h: '', c: (j) => manage && (
            <ActionForm inline method="PATCH" path={`/job-requirements/${j.id}`} back={back} ok="Job updated" button="Set" fields={[{ name: 's:status', label: 'Status', kind: 'select', required: true, value: j.status, options: JOB_STATUSES.map((s) => [s, humanize(s)]) }]} />
          ) },
        ]} empty="No job requirements yet." />
      </Card>
      {manage && (
        <Card title="Add a job requirement">
          <ActionForm path="/job-requirements" back={back} ok="Job added" button="Add job" fields={[
            { name: 's:code', label: 'Code', required: true }, { name: 's:title', label: 'Title', required: true }, { name: 's:location', label: 'Location' }, { name: 'n:openings', label: 'Openings', kind: 'number', value: 1, min: 1 },
            { name: 'z:clientId', label: 'Client', kind: 'select', options: options(clients.filter((c) => c.status === 'active'), (c) => c.id, (c) => c.name) },
          ]} />
        </Card>
      )}
    </>
  );
}

async function Clients({ back }: { back: string }) {
  const rows = await load<ClientView[]>('/clients');
  const manage = await can('recruitment.manage');
  if (rows === null) return <Empty>You do not have access.</Empty>;
  const c = (r: ClientView, k: string) => String((r.contact as Record<string, unknown>)[k] ?? '—');
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Code', c: (r) => r.code }, { h: 'Name', c: (r) => r.name }, { h: 'Contact', c: (r) => `${c(r, 'name')} · ${c(r, 'email')}` }, { h: 'Status', c: (r) => <Pill tone={r.status === 'active' ? 'ok' : undefined}>{r.status}</Pill> },
          { h: '', c: (r) => manage && (
            <ActionForm inline method="PATCH" path={`/clients/${r.id}`} back={back} ok="Client updated" button="Set" fields={[{ name: 's:status', label: 'Status', kind: 'select', required: true, value: r.status, options: CLIENT_STATUSES.map((s) => [s, humanize(s)]) }]} />
          ) },
        ]} empty="No clients yet." />
      </Card>
      {manage && (
        <Card title="Add a client">
          <ActionForm path="/clients" back={back} ok="Client added" button="Add client" fields={[
            { name: 's:code', label: 'Code', required: true }, { name: 's:name', label: 'Name', required: true },
            { name: 's:contact.name', label: 'Contact person' }, { name: 's:contact.email', label: 'Contact email', kind: 'email' }, { name: 's:contact.phone', label: 'Contact phone', kind: 'tel' },
          ]} />
        </Card>
      )}
    </>
  );
}
