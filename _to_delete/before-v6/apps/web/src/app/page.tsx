import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';
/** Signed in: the home screen. Otherwise: the public sign-in page. */
export default async function Home() {
  redirect((await cookies()).get('ht_session') ? '/dashboard' : '/login');
}
