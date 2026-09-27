/** ARNOBOT wordmark with the chevron mark (brand context §4). */
export function BrandMark({ compact }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden>
        <polygon points="4,3 14,12 4,21 8,21 18,12 8,3" fill="var(--accent)" />
      </svg>
      <span className="flex flex-col leading-none">
        <span className="font-[family-name:var(--font-display)] text-base font-bold tracking-[0.14em]">ARNOBOT</span>
        {!compact && <span className="mt-1 text-[0.625rem] font-semibold tracking-[0.2em] text-muted uppercase">PMS · Product Admin</span>}
      </span>
    </span>
  );
}
