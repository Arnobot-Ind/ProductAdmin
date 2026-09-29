import Image from 'next/image';

/** ARNOBOT logo (public/brand, black on light theme, white on dark), with the product line underneath. */
export function BrandMark({ compact }: { compact?: boolean }) {
  return (
    <span className="inline-flex flex-col leading-none">
      <Image src="/brand/arnobot-logo-black.png" alt="Arnobot" width={1392} height={320} priority className="h-6 w-auto dark:hidden" />
      <Image src="/brand/arnobot-logo-white.png" alt="Arnobot" width={1405} height={320} priority className="hidden h-6 w-auto dark:block" />
      {!compact && <span className="mt-1.5 text-[0.625rem] font-semibold tracking-[0.2em] text-muted uppercase">PMS · Product Admin</span>}
    </span>
  );
}
