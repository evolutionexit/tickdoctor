import type { Metadata } from "next";
import { Faq, type FaqItem } from "@/components/faq";
import { PricingPlans } from "@/components/pricing-plans";
import { pageSocial } from "@/lib/og";
import { meta } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: meta.pricing.title },
  description: meta.pricing.description,
  alternates: { canonical: "/pricing" },
  ...pageSocial(meta.pricing.title, meta.pricing.description, "/pricing"),
};

// TODO(copy): "What happens when I hit a limit?" and "Can I change or cancel my plan?" still have TODO answers in
// pricing.md and are not shown. Founding-discount terms (amount, duration, who qualifies) are undecided.
const faq: FaqItem[] = [
  {
    q: "Can I pay today?",
    a: "Not yet. This is early access and there are no payments at all. Pro is free for everyone during the beta. Prices shown are our plan and may change before launch.",
  },
  {
    q: "What do I see on the Free plan?",
    a: "That something is wrong, how serious it is and when it happened, for every finding and incident. Pro adds why it happens, the evidence, the suggested fix, the \"what changed?\" comparison and the coordinates of the worst chunks. Tuning tips are free. During the beta every account has Pro, so nothing is hidden today.",
  },
  {
    q: "Is there a discount for early supporters?",
    a: "Yes. Pro is free for everyone during the beta, and early-access members get a founding discount when paid plans launch. We'll share the details before anything is charged.",
  },
];

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
      <h1 className="text-4xl font-bold tracking-tight">Pricing</h1>
      <p className="mt-3 max-w-2xl text-lg text-muted">
        Pro is free for everyone during the beta. When paid plans launch, early-access members get a founding discount.
      </p>
      <p className="mt-6 max-w-3xl rounded-md border border-line bg-surface p-4 text-sm" role="note">
        <strong className="text-accent-text">Early access, no payments yet.</strong> Pro is free for everyone during the beta,
        and nothing here can be bought today. Join the waitlist and early-access members get a founding discount when paid
        plans launch.
      </p>

      <div className="mt-10">
        <PricingPlans />
      </div>

      <section aria-labelledby="pricing-faq" className="mt-20 max-w-3xl">
        <h2 id="pricing-faq" className="text-2xl font-bold tracking-tight">Questions</h2>
        <div className="mt-6">
          <Faq items={faq} />
        </div>
      </section>
    </div>
  );
}
