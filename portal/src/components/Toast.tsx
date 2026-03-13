import { useEffect, useState } from 'react';
import { colors } from '../lib/styles';

interface ToastProps {
  message: string;
  type?: 'success' | 'error';
  onDismiss: () => void;
}

export function Toast({ message, type = 'success', onDismiss }: ToastProps) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setExiting(true), 3600);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(onDismiss, 350);
    return () => clearTimeout(timer);
  }, [exiting, onDismiss]);

  const isSuccess = type === 'success';

  return (
    <div
      className={exiting ? 'toast-exit' : 'toast-enter'}
      style={{
        position: 'fixed',
        top: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: isSuccess ? colors.card : '#fef2f2',
        border: `1px solid ${isSuccess ? colors.success : colors.error}`,
        borderRadius: '10px',
        padding: '12px 20px',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        maxWidth: '400px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        cursor: 'pointer',
      }}
      onClick={() => setExiting(true)}
    >
      <span style={{ fontSize: '16px' }}>{isSuccess ? '\u2713' : '\u2717'}</span>
      <span style={{ fontSize: '13px', color: isSuccess ? colors.success : colors.error }}>
        {message}
      </span>
    </div>
  );
}
