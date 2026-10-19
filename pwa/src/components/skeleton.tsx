type ResultSkeletonProps = { message?: string };

export function ResultSkeleton({ message = "Checking prices across retailers…" }: ResultSkeletonProps) {
  return (
    <section className="result-skeleton" aria-busy="true" aria-live="polite">
      <p className="sr-only">{message}</p>
      <div className="result-skeleton-product">
        <span className="skeleton skeleton-avatar" />
        <span className="skeleton-stack"><span className="skeleton skeleton-line skeleton-line-short" /><span className="skeleton skeleton-line skeleton-line-long" /><span className="skeleton skeleton-line skeleton-line-medium" /></span>
      </div>
      <div className="result-skeleton-heading"><span className="skeleton skeleton-line skeleton-line-medium" /><span className="skeleton skeleton-button" /></div>
      {[0, 1, 2, 3].map((item) => (
        <article className="skeleton-card retailer-skeleton-card" key={item} aria-hidden="true">
          <span className="skeleton skeleton-logo" />
          <span className="skeleton-stack"><span className="skeleton skeleton-line skeleton-line-medium" /><span className="skeleton skeleton-line skeleton-line-short" /></span>
          <span className="skeleton skeleton-price" />
        </article>
      ))}
    </section>
  );
}

export function HealthSkeleton() {
  return (
    <section className="product-health health-skeleton" aria-busy="true" aria-live="polite">
      <p className="sr-only">Checking product health information…</p>
      <div className="health-heading"><span className="skeleton skeleton-line skeleton-line-medium" /><span className="skeleton skeleton-line skeleton-line-short" /></div>
      <div className="health-skeleton-body"><span className="skeleton skeleton-health-score" /><span className="skeleton-stack"><span className="skeleton skeleton-line skeleton-line-long" /><span className="skeleton skeleton-line skeleton-line-medium" /><span className="skeleton skeleton-line skeleton-line-short" /></span></div>
    </section>
  );
}
