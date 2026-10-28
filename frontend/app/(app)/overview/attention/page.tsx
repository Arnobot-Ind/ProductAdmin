'use client';

import { attentionItems, AttentionList, DashboardPage } from '@/components/domain/dashboard';
import { useDocumentTitle } from '@/lib/hooks';

export default function AttentionPage() {
  useDocumentTitle('Needs attention');
  return (
    <DashboardPage title="Needs attention" description="Faults, unacknowledged critical events, offline robots and warranties ending soon, most urgent first.">
      {(d) => <AttentionList items={attentionItems(d)} />}
    </DashboardPage>
  );
}
