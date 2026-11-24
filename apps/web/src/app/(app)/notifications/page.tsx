import Link from 'next/link';
import { NOTIFICATION_EVENTS, type NotificationView, type PreferenceView } from '@humantech/contracts';
import { api } from '@/lib/api';
import { submit } from '@/lib/actions';
import { load, type Paged, type PageProps } from '@/lib/data';
import { ActionButton, Card, Empty, Page, Pager, fmtDateTime, humanize } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { Icon } from '@/components/icons';

export const metadata = { title: 'Notifications' };

/** What each kind of notification means, in the reader's words. */
const EVENTS: Record<string, [title: string, when: string]> = {
  'leave.approved': ['Leave approved', 'When your leave request is approved'],
  'leave.rejected': ['Leave rejected', 'When your leave request is turned down'],
  'profile_change.approved': ['Profile change approved', 'When HR applies a change you asked for'],
  'profile_change.rejected': ['Profile change rejected', 'When HR turns down a change you asked for'],
  'bank.verified': ['Bank account verified', 'When your bank account is confirmed for salary'],
  'bank.rejected': ['Bank account rejected', 'When your bank account could not be confirmed'],
  'payslip.ready': ['Payslip ready', 'When a new payslip is available to you'],
};

export default async function Notifications({ searchParams }: PageProps) {
  const sp = await searchParams;
  const unread = sp.unread === 'true' ? 'true' : undefined;
  const res = await api<Paged<NotificationView> & { unread: number }>('/me/notifications', { query: { unread, cursor: sp.cursor, limit: '25' } }).catch(() => null);
  const prefs = (await load<PreferenceView[]>('/me/notification-preferences')) ?? [];
  const back = `/notifications${unread ? '?unread=true' : ''}`;
  return (
    <Page title="Notifications" sub={res ? (res.unread ? `You have ${res.unread} unread. Updates about your requests, bank details and payslips arrive here.` : 'You are all caught up. Updates about your requests, bank details and payslips arrive here.') : undefined} sp={sp}
      actions={<>
        <nav className="chips" aria-label="Show"><Link href="/notifications" aria-current={unread ? undefined : 'true'}>All</Link><Link href="/notifications?unread=true" aria-current={unread ? 'true' : undefined}>Unread</Link></nav>
        {res && res.unread > 0 && <ActionButton path="/me/notifications/read-all" back={back} ok="All marked as read" button="Mark all as read" />}
      </>}>
      <Card wide>
        {res === null ? <Empty icon="bell" title="Notifications could not be loaded">Please refresh the page in a moment.</Empty>
          : res.data.length === 0 ? <Empty icon="bell" title={unread ? 'Nothing unread' : 'No notifications yet'}>{unread ? 'You have read everything.' : 'When a request of yours is decided or a payslip is ready, you will see it here.'}</Empty> : (
            <ul className="feed">
              {res.data.map((n) => (
                <li key={n.id} className={n.readAt ? '' : 'unread'}>
                  <span className="ico"><Icon name="bell" size={16} /></span>
                  <div><strong>{n.title}</strong>{n.body && <div>{n.body}</div>}<div className="when">{fmtDateTime(n.createdAt)}</div></div>
                  {!n.readAt && <ActionButton path={`/me/notifications/${n.id}/read`} back={back} ok="Marked as read" button="Mark as read" />}
                </li>
              ))}
            </ul>
          )}
        {res && <Pager base="/notifications" query={{ unread }} nextCursor={res.page?.nextCursor ?? null} started={!!sp.cursor} />}
      </Card>
      <Card title="What you are told about" desc="Choose where each kind of update reaches you. Press Save on a row after changing it.">
        <div>
          {NOTIFICATION_EVENTS.map((key) => {
            const p = prefs.find((x) => x.eventKey === key) ?? { eventKey: key, inAppEnabled: true, emailEnabled: false };
            const [title, when] = EVENTS[key] ?? [humanize(key), ''];
            return (
              <div className="pref" key={key}>
                <div><b>{title}</b>{when && <div className="hint">{when}</div>}</div>
                <form action={submit}>
                  <input type="hidden" name="_path" value={`/me/notification-preferences/${key}`} /><input type="hidden" name="_method" value="PUT" /><input type="hidden" name="_back" value="/notifications" /><input type="hidden" name="_ok" value={`Saved: ${title}`} />
                  <label className="check"><input type="hidden" name="b:inAppEnabled" value="false" /><input type="checkbox" name="b:inAppEnabled" value="true" defaultChecked={p.inAppEnabled} /><span>In the app</span></label>
                  <label className="check"><input type="hidden" name="b:emailEnabled" value="false" /><input type="checkbox" name="b:emailEnabled" value="true" defaultChecked={p.emailEnabled} /><span>By email</span></label>
                  <SubmitButton>Save</SubmitButton>
                </form>
              </div>
            );
          })}
        </div>
      </Card>
    </Page>
  );
}
