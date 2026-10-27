import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Catches a render error in the page below it so one broken page shows "Something broke on this page" (with the error, and a way
 * to reload) instead of unmounting the whole app into a blank screen. Pass `resetKey` (the route path) so moving to another page
 * clears it. The navigation around it keeps working.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page error:", error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const details = `${error.name}: ${error.message}${error.stack ? `\n\n${error.stack.split("\n").slice(1, 8).join("\n")}` : ""}`;
    return (
      <div role="alert" className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-4 px-4 py-10">
        <h1 className="type-headline-s">Something broke on this page</h1>
        <p className="type-body-m text-on-surface-variant">The rest of the app is fine. Reload to try again, or open another page from the menu.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => window.location.reload()} className="state-layer inline-flex min-h-11 items-center rounded-full bg-primary px-5 type-label-l text-on-primary">
            Reload
          </button>
          <button type="button" onClick={() => this.setState({ error: null })} className="state-layer inline-flex min-h-11 items-center rounded-full bg-surface-container-high px-5 type-label-l">
            Try again
          </button>
        </div>
        <details className="min-w-0 rounded-md bg-surface-container p-3">
          <summary className="cursor-pointer type-label-l">Error details</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words type-body-s text-on-surface-variant">{details}</pre>
        </details>
      </div>
    );
  }
}
