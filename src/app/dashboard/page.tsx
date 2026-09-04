'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpenCheck, CircleHelp, RotateCcw, WalletCards, ArrowRight } from 'lucide-react';
import StatCard from '@/components/StatCard';
import Loading from '@/components/Loading';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import type { CesiSession, Debt, Evaluation, Grade, Student, UE } from '@/lib/types';
import { buildRetakeMap, computeStudentUEs, makeGradeMap } from '@/lib/results';
import { displayStudent } from '@/lib/utils';

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<CesiSession[]>([]);
  const [followedIds, setFollowedIds] = useState<string[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [ues, setUes] = useState<UE[]>([]);
  const [debts, setDebts] = useState<Debt[]>([]);

  useEffect(() => {
    async function load() {
      const supabase = getSupabaseBrowser();
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth.user?.id;
      const [s, st, ev, gr, ue, de, sub] = await Promise.all([
        supabase.from('sessions').select('*').order('name'),
        supabase.from('students').select('*').eq('active', true),
        supabase.from('evaluations').select('*').eq('active', true),
        supabase.from('grades').select('*'),
        supabase.from('ues').select('*').eq('active', true),
        supabase.from('debts').select('*'),
        userId ? supabase.from('session_subscriptions').select('session_id').eq('user_id', userId) : Promise.resolve({ data: [] as Array<{ session_id: string }> }),
      ]);
      setSessions((s.data || []) as CesiSession[]);
      setStudents((st.data || []) as Student[]);
      setEvaluations((ev.data || []) as Evaluation[]);
      setGrades((gr.data || []) as Grade[]);
      setUes((ue.data || []) as UE[]);
      setDebts((de.data || []) as Debt[]);
      setFollowedIds((sub.data || []).map((x) => x.session_id));
      setLoading(false);
    }
    load();
  }, []);

  const dashboard = useMemo(() => {
    const targetIds = new Set(followedIds.length ? followedIds : sessions.map((s) => s.id));
    const targetSessions = sessions.filter((s) => targetIds.has(s.id));
    const missing: Array<{ student: Student; evaluation: Evaluation; session: CesiSession }> = [];
    const complex: Array<{ student: Student; session: CesiSession; reasons: string[]; score: number }> = [];
    let currentRetakes = 0;

    for (const session of targetSessions) {
      const ss = students.filter((x) => x.session_id === session.id);
      const ee = evaluations.filter((x) => x.session_id === session.id);
      const uu = ues.filter((x) => x.session_id === session.id);
      const studentIds = new Set(ss.map((x) => x.id));
      const gg = grades.filter((x) => studentIds.has(x.student_id));
      const dd = debts.filter((x) => studentIds.has(x.student_id));
      const gradeMap = makeGradeMap(gg);

      const retakes = buildRetakeMap(ss, ee, gg, uu);
      currentRetakes += [...retakes.current.values()].reduce((sum, list) => sum + list.length, 0);

      for (const student of ss) {
        let missingCount = 0;
        let absences = 0;
        for (const evaluation of ee) {
          const grade = gradeMap.get(`${student.id}:${evaluation.id}`);
          if (!grade || (!grade.final_mention && !grade.absence)) {
            missing.push({ student, evaluation, session });
            missingCount += 1;
          }
          if (grade?.absence) absences += 1;
        }
        const ueResults = computeStudentUEs(student.id, uu, ee, gradeMap);
        const nonValidated = ueResults.filter((r) => !r.validated && !r.missing).length;
        const pendingDebt = dd.filter((d) => d.student_id === student.id && d.status === 'pending').length;
        const formerDebt = dd.filter((d) => d.student_id === student.id && d.status === 'validated').length;
        const reasons: string[] = [];
        if (pendingDebt) reasons.push(`${pendingDebt} dette(s) en cours`);
        if (nonValidated) reasons.push(`${nonValidated} UE non validée(s)`);
        if (absences >= 3) reasons.push(`${absences} absences AJ/ANJ`);
        if (formerDebt) reasons.push(`${formerDebt} ex-dette(s)`);
        if (missingCount) reasons.push(`${missingCount} note(s) manquante(s)`);
        if (reasons.length) complex.push({
          student,
          session,
          reasons,
          score: pendingDebt * 20 + nonValidated * 10 + absences * 2 + formerDebt * 3 + missingCount,
        });
      }
    }
    complex.sort((a, b) => b.score - a.score || a.student.last_name.localeCompare(b.student.last_name));
    return {
      targetSessions,
      missing,
      complex,
      currentRetakes,
      pendingDebts: debts.filter((d) => d.status === 'pending' && students.some((s) => s.id === d.student_id && targetIds.has(s.session_id))).length,
    };
  }, [debts, evaluations, followedIds, grades, sessions, students, ues]);

  if (loading) return <Loading />;

  return (
    <div className="space-y-7">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="page-title">Tableau de bord</h1>
          <p className="page-subtitle">Les situations qui demandent votre attention apparaissent en premier.</p>
        </div>
        <Link href="/dashboard/sessions" className="btn-secondary">Gérer mes sessions suivies <ArrowRight size={16} /></Link>
      </div>

      {!sessions.length ? (
        <div className="card p-6">
          <h2 className="font-semibold">Commencez par créer une session</h2>
          <p className="text-sm muted mt-1">Vous pouvez créer une session ici ou importer directement un fichier de notes : toute session inconnue sera créée automatiquement.</p>
          <Link href="/dashboard/sessions" className="btn-primary mt-4">Créer une session</Link>
        </div>
      ) : null}

      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard label="Cas particuliers" value={dashboard.complex.length} hint="Dettes, UE, absences ou notes manquantes" icon={AlertTriangle} />
        <StatCard label="Notes non saisies" value={dashboard.missing.length} hint="Cellules sans lettre ni AJ/ANJ" icon={CircleHelp} />
        <StatCard label="Rattrapages" value={dashboard.currentRetakes} hint="Situations C/D/AJ/ANJ non compensées" icon={RotateCcw} />
        <StatCard label="Dettes en cours" value={dashboard.pendingDebts} hint="Après épreuve complémentaire non validée" icon={WalletCards} />
      </div>

      <div className="grid xl:grid-cols-[1.15fr_.85fr] gap-5">
        <section className="card overflow-hidden">
          <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
            <div>
              <h2 className="section-title">Cas complexes prioritaires</h2>
              <p className="text-xs muted mt-1">Le tri favorise les dettes et les UE non validées.</p>
            </div>
            <Link href="/dashboard/jury" className="text-sm text-blue-600 font-medium">Ouvrir le jury</Link>
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {dashboard.complex.slice(0, 12).map((item) => (
              <div key={`${item.student.id}-${item.session.id}`} className="px-5 py-4 flex flex-col md:flex-row md:items-center gap-3 justify-between">
                <div className="min-w-0">
                  <div className="font-medium">{displayStudent(item.student.first_name, item.student.last_name)}</div>
                  <div className="text-xs muted mt-0.5">{item.session.name}</div>
                </div>
                <div className="flex flex-wrap gap-1.5 md:justify-end">
                  {item.reasons.map((r) => <span key={r} className="status-badge bg-gray-50 border-gray-200 text-gray-700">{r}</span>)}
                </div>
              </div>
            ))}
            {!dashboard.complex.length ? <div className="p-8 text-center text-sm muted">Aucun cas particulier détecté sur les sessions affichées.</div> : null}
          </div>
        </section>

        <section className="card overflow-hidden">
          <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
            <div>
              <h2 className="section-title">Notes non saisies</h2>
              <p className="text-xs muted mt-1">Les premières cellules manquantes détectées.</p>
            </div>
            <Link href="/dashboard/notes" className="text-sm text-blue-600 font-medium">Saisir</Link>
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {dashboard.missing.slice(0, 12).map((item) => (
              <div key={`${item.student.id}-${item.evaluation.id}`} className="px-5 py-3.5">
                <div className="font-medium text-sm">{displayStudent(item.student.first_name, item.student.last_name)}</div>
                <div className="text-xs muted mt-0.5 line-clamp-2">S{item.evaluation.semester} · {item.evaluation.name} · {item.session.name}</div>
              </div>
            ))}
            {!dashboard.missing.length ? (
              <div className="p-8 text-center">
                <BookOpenCheck className="mx-auto text-emerald-500 mb-2" size={28} />
                <div className="text-sm muted">Aucune note manquante détectée.</div>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <div className="text-xs muted">
        {followedIds.length ? `Tableau de bord limité à ${dashboard.targetSessions.length} session(s) suivie(s).` : 'Aucune session suivie : le tableau de bord affiche toutes les sessions.'}
      </div>
    </div>
  );
}
