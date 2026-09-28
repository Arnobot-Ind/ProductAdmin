'use client';

import { CheckCircle2, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';

interface Toast {
  id: number;
  tone: 'ok' | 'fault';
  message: string;
}

const ToastContext = createContext<{ success: (m: string) => void; error: (e: unknown) => void }>({
  success: () => undefined,
  error: () => undefined,
});

export function useToast() {
  return useContext(ToastContext);
}

let seq = 0;

/** Toasts are announced through an aria-live region (status for success, alert for errors). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (tone: Toast['tone'], message: string) => {
      const id = ++seq;
      setToasts((t) => [...t.slice(-3), { id, tone, message }]);
      window.setTimeout(() => dismiss(id), tone === 'fault' ? 8000 : 4000);
    },
    [dismiss],
  );
  const success = useCallback((m: string) => push('ok', m), [push]);
  const error = useCallback((e: unknown) => push('fault', errorMessage(e)), [push]);

  return (
    <ToastContext.Provider value={{ success, error }}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        <div aria-live="polite" role="status" className="contents">
          {toasts.filter((t) => t.tone === 'ok').map((t) => (
            <ToastView key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </div>
        <div aria-live="assertive" role="alert" className="contents">
          {toasts.filter((t) => t.tone === 'fault').map((t) => (
            <ToastView key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const Icon = toast.tone === 'ok' ? CheckCircle2 : XCircle;
  return (
    <div className={cn('pointer-events-auto flex items-start gap-2 rounded-md border bg-surface px-3 py-2.5 text-sm shadow-lg', toast.tone === 'ok' ? 'border-ok/40' : 'border-fault/50')}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', toast.tone === 'ok' ? 'text-ok' : 'text-fault')} aria-hidden />
      <p className="flex-1 text-fg">{toast.message}</p>
      <button type="button" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification" className="text-muted hover:text-fg">
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
