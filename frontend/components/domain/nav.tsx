import {
  AppWindow,
  Bot,
  Boxes,
  Building2,
  Cpu,
  Download,
  Gauge,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Map as MapIcon,
  MapPinned,
  Package,
  Route,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Siren,
  UserCog,
  Users,
  CalendarDays,
} from 'lucide-react';

/** The app's pages, grouped as in the side menu. The menu and the top search read this one list. */
export interface NavItem {
  href: string;
  label: string;
  /** One line in the app menu: what the page is for. */
  description: string;
  Icon: typeof Bot;
  /** Platform-level permission needed to show the link (the API enforces regardless). */
  perm?: string;
  anyOf?: string[];
  /** Other words people may type to find the page in the top search (e.g. "alerts" for Needs attention). */
  keywords?: string;
  /** Permission held in any scope (customers hold theirs on their organization). */
  scoped?: string;
  /** Kept out of the side menu and the app menu: the page opens from links to it (e.g. the dashboard) and its address. */
  hidden?: boolean;
}

export interface NavGroup {
  id: string;
  section: string;
  Icon: typeof Bot;
  items: NavItem[];
}

/** Grouped by what people come to do: check the fleet, manage hardware and software, manage customers, run the platform. */
export const NAV: NavGroup[] = [
  {
    id: 'overview',
    section: 'Overview',
    Icon: Gauge,
    items: [
      { href: '/', label: 'Dashboard', description: 'Key fleet numbers and the most urgent items', keywords: 'home overview summary fleet health kpi', Icon: LayoutDashboard },
      { href: '/overview/attention', label: 'Needs attention', description: 'Faults, critical events, offline robots, warranties', keywords: 'alerts faults errors warnings problems review acknowledge warranty critical issues', Icon: Siren, hidden: true },
      { href: '/overview/map', label: 'Fleet map', description: 'Where every robot last reported its position', keywords: 'map location gps position where', Icon: MapIcon },
      { href: '/activity', label: 'Activity', description: 'Pick a day: what each robot did (missions, distance, alerts, updates, repairs)', keywords: 'activity day calendar daily report what happened missions distance errors alerts', Icon: CalendarDays },
      { href: '/overview/missions', label: 'Missions', description: 'Mission results across the fleet this week', keywords: 'missions trips jobs results completed aborted failed calendar', Icon: Route, hidden: true },
      { href: '/overview/events', label: 'Events', description: 'The latest events from every robot', keywords: 'events log history alerts calendar', Icon: ListChecks, hidden: true },
    ],
  },
  {
    id: 'fleet',
    section: 'Fleet',
    Icon: Bot,
    items: [
      // Missions, events, videos and live status belong to one robot: they live on that robot's page.
      { href: '/robots', label: 'Robots', description: 'Every robot: live status, recordings, hardware and software', keywords: 'robots bots fleet list ugv uav vehicles drones status battery', Icon: Bot },
      { href: '/sites', label: 'Sites', description: 'Where robots are deployed: address, map, contact, robots there now and before', keywords: 'sites deploy deployment location customer place address contact', Icon: MapPinned, perm: 'robot.details' },
      { href: '/downloads', label: 'Data export', description: 'Download video, GPS, IMU, LiDAR and encoder data', keywords: 'download export data video gps imu lidar zip recordings', Icon: Download, scoped: 'data.download' },
    ],
  },
  {
    id: 'catalogue',
    section: 'Hardware & software',
    Icon: Cpu,
    items: [
      { href: '/products', label: 'Base models & attachments', description: 'UGV and UAV base models, attachments, hardware revisions and parts', keywords: 'base models products attachments hardware revisions parts photos 3d documents ugv uav', Icon: Boxes, perm: 'catalog.read' },
      { href: '/releases', label: 'Software releases', description: 'Signed software and firmware versions for robots', keywords: 'software firmware releases versions update package signature github commit', Icon: Package, perm: 'catalog.read' },
      { href: '/admin/software', label: 'Client software', description: 'GCS, client portal and other software clients run', keywords: 'client software gcs portal app installs licence versions github', Icon: AppWindow, perm: 'org.manage' },
    ],
  },
  {
    id: 'access',
    section: 'Customers & access',
    Icon: Building2,
    items: [
      { href: '/admin/organizations', label: 'Organizations', description: 'Customers, their robots, contracts and settings', keywords: 'organizations customers companies clients contracts', Icon: Building2, perm: 'org.manage' },
      { href: '/admin/users', label: 'Users', description: 'Invite people and manage their logins', keywords: 'users people invite login team staff', Icon: Users, perm: 'user.manage' },
      { href: '/admin/access', label: 'Roles & permissions', description: 'What each role is allowed to see and do', keywords: 'roles permissions access rights', Icon: ShieldCheck },
      { href: '/admin/audit', label: 'Audit log', description: 'Who signed in, viewed, changed or downloaded what', keywords: 'audit log history who changed downloaded signed in', Icon: ScrollText, perm: 'audit.read' },
    ],
  },
  {
    id: 'system',
    section: 'System',
    Icon: Server,
    items: [
      { href: '/ingest', label: 'Ingest', description: 'Messages arriving from robots and the GCS', keywords: 'ingest messages data received rejected keys gcs', Icon: Inbox, anyOf: ['ingest.read', 'ingest.manage'] },
      { href: '/settings', label: 'Settings & status', description: 'Server health, storage and configuration', keywords: 'settings status server health storage configuration', Icon: Settings, perm: 'system.read' },
      { href: '/account', label: 'My account', description: 'Your profile, password and permissions', keywords: 'account profile password me my', Icon: UserCog },
    ],
  },
];

/** The menu groups and pages the user may open (a group without any is left out). */
export function visibleNav(nav: NavGroup[], can: (p: string) => boolean, canAnywhere: (p: string) => boolean): NavGroup[] {
  return nav.map((g) => ({ ...g, items: g.items.filter((i) => !i.hidden && (!i.perm || can(i.perm)) && (!i.anyOf || i.anyOf.some((p) => can(p))) && (!i.scoped || canAnywhere(i.scoped))) })).filter((g) => g.items.length);
}

/** Things people come to do, found by the top search next to the pages (e.g. "register" or "add site"). */
export const ACTIONS: (NavItem & { section: string })[] = [
  { section: 'Robots', href: '/robots/new', label: 'Register robot', description: 'Add a new robot: base model, attachments, owner and site', keywords: 'new add create register robot bot', Icon: Bot, perm: 'robot.write' },
  { section: 'Sites', href: '/sites', label: 'Add site', description: 'A place robots are deployed to', keywords: 'new add create site deploy location', Icon: MapPinned, perm: 'robot.write' },
  { section: 'Base models & attachments', href: '/products', label: 'Add base model or attachment', description: 'A new UGV / UAV base model, or equipment fitted on robots', keywords: 'new add create base model product attachment', Icon: Boxes, perm: 'catalog.write' },
  { section: 'Software releases', href: '/releases', label: 'Register release', description: 'A new software or firmware version for a base model', keywords: 'new add register release version firmware software update', Icon: Package, perm: 'release.write' },
  { section: 'Client software', href: '/admin/software', label: 'Add client software or version', description: 'Software clients run, with its versions, photos and documents', keywords: 'new add software version gcs portal', Icon: AppWindow, perm: 'org.manage' },
  { section: 'Organizations', href: '/admin/organizations', label: 'Add organization', description: 'A new customer', keywords: 'new add create organization customer company client', Icon: Building2, perm: 'org.manage' },
  { section: 'Users', href: '/admin/users', label: 'Invite user', description: 'Give someone a login', keywords: 'new add invite user person login', Icon: Users, perm: 'user.manage' },
  { section: 'Needs attention', href: '/overview/attention', label: 'Review alerts', description: 'Mark alerts as reviewed, by day and filter', keywords: 'review acknowledge alerts faults critical', Icon: Siren },
  { section: 'Data export', href: '/downloads', label: 'Download robot data', description: 'Video, GPS, IMU, LiDAR and encoder data as a zip', keywords: 'download export zip data video', Icon: Download, scoped: 'data.download' },
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
