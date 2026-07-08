// Renderer-side error reporting (RUBY_OBSERVABILITY_PLAN §3.2).
//
// Renderers stay single-SDK: NO posthog-js here (the project key never enters a
// window). Instead we catch renderer JS exceptions and forward a serialized
// {name,message,stack} over the `analytics:captureException` IPC; the main
// process rebuilds the Error, scrubs it, and reports it via captureException.
//
// Two catch surfaces per root: the global window handlers (async throws,
// rejected promises, event-handler errors React can't see) and a React
// ErrorBoundary (render/lifecycle errors, which would otherwise unmount the
// tree silently).

import React from "react";

function report(surface: string, err: unknown, via: string, extra?: Record<string, unknown>): void {
  const e = err instanceof Error ? err : new Error(String(err));
  try {
    window.prompty?.invoke("analytics:captureException", {
      message: e.message || String(err),
      name: e.name,
      stack: e.stack,
      surface,
      properties: { via, ...(extra ?? {}) },
    });
  } catch {
    // Never let error reporting throw and mask the original failure.
  }
}

/** Install global window.onerror + unhandledrejection forwarders for one root. */
export function installRendererErrorHandlers(surface: string): void {
  window.addEventListener("error", (e: ErrorEvent) => {
    report(surface, e.error ?? e.message, "window.onerror");
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    report(surface, e.reason, "unhandledrejection");
  });
}

interface Props {
  surface: string;
  children: React.ReactNode;
}
interface State {
  hasError: boolean;
}

/** Per-root React boundary: reports render/lifecycle throws, then fails quietly. */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    report(this.props.surface, error, "react-error-boundary", {
      componentStack: info.componentStack ?? undefined,
    });
  }

  render(): React.ReactNode {
    // Render nothing on a crash rather than a white-screen loop. Rare path; the
    // exception is already reported and the tray/global-hotkey keep the app live.
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
