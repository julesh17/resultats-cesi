import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Résultats CESI',
  description: 'Suivi des notes, rattrapages, dettes et jurys CESI.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
