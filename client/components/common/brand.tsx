import Image from 'next/image';

/** ARNOBOT logo (public/brand, black on light theme, white on dark; always white with onDark), with the product line underneath. */
export function BrandMark({ compact, onDark }: { compact?: boolean; onDark?: boolean }) {
  return (
    <span className="inline-flex flex-col leading-none">
      {!onDark && <Image src="/brand/arnobot-logo-black.png" alt="Arnobot" width={1392} height={320} priority className="h-8 w-auto self-start dark:hidden" />}
      <Image src="/brand/arnobot-logo-white.png" alt="Arnobot" width={1405} height={320} priority className={onDark ? 'h-8 w-auto self-start' : 'hidden h-8 w-auto self-start dark:block'} />
      {!compact && <span className="mt-1.5 text-xs font-semibold tracking-[0.18em] text-muted uppercase">Client Admin</span>}
    </span>
  );
}
