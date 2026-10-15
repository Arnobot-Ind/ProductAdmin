import type { AuditEntryDto } from '@arnobot/message-schema';

/** Readable audit actions and one-line details (Audit log page, an organization's Activity tab). */
export const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Sign-in failed',
  'auth.logout': 'Signed out',
  'auth.password_changed': 'Changed password',
  'auth.invite_accepted': 'Accepted invitation',
  'access.denied': 'Request refused',
  'user.created': 'Created user',
  'user.invited': 'Invited user',
  'user.updated': 'Updated user',
  'user.deleted': 'Deleted user',
  'user.restored': 'Restored user',
  'grant.added': 'Granted role',
  'grant.revoked': 'Revoked role',
  'org.created': 'Created organization',
  'org.updated': 'Updated organization',
  'org.deleted': 'Deleted organization',
  'org.restored': 'Restored organization',
  'robot.assigned': 'Assigned robot',
  'data.viewed': 'Opened recording',
  'data.downloaded': 'Downloaded',
  'data.deleted': 'Deleted recording',
  'data.restored': 'Restored recording',
  'hardware.updated': 'Edited hardware part',
  'software.recorded': 'Recorded software update',
  'credential.revealed': 'Revealed credential',
  'client.updated': 'Edited client profile',
  'features.updated': 'Changed client features',
  'access.updated': 'Changed user access',
  'software.installed': 'Recorded software install',
  'software.updated': 'Edited software install',
  'software.removed': 'Removed software install',
  'catalog.software_created': 'Added catalogue software',
  'catalog.software_updated': 'Edited catalogue software',
  'catalog.software_deleted': 'Deleted catalogue software',
  'catalog.software_restored': 'Restored catalogue software',
  'credential.created': 'Stored credential',
  'credential.rotated': 'Rotated credential',
  'credential.revoked': 'Revoked credential',
};

/** One readable line for an entry's details. */
export function auditSummary(e: AuditEntryDto): string {
  const d = e.detail as Record<string, unknown>;
  const s = (k: string) => (d[k] === undefined || d[k] === null ? '' : String(d[k]));
  switch (e.action) {
    case 'robot.assigned':
      return `${e.robot_id}: ${s('from_company') || '—'} → ${s('to_company')}${d.revoked_robot_grants ? ` · ${s('revoked_robot_grants')} robot role(s) revoked` : ''}${s('reason') ? ` · ${s('reason')}` : ''}`;
    case 'grant.added':
    case 'grant.revoked':
      return `${s('user_email')} · ${s('role')} @ ${d.scope_type === 'company' ? `organization ${e.company_name ?? s('scope_id')}` : `${s('scope_type')}${s('scope_id') ? ` ${s('scope_id')}` : ''}`}${s('reason') ? ` · ${s('reason')}` : ''}`;
    case 'data.downloaded':
      return `${s('file')}${d.restricted ? ' (restricted sensor data)' : ''}`;
    case 'data.viewed':
      return s('session_id');
    case 'access.denied':
      return `needs ${s('permission')} · ${s('method')} ${s('path')}`;
    case 'auth.login_failed':
      return s('reason');
    case 'hardware.updated':
      return `${s('part')}${d.slot ? ` ${s('slot')}` : ''}: ${Object.keys((d.changes as object) ?? {}).join(', ')}`;
    case 'software.recorded': {
      const to = (d.to ?? {}) as Record<string, unknown>;
      return `software ${to.sw_ver ?? '—'} · firmware ${to.fw_ver ?? '—'}${s('note') ? ` · ${s('note')}` : ''}`;
    }
    case 'user.created':
    case 'user.invited':
    case 'user.updated':
    case 'user.deleted':
    case 'user.restored':
      return [s('email'), s('organization'), s('credentials') || s('credentials_reissued'), d.is_active === false ? 'disabled' : d.is_active === true ? 'enabled' : '', d.password_reset ? 'password reset' : '']
        .filter(Boolean)
        .join(' · ');
    case 'org.created':
    case 'org.deleted':
    case 'org.restored':
      return s('name');
    case 'features.updated':
      return [(d.added as string[] | undefined)?.length ? `added ${(d.added as string[]).join(', ')}` : '', (d.removed as string[] | undefined)?.length ? `removed ${(d.removed as string[]).join(', ')}` : ''].filter(Boolean).join(' · ');
    case 'access.updated':
      return [s('user_email'), (d.features_added as string[] | undefined)?.length ? `+${(d.features_added as string[]).join(', +')}` : '', (d.features_removed as string[] | undefined)?.length ? `−${(d.features_removed as string[]).join(', −')}` : '']
        .filter(Boolean)
        .join(' · ');
    case 'client.updated':
      return Object.keys((d.changes as object) ?? {}).join(', ');
    case 'software.installed':
    case 'software.updated':
    case 'software.removed':
      return [s('software'), s('version') || s('from_version')].filter(Boolean).join(' ');
    case 'credential.created':
    case 'credential.rotated':
    case 'credential.revoked':
      return [s('label'), s('kind'), s('reason')].filter(Boolean).join(' · ');
    default:
      return Object.keys(d).length ? JSON.stringify(d) : '';
  }
}
