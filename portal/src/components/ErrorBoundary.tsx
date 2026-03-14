import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { colors } from '../lib/styles';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[PORTAL] Uncaught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
        }}>
          <div style={{
            background: colors.card,
            border: `1px solid ${colors.border}`,
            borderRadius: '14px',
            padding: '32px',
            maxWidth: '380px',
            width: '100%',
            textAlign: 'center',
          }}>
            <div style={{
              fontSize: '15px',
              color: colors.cream,
              marginBottom: '8px',
            }}>
              Something went wrong
            </div>
            <div style={{
              fontSize: '13px',
              color: colors.muted,
              marginBottom: '20px',
              lineHeight: 1.5,
            }}>
              An unexpected error occurred. Please reload and try again.
            </div>
            <button
              type="button"
              className="btn-primary"
              style={{
                background: colors.accent,
                color: '#ffffff',
                border: 'none',
                borderRadius: '8px',
                padding: '10px 24px',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
