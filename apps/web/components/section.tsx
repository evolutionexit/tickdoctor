export function Section({
  id,
  title,
  intro,
  children,
  className = "",
}: {
  id?: string;
  title: string;
  intro?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className={`mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20 ${className}`}>
      <h2 id={headingId} className="max-w-2xl text-2xl font-bold tracking-tight sm:text-3xl">
        {title}
      </h2>
      {intro ? <p className="mt-3 max-w-2xl text-muted">{intro}</p> : null}
      <div className="mt-8">{children}</div>
    </section>
  );
}
