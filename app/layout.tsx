import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { asset } from '@/lib/config';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';
import './globals.css';

export const metadata: Metadata = {
  title: 'Annotation Carryover',
  description: 'Transfer PDF highlights and notes to a new version of the same PDF.',
  manifest: asset('/manifest.webmanifest'),
  icons: { icon: asset('/icon-192.png'), apple: asset('/apple-touch-icon.png') },
  appleWebApp: { capable: true, title: 'Annotations', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#1d4ed8',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
