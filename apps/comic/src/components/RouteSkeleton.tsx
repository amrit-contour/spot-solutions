// Shown inside the shell while a page's code loads: the nav stays put and this holds the page's place.
export function RouteSkeleton() {
  return (
    <div className="w-full px-4 pt-6 sm:px-8" role="status" aria-label="Loading">
      <div className="mb-6 h-9 w-48 animate-pulse rounded-lg bg-surface-high" />
      <div className="mb-4 h-12 w-full animate-pulse rounded-full bg-surface-high" />
      <div className="overflow-hidden rounded-xl bg-surface-low">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3 sm:px-5">
            <div className="size-10 flex-none animate-pulse rounded-full bg-surface-high" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-1/3 animate-pulse rounded bg-surface-high" />
              <div className="h-3 w-1/4 animate-pulse rounded bg-surface-high" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
