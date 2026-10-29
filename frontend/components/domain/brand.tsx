import Image from 'next/image';

/** ARNOBOT logo (public/brand, black on light theme, white on dark; always white with onDark), with the product line beside it. */
export function BrandMark({ compact, onDark }: { compact?: boolean; onDark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-3 leading-none">
      {!onDark && <Image src="/brand/arnobot-logo-black.png" alt="Arnobot" width={1392} height={320} priority className="h-8 w-auto sm:h-10 dark:hidden" />}
      <Image src="/brand/arnobot-logo-white.png" alt="Arnobot" width={1405} height={320} priority className={onDark ? 'h-8 w-auto sm:h-10' : 'hidden h-8 w-auto sm:h-10 dark:block'} />
      {!compact && (
        <>
          <span className="hidden h-9 w-px bg-current opacity-30 sm:block" aria-hidden />
          <span className="hidden text-sm leading-snug font-semibold tracking-[0.16em] text-muted uppercase sm:block">
            PMS
            <br />
            Product Admin
          </span>
        </>
      )}
    </span>
  );
}
