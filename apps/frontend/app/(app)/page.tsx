import { redirect } from 'next/navigation';

/** No fleet dashboard: everything (missions, events, alerts) belongs to a robot, so home is the robot list. */
export default function Home() {
  redirect('/robots');
}
