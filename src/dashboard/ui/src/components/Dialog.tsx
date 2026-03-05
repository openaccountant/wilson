import { useEffect, useRef, type ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Dialog({ open, onClose, title, children, footer, className }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  function handleBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current) onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={handleBackdropClick}
      className={`bg-surface border border-border rounded-lg p-0 ${className ?? 'max-w-lg'} w-full m-auto max-h-[85vh] backdrop:bg-black/60`}
    >
      <div className="flex flex-col max-h-[85vh]">
        {/* Fixed header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-base font-semibold text-text">{title}</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text bg-transparent border-none text-lg cursor-pointer"
          >
            &times;
          </button>
        </div>
        {/* Scrollable body */}
        <div className="p-5 text-text overflow-y-auto flex-1 min-h-0">{children}</div>
        {/* Fixed footer */}
        {footer && (
          <div className="px-5 py-3 border-t border-border shrink-0">{footer}</div>
        )}
      </div>
    </dialog>
  );
}
