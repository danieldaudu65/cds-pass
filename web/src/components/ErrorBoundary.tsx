import { Component, type ErrorInfo, type ReactNode } from 'react';

/** If a screen crashes, show what happened instead of a blank white page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('CDS Pass crashed:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-paper p-6 text-ink">
        <div className="card w-full max-w-md space-y-4 text-center">
          <p className="text-2xl font-extrabold">Something went wrong</p>
          <p className="text-sm text-muted">Please try again. If it keeps happening, send this message to the developer:</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-2xl bg-bad-bg p-3 text-left text-xs text-bad">
            {error.message}
          </pre>
          <button
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
            className="h-14 w-full rounded-2xl bg-green font-bold text-white"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
