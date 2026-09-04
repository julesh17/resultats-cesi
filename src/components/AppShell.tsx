'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, UsersRound, Upload, Table2, RotateCcw, WalletCards, Scale, LogOut, Menu, X,
} from 'lucide-react';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

const nav = [
  { href: '/dashboard', label: 'Tableau de bord', icon: LayoutDashboard },
  { href: '/dashboard/sessions', label: 'Sessions', icon: UsersRound },
  { href: '/dashboard/imports', label: 'Imports', icon: Upload },
  { href: '/dashboard/notes', label: 'Notes & UE', icon: Table2 },
  { href: '/dashboard/rattrapages', label: 'Rattrapages', icon: RotateCcw },
  { href: '/dashboard/dettes', label: 'Dettes', icon: WalletCards },
  { href: '/dashboard/jury', label: 'Jury', icon: Scale },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      const { data: profile } = await supabase.from('profiles').select('display_name').eq('id', data.user.id).maybeSingle();
      setName(profile?.display_name || data.user.user_metadata?.display_name || 'Utilisateur');
    });
  }, []);

  async function logout() {
    await getSupabaseBrowser().auth.signOut();
    router.replace('/login');
  }

  const sidebar = (
    <div className="h-full flex flex-col bg-white border-r" style={{ borderColor: 'var(--border)' }}>
      <div className="px-5 py-5 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-3">
          <Image src="/hello.png" alt="Résultats CESI" width={88} height={32} className="h-8 w-auto object-contain" priority />
          <div className="min-w-0">
            <div className="font-semibold leading-tight">Résultats CESI</div>
            <div className="text-[11px] muted truncate">Suivi académique</div>
          </div>
        </div>
      </div>
      <nav className="p-3 space-y-1 flex-1">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = href === '/dashboard' ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className={cn(
                'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                active ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50'
              )}
            >
              <Icon size={18} /> {label}
            </Link>
          );
        })}
      </nav>
      <div className="p-3 border-t" style={{ borderColor: 'var(--border)' }}>
        <div className="px-3 py-2 text-xs muted truncate">{name}</div>
        <button className="w-full btn-secondary justify-start" onClick={logout}><LogOut size={16} /> Se déconnecter</button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      <aside className="hidden lg:block fixed inset-y-0 left-0 w-64 z-30">{sidebar}</aside>
      {open ? (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/25" onClick={() => setOpen(false)}>
          <aside className="w-72 h-full" onClick={(e) => e.stopPropagation()}>{sidebar}</aside>
        </div>
      ) : null}
      <div className="lg:pl-64 min-h-screen">
        <header className="lg:hidden sticky top-0 z-30 glass border-b px-4 py-3 flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
          <button className="btn-secondary !p-2" onClick={() => setOpen(true)}><Menu size={19} /></button>
          <Image src="/hello.png" alt="Résultats CESI" width={78} height={28} className="h-7 w-auto" />
          <button className="btn-secondary !p-2 invisible"><X size={19} /></button>
        </header>
        <main className="max-w-[1500px] mx-auto p-4 md:p-7 lg:p-9">{children}</main>
      </div>
    </div>
  );
}
