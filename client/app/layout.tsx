import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { themeBootScript } from '@/lib/theme';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Arnobot Client Admin', template: '%s · Arnobot Client Admin' },
  description: 'Arnobot Client Admin: your robots, missions, reports and detections.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
    { media: '(prefers-color-scheme: light)', color: '#f5f5f5' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning data-theme="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Brand fonts (Syne display, DM Sans body). System fonts are the fallback when offline. */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300..600&family=Syne:wght@500..800&display=swap" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
