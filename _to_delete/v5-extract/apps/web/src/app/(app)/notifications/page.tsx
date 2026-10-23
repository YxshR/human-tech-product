import { NOTIFICATION_EVENTS, type NotificationView, type PreferenceView } from '@humantech/contracts';
import { api } from '@/lib/api';
import { load, type Paged, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, Empty, Page, Pager, Pill, fmtDateTime, humanize } from '@/components/ui';

export const metadata = { title: 'Notifications' };

export default async function Notifications({ searchParams }: PageProps) {
  const sp = await searchParams;
  const unread = sp.unread === 'true' ? 'true' : undefined;
  const res = await api<Paged<NotificationView> & { unread: number }>('/me/notifications', { query: { unread, cursor: sp.cursor, limit: '25' } }).catch(() => null);
  const prefs = (await load<PreferenceView[]>('/me/notification-preferences')) ?? [];
  const back = `/notifications${unread ? '?unread=true' : ''}`;
  return (
    <Page title="Notifications" sub={res ? `${res.unread} unread` : undefined} sp={sp}
      actions={<><a className="btn" href={unread ? '/notifications' : '/notifications?unread=true'}>{unread ? 'Show all' : 'Only unread'}</a><ActionButton path="/me/notifications/read-all" back={back} ok="All marked as read" button="Mark all read" /></>}>
      {res === null ? <Empty>Notifications are not available.</Empty> : res.data.length === 0 ? <Empty>You are all caught up.</Empty> : (
        <Card wide>
          <ul className="plain-list">
            {res.data.map((n) => (
              <li key={n.id}>
                <strong>{n.title}</strong> {!n.readAt && <Pill tone="warn">new</Pill>}
                {n.body && <div>{n.body}</div>}
                <div className="muted">{fmtDateTime(n.createdAt)}{!n.readAt && <ActionButton path={`/me/notifications/${n.id}/read`} back={back} button="Mark read" />}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {res && <Pager base="/notifications" query={{ unread }} nextCursor={res.page?.nextCursor ?? null} />}
      <Card title="What reaches you" wide>
        {NOTIFICATION_EVENTS.map((key) => {
          const p = prefs.find((x) => x.eventKey === key) ?? { eventKey: key, inAppEnabled: true, emailEnabled: false };
          return (
            <ActionForm key={key} inline method="PUT" path={`/me/notification-preferences/${key}`} back="/notifications" ok="Preference saved" button="Save" fields={[
              { name: 'b:inAppEnabled', label: `${humanize(key.replace('.', ' '))}: in the app`, kind: 'checkbox', value: p.inAppEnabled }, { name: 'b:emailEnabled', label: 'by email', kind: 'checkbox', value: p.emailEnabled },
            ]} />
          );
        })}
      </Card>
    </Page>
  );
}
