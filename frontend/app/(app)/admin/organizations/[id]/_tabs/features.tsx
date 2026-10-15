'use client';

import type { OrganizationDetailDto } from '@arnobot/message-schema';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { FeatureChecklist, useClientFeatures } from '@/components/domain/client-admin';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/field';
import { Card, InlineAlert, QueryView } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

/**
 * What the client has bought in the client app: the ceiling for its users. Removing a feature removes it from every
 * user at once; newly added ones go to every user too unless unticked. No video or CSV features exist, by design.
 */
export function FeaturesTab({ org, canEdit }: { org: OrganizationDetailDto; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const catalogue = useClientFeatures();
  const [value, setValue] = useState<string[]>(org.features);
  const [addToUsers, setAddToUsers] = useState(true);
  useEffect(() => setValue(org.features), [org.features]);

  const removed = org.features.filter((k) => !value.includes(k));
  const added = value.filter((k) => !org.features.includes(k));
  const name = (k: string) => catalogue.data?.find((f) => f.key === k)?.name ?? k;
  const m = useMutation({
    mutationFn: () => api.put<{ added: string[]; removed: string[] }>(`/organizations/${org.id}/features`, { features: value, add_to_users: addToUsers }),
    onSuccess: (r) => {
      toast.success(`Features saved${r.added.length ? ` · ${r.added.length} added` : ''}${r.removed.length ? ` · ${r.removed.length} removed` : ''}`);
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: toast.error,
  });

  return (
    <Card
      title="Client app features"
      actions={
        canEdit && (
          <>
            <Button size="sm" onClick={() => setValue((catalogue.data ?? []).filter((f) => f.is_default && !f.always_on).map((f) => f.key).sort())}>
              Default
            </Button>
            <Button size="sm" onClick={() => setValue((catalogue.data ?? []).filter((f) => !f.always_on).map((f) => f.key).sort())}>
              Everything
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          What {org.name} can use in the client app. Each user gets these or fewer (Users &amp; access → Access). Video and CSV downloads are never offered to clients.
        </p>
        <QueryView query={catalogue} rows={6}>
          {(cat) => <FeatureChecklist catalogue={cat} value={value} onChange={setValue} disabled={!canEdit || !!org.deleted_at} />}
        </QueryView>
        {canEdit && !org.deleted_at && (
          <>
            {removed.length > 0 && (
              <InlineAlert tone="warn" title="Removed from every user too">
                {removed.map(name).join(', ')} will be taken away from all {org.name} users as soon as you save.
              </InlineAlert>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Checkbox label="Also give newly added features to all its users" checked={addToUsers} onChange={(e) => setAddToUsers(e.target.checked)} />
              <div className="flex gap-2">
                <Button onClick={() => setValue(org.features)} disabled={!added.length && !removed.length}>
                  Reset
                </Button>
                <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!added.length && !removed.length}>
                  Save features
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
