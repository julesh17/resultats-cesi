'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { ArrowRight, KeyRound, UserPlus } from 'lucide-react';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import { internalEmail } from '@/lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getSupabaseBrowser().auth.getSession().then(({ data }) => {
      if (data.session) router.replace('/dashboard');
    });
  }, [router]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'signup') {
        const response = await fetch('/api/signup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password, displayName, secret }),
        });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || 'Création impossible.');
      }
      const { error: signError } = await getSupabaseBrowser().auth.signInWithPassword({
        email: internalEmail(username.trim().toLowerCase()),
        password,
      });
      if (signError) throw signError;
      router.replace('/dashboard');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur de connexion.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen relative overflow-hidden grid place-items-center px-4 py-10">
      <div className="ambient-light" />
      <div className="relative z-10 w-full max-w-md animate-slide-up">
        <div className="text-center mb-7">
          <Image src="/hello.png" alt="Résultats CESI" width={230} height={80} className="mx-auto h-16 w-auto object-contain" priority />
          <h1 className="text-3xl font-semibold tracking-tight mt-4">Résultats CESI</h1>
          <p className="muted text-sm mt-2">Notes, rattrapages, dettes et jurys au même endroit.</p>
        </div>

        <div className="card p-6 md:p-7">
          <div className="grid grid-cols-2 bg-gray-100 rounded-xl p-1 mb-6">
            <button className={`rounded-lg px-3 py-2 text-sm font-medium ${mode === 'login' ? 'bg-white shadow-sm' : 'muted'}`} onClick={() => { setMode('login'); setError(''); }}>Connexion</button>
            <button className={`rounded-lg px-3 py-2 text-sm font-medium ${mode === 'signup' ? 'bg-white shadow-sm' : 'muted'}`} onClick={() => { setMode('signup'); setError(''); }}>Créer un compte</button>
          </div>

          <form className="space-y-4" onSubmit={submit}>
            {mode === 'signup' ? (
              <label className="block">
                <span className="form-label">Nom affiché</span>
                <input className="form-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Prénom Nom" required />
              </label>
            ) : null}
            <label className="block">
              <span className="form-label">Pseudo</span>
              <input className="form-input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ex. chamdan" autoCapitalize="none" required />
            </label>
            <label className="block">
              <span className="form-label">Mot de passe</span>
              <input className="form-input" type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            {mode === 'signup' ? (
              <label className="block">
                <span className="form-label">Mot de validation</span>
                <input className="form-input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Mot secret partagé" required />
              </label>
            ) : null}
            {error ? <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 p-3 text-sm">{error}</div> : null}
            <button className="btn-primary w-full py-2.5" disabled={loading}>
              {mode === 'login' ? <KeyRound size={17} /> : <UserPlus size={17} />}
              {loading ? 'Patientez…' : mode === 'login' ? 'Se connecter' : 'Créer le compte'}
              {!loading ? <ArrowRight size={16} /> : null}
            </button>
          </form>
        </div>
        <p className="text-center text-xs muted mt-5">L’accès aux données nécessite un compte authentifié.</p>
      </div>
    </main>
  );
}
