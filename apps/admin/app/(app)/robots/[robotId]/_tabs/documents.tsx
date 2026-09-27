'use client';

import type { DocumentDto, RobotDetailDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { DocumentsPanel, type OwnerOption } from '@/components/domain/documents-panel';
import { InlineAlert, QueryView } from '@/components/ui/misc';
import { api } from '@/lib/api';

/**
 * Effective documents (spec §4): this robot's own (one-off builds) ∪ its hardware revision's ∪ its product's.
 * Documents shared by every robot of a product are stored once on the product, not copied per robot.
 */
export function DocumentsTab({ robot }: { robot: RobotDetailDto }) {
  const q = useQuery({ queryKey: ['robot', robot.robot_id, 'documents'], queryFn: () => api.get<DocumentDto[]>(`/robots/${robot.robot_id}/documents`) });
  const owners: OwnerOption[] = [
    { label: `This robot only (${robot.robot_id}, one-off build)`, owner: { robot_id: robot.robot_id } },
    ...(robot.hardware_revision_id ? [{ label: `${robot.product_name} ${robot.hardware_revision} (all robots of this revision)`, owner: { hardware_revision_id: robot.hardware_revision_id } }] : []),
    { label: `${robot.product_name} (all robots of this product)`, owner: { product_id: robot.product_id } },
  ];
  return (
    <div className="flex flex-col gap-4">
      <InlineAlert tone="accent">Shows this robot&apos;s own documents plus those of its hardware revision and product. The latest version is shown; open History for older ones.</InlineAlert>
      <QueryView query={q}>
        {(docs) => <DocumentsPanel documents={docs} invalidateKey={['robot', robot.robot_id, 'documents']} owners={owners} emptyText="No documents for this robot, its revision or its product" />}
      </QueryView>
    </div>
  );
}
