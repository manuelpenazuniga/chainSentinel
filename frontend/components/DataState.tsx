"use client";

import { ReactNode } from "react";

// ============================================================================
// DataState — unified loading / error / empty state wrapper (§4.4)
// ============================================================================
//
// Before this component, each panel (VaultStatus, ThreatFeed, ThreatChart,
// ActivityLog) implemented its own ad-hoc loading skeleton — some used animated
// placeholders, others rendered blank, others showed nothing at all. Errors
// were either swallowed or surfaced inconsistently.
//
// `DataState` centralizes the three states a data-fetching panel needs:
//
//   loading  → renders the children inside a skeleton-styled wrapper, or a
//              custom skeleton if the caller provides one.
//   error    → renders a compact error block with an optional "Retry" button.
//   empty    → renders the empty-state children (caller defines the message).
//   ready    → renders the children as-is.
//
// Usage:
//   <DataState
//     loading={isLoading}
//     error={error}
//     empty={items.length === 0}
//     onRetry={refetch}
//     emptyMessage="No threats reported yet"
//   >
//     <List items={items} />
//   </DataState>
// ============================================================================

export interface DataStateProps {
  /** True while the underlying query is in flight. */
  loading?: boolean;
  /** An error from the data source, or null. Shown below the message. */
  error?: Error | string | null;
  /** True when the query succeeded but returned no data. */
  empty?: boolean;
  /** Optional callback wired to a "Retry" button on error. */
  onRetry?: () => void;
  /** Custom skeleton to render while loading. Defaults to a generic shimmer. */
  loadingFallback?: ReactNode;
  /** Message to display in the empty state. */
  emptyMessage?: string;
  /** Optional className applied to the wrapper for layout fine-tuning. */
  className?: string;
  /** The data-ready content — only rendered when not loading / error / empty. */
  children: ReactNode;
}

export function DataState({
  loading,
  error,
  empty,
  onRetry,
  loadingFallback,
  emptyMessage = "Nothing to show yet",
  className = "",
  children,
}: DataStateProps) {
  if (loading) {
    if (loadingFallback) return <div className={className}>{loadingFallback}</div>;
    return (
      <div className={`rounded-xl border border-gray-800 bg-gray-900/50 p-6 animate-pulse ${className}`}>
        <div className="h-5 bg-gray-800 rounded w-1/3 mb-4" />
        <div className="space-y-2">
          <div className="h-4 bg-gray-800 rounded w-3/4" />
          <div className="h-4 bg-gray-800 rounded w-1/2" />
          <div className="h-4 bg-gray-800 rounded w-2/3" />
        </div>
      </div>
    );
  }

  if (error) {
    const msg = typeof error === "string" ? error : error.message;
    return (
      <div className={`rounded-xl border border-red-900/50 bg-red-950/20 p-4 text-sm text-red-300 ${className}`}>
        <div className="flex items-start gap-2">
          <span className="text-red-400 shrink-0">⚠</span>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-red-200 mb-0.5">Failed to load</p>
            <p className="text-xs text-red-400/80 break-words">{msg}</p>
          </div>
          {onRetry && (
            <button
              onClick={onRetry}
              className="text-xs px-2 py-1 rounded border border-red-800 hover:bg-red-900/40 text-red-300 transition-colors shrink-0"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (empty) {
    return (
      <div className={`rounded-xl border border-gray-800 bg-gray-900/30 p-6 text-center text-sm text-gray-500 ${className}`}>
        {emptyMessage}
      </div>
    );
  }

  return <>{children}</>;
}
