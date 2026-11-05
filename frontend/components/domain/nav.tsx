import { Bot, Plane, LayoutDashboard, Siren, UserCog, Users } from 'lucide-react';

/** The side menu. The top search reads this one list too. */
export interface NavItem {
  href: string;
  label: string;
  description: string;
  Icon: typeof Bot;
  /** Platform-level permission needed to show the link (the API enforces regardless). */
  perm?: string;
  /** Other words people may type to find the page in the top search. */
  keywords?: string;
}

export const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', description: 'Key fleet numbers and what needs action', keywords: 'home overview summary fleet health', Icon: LayoutDashboard },
  { href: '/robots', label: 'Robots', description: 'Every robot: live status, recordings, hardware and software', keywords: 'bots fleet list ugv uav vehicles drones status battery', Icon: Bot },
  { href: '/drone', label: 'Drone live', description: "The drone's camera and stats, live", keywords: 'uav video camera c12 h12 stream feed', Icon: Plane, perm: 'robot.details' },
  { href: '/admin/users', label: 'Users', description: 'Invite people and manage their logins', keywords: 'people invite login team staff', Icon: Users, perm: 'user.manage' },
  { href: '/account', label: 'My account', description: 'Your profile and password', keywords: 'profile password me', Icon: UserCog },
];

/** The menu pages the user may open. */
export function visibleNav(nav: NavItem[], can: (p: string) => boolean): NavItem[] {
  return nav.filter((i) => !i.perm || can(i.perm));
}

/** Things people come to do, found by the top search next to the pages. */
export const ACTIONS: (NavItem & { section: string })[] = [
  { section: 'Actions', href: '/robots/new', label: 'Register robot', description: 'Add a new robot', keywords: 'new add create register robot bot', Icon: Bot, perm: 'robot.write' },
  { section: 'Actions', href: '/admin/users', label: 'Invite user', description: 'Give someone a login', keywords: 'new add invite user person login', Icon: Users, perm: 'user.manage' },
  { section: 'Actions', href: '/overview/attention', label: 'Review alerts', description: 'Faults and alerts nobody has reviewed yet', keywords: 'needs attention review acknowledge alerts faults critical warnings', Icon: Siren },
];

/** Pages and actions matching every word typed (in the name, section, description or search words), best first. */
export function matchPages(items: (NavItem & { section: string })[], query: string): (NavItem & { section: string })[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const score = (i: NavItem & { section: string }) => {
    const label = i.label.toLowerCase();
    const text = `${label} ${i.section.toLowerCase()} ${i.description.toLowerCase()} ${i.keywords ?? ''}`;
    if (!words.every((w) => text.includes(w))) return -1;
    return (label.startsWith(words[0]) ? 4 : 0) + (words.every((w) => label.includes(w)) ? 2 : 0) + (i.keywords?.includes(words[0]) ? 1 : 0);
  };
  return items
    .map((i) => [i, score(i)] as const)
    .filter(([, n]) => n >= 0)
    .sort((a, b) => b[1] - a[1])
    .map(([i]) => i);
}
