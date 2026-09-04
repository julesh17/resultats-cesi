'use client';

import { X } from 'lucide-react';

export default function Modal({ open, onClose, title, children, wide = false }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px] p-4 flex items-center justify-center" onMouseDown={onClose}>
      <div
        className={`card w-full ${wide ? 'max-w-5xl' : 'max-w-xl'} max-h-[90vh] overflow-hidden flex flex-col`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <h2 className="font-semibold">{title}</h2>
          <button className="btn-secondary !p-2" onClick={onClose} aria-label="Fermer"><X size={17} /></button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
