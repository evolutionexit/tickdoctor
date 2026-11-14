export interface FaqItem {
  q: string;
  a: string;
}

export function Faq({ items }: { items: FaqItem[] }) {
  return (
    <div className="divide-y divide-line rounded-lg border border-line bg-surface">
      {items.map((item) => (
        <details key={item.q} className="group">
          <summary className="flex items-center justify-between gap-4 px-4 py-4 font-medium sm:px-5">
            <span>{item.q}</span>
            <svg className="faq-chevron shrink-0 text-muted transition-transform" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 2.5L10.5 8 5 13.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
            </svg>
          </summary>
          <p className="px-4 pb-4 text-muted sm:px-5">{item.a}</p>
        </details>
      ))}
    </div>
  );
}
