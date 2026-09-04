export default function Loading({ label = 'Chargement…', fullPage = false }: { label?: string; fullPage?: boolean }) {
  return (
    <div className={fullPage ? 'min-h-screen grid place-items-center' : 'py-16 grid place-items-center'}>
      <div className="flex items-center gap-3 text-sm muted">
        <span className="h-5 w-5 rounded-full border-2 border-gray-300 border-t-blue-600 animate-spin" />
        {label}
      </div>
    </div>
  );
}
