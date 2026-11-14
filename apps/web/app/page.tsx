import type { Metadata } from "next";
import Link from "next/link";
import { brand } from "@tickdoctor/shared";
import { Faq, type FaqItem } from "@/components/faq";
import { FindingCard } from "@/components/finding-card";
import { Section } from "@/components/section";
import { WaitlistForm } from "@/components/waitlist-form";
import { exampleFinding, exampleSparkline, exampleTp } from "@/lib/example-finding";
import { pageSocial } from "@/lib/og";
import { meta } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: meta.home.title },
  description: meta.home.description,
  alternates: { canonical: "/" },
  ...pageSocial(meta.home.title, meta.home.description, "/"),
};

const proof = [
  "Built for Paper servers, including small ones on a Raspberry Pi or a cheap VPS.",
  // TODO(copy): verify in Phase 2 before stating any ms/tick figure.
  "Runs off the main thread and measures its own cost.",
  "Player IDs are hashed and IP addresses are never sent.",
];

const problems = [
  { t: "The TPS dropped.", b: "You know something is wrong, not what." },
  { t: "The profile is hard to read.", b: 'Method names and percentages, but no "do this".' },
  { t: "The lag is gone when you look.", b: "Spikes are short, and nobody was running a profile." },
];

const steps = [
  { t: "Install the plugin", b: "Drop one jar into your plugins folder and paste your server key. That's the whole setup." },
  {
    t: "It watches, quietly",
    b: `${brand.name} tracks tick time, entities, chunks and your host's health. When the server starts to lag, it captures a snapshot of that moment and compares it to how your server looks when it's healthy.`,
  },
  {
    t: "Read what's wrong",
    b: "You get findings in plain language: what's wrong, the evidence, and what to do about it. Optionally, a Discord message tells you as it happens.",
  },
];

const features = [
  { t: "Incident snapshots", b: "When lag starts, we save what the server looked like right then, so you can look later." },
  { t: '"What changed?"', b: "Compares a lag incident with your normal, healthy baseline and highlights what's different." },
  { t: "Worst chunks, with coordinates", b: "See which chunks hold the most entities and block updates, and teleport straight there." },
  { t: "Findings in plain language", b: "Each problem comes with the evidence and clear steps to fix it, no Java knowledge needed." },
  { t: "Host health", b: "Temperature, CPU throttling, swap and disk, which matters on a Raspberry Pi or a small VPS." },
  { t: "Discord alerts", b: "Get a message when your server starts lagging or goes down, with quiet hours so it doesn't wake you." },
  { t: "Public status page", b: "Share a simple page so your players can see if the server is up." },
];

// TODO(copy): re-check the ServerAnalytics row before launch.
const comparison = [
  {
    tool: "spark",
    best: "An excellent, free profiler (bundled with Paper). Shows exactly which code is slow right now.",
    not: "Watch your server over time, or explain results in plain language.",
  },
  {
    tool: "Plan",
    best: "Deep player analytics (joins, playtime, activity) in a self-hosted web panel.",
    not: "Diagnose lag causes. Performance graphs are there, but it's player-focused.",
  },
  {
    tool: "ServerAnalytics (Hangar, by clanme)",
    best: "Free, hosted analytics with a dashboard: TPS, MSPT, memory, entity and chunk counts, a health score, player stats, alerts (email, webhook, browser push, in-game chat) and a public status page.",
    not: `Its focus is monitoring and alerting. ${brand.name}'s focus is explaining causes: incident snapshots, "what changed?", plain-language fixes and host health (temperature, throttling, swap, disk).`,
  },
  {
    tool: brand.name,
    best: `Diagnosis over time: lag incident snapshots, "what changed?", worst chunks, plain-language findings, host health.`,
    not: "Replace a profiler. For deep code-level digging, use spark.",
    self: true,
  },
];

// TODO(copy): several answers carry TODOs (overhead figure, data list, supported software, launch date, self-hosting).
const faq: FaqItem[] = [
  {
    q: "Will it slow my server down?",
    a: "It is built not to. Heavy work runs off the main thread, and the plugin measures its own cost and reports it to you, so you can check.",
  },
  {
    q: "What data does it collect?",
    a: "Server performance numbers (tick time, TPS, memory, entity and chunk counts), your plugin list and versions, server settings, and host health such as CPU, temperature and disk if available. We don't read your world files, chat or console.",
  },
  {
    q: "What about my players' privacy?",
    a: "Player IDs are hashed before they leave your server, and the plugin never sends IP addresses. We can't tell who your players are. You can delete your account and all its data at any time.",
  },
  { q: "Which server software does it support?", a: "Paper 26.x for now." },
  {
    q: "Is it free?",
    a: "Yes, during the beta Pro is free for everyone, and nothing is charged. When paid plans launch, early-access members get a founding discount. There will also be a free plan for one server: it shows that something is wrong and how serious it is, and Pro adds why, the evidence and the fix.",
  },
  {
    q: "When does it launch?",
    a: "We're building it now. Join the waitlist and we'll email you when early access opens.",
  },
  {
    q: "Do I need spark?",
    a: `No, but they work well together. spark is great for deep profiling and ships with Paper. ${brand.name} tells you when and why to look.`,
  },
  { q: "Can I self-host it?", a: `Not at the moment. ${brand.name} is a hosted service.` },
];

export default function HomePage() {
  return (
    <>
      {/* 1. Hero */}
      <section aria-labelledby="hero-title" className="relative isolate overflow-hidden border-b border-line">
        <div className="bg-grid absolute inset-0 -z-10" aria-hidden="true" />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <p className="inline-flex items-center gap-2 font-mono text-sm text-accent-text">
              <span className="inline-block size-2 bg-accent" aria-hidden="true" />
              Early access, join the waitlist
            </p>
            <h1 id="hero-title" className="mt-4 text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">
              {brand.tagline}
            </h1>
            <p className="mt-5 max-w-xl text-lg text-muted">
              {brand.name} watches your server around the clock. When lag hits, it captures what changed and tells you
              what to fix, with coordinates.
            </p>
            <div id="waitlist" className="mt-8 max-w-xl scroll-mt-24">
              <WaitlistForm source="landing-hero" />
            </div>
            <ul className="mt-8 max-w-xl space-y-2 text-sm text-muted">
              {proof.map((p) => (
                <li key={p} className="flex gap-2.5">
                  <span className="mt-1.5 size-2 shrink-0 bg-accent" aria-hidden="true" />
                  {p}
                </li>
              ))}
            </ul>
          </div>
          <div className="min-w-0">
            <FindingCard
              finding={exampleFinding}
              tp={exampleTp}
              header={{ health: "lagging", detail: "MSPT 87 ms", sparkline: exampleSparkline }}
              footnote="Example data. We check again later and tell you if the problem is really gone."
            />
          </div>
        </div>
      </section>

      {/* 2. The problem */}
      <Section id="problem" title="Lag is easy to feel and hard to explain">
        <div className="grid gap-10 lg:grid-cols-2">
          <div className="prose-block max-w-xl text-muted">
            <p>Your TPS dropped. Players are complaining. By the time you open the console, everything looks fine again.</p>
            <p>
              A profiler like spark can tell you exactly where the time went, but only for the moment you ran it, and the
              report is written for people who read Java stack traces.
            </p>
          </div>
          <ul className="grid gap-3">
            {problems.map((p) => (
              <li key={p.t} className="rounded-lg border border-line bg-surface p-4">
                <p className="font-semibold">{p.t}</p>
                <p className="mt-1 text-sm text-muted">{p.b}</p>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* 3. How it works */}
      <Section id="how" title="Three steps, about five minutes">
        <ol className="grid gap-4 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.t} className="rounded-lg border border-line bg-surface p-5">
              <span className="font-mono text-sm text-accent-text">0{i + 1}</span>
              <h3 className="mt-2 text-lg font-semibold">{s.t}</h3>
              <p className="mt-2 text-sm text-muted">{s.b}</p>
            </li>
          ))}
        </ol>
      </Section>

      {/* 4. Example finding: the same real component as the hero, in full width layout */}
      <Section
        id="example"
        title="What a finding looks like"
        intro="Written like a doctor's note, not a stack trace. This is an example."
      >
        <FindingCard
          className="max-w-3xl"
          finding={{ ...exampleFinding, id: "example-section" }}
          tp={exampleTp}
          footnote={`Example data. ${brand.name} checks again later and tells you if the problem is really gone.`}
        />
      </Section>

      {/* 5. Features */}
      <Section id="features" title="What you get">
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f, i) => (
            <li
              key={f.t}
              className={`rounded-lg border border-line bg-surface p-5${i === features.length - 1 && features.length % 2 === 1 ? " sm:col-span-2 lg:col-span-3" : ""}`}
            >
              <span className="mb-3 block size-3 bg-accent" aria-hidden="true" />
              <h3 className="font-semibold">{f.t}</h3>
              <p className="mt-1.5 text-sm text-muted">{f.b}</p>
            </li>
          ))}
        </ul>
      </Section>

      {/* 6. Comparison */}
      <Section
        id="compare"
        title="How it compares"
        intro={`These tools solve different problems, and several are free (ServerAnalytics too). We think ${brand.name} works best next to spark, not instead of it.`}
      >
        <div
          className="overflow-x-auto rounded-lg border border-line"
          tabIndex={0}
          role="region"
          aria-label="Comparison table, scrolls horizontally"
        >
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <caption className="sr-only">How {brand.name} compares with other tools</caption>
            <thead className="bg-surface-2">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">Tool</th>
                <th scope="col" className="px-4 py-3 font-semibold">Best at</th>
                <th scope="col" className="px-4 py-3 font-semibold">What it doesn&apos;t try to do</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line bg-surface">
              {comparison.map((r) => (
                <tr key={r.tool} className={r.self ? "bg-surface-2/60" : undefined}>
                  <th scope="row" className="px-4 py-3 align-top font-semibold">
                    {r.tool}
                    {r.self ? <span className="ml-2 inline-block size-2 bg-accent" aria-hidden="true" /> : null}
                  </th>
                  <td className="px-4 py-3 align-top text-muted">{r.best}</td>
                  <td className="px-4 py-3 align-top text-muted">{r.not}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-5 max-w-3xl">
          Use spark when you want to dig into the code. Use Plan to understand your players. Use {brand.name} when you
          want to know why the server lagged last night, and what to do first.
        </p>
        <p className="mt-3 text-sm text-muted">
          Tool descriptions are based on their public pages and may be out of date. Tell us if we got something wrong.
        </p>
      </Section>

      {/* 7. Pricing teaser */}
      <section aria-labelledby="pricing-teaser" className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-4 rounded-lg border border-line bg-surface p-6 sm:flex-row sm:items-center">
          <div>
            <h2 id="pricing-teaser" className="sr-only">Pricing</h2>
            <p className="text-lg font-medium">
              Pro is free for everyone during the beta. Early-access members get a founding discount when paid plans launch.
            </p>
          </div>
          <Link href="/pricing" className="btn btn-ghost shrink-0">See pricing</Link>
        </div>
      </section>

      {/* 8. FAQ */}
      <Section id="faq" title="Questions">
        <div className="max-w-3xl">
          <Faq items={faq} />
        </div>
      </Section>

      {/* 9. Final CTA */}
      <section aria-labelledby="cta-title" className="border-t border-line bg-surface">
        <div className="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 sm:py-20">
          <h2 id="cta-title" className="text-3xl font-bold tracking-tight">Stop guessing why your server lags.</h2>
          <p className="mt-3 text-muted">Join the waitlist for early access. Free during the beta, no credit card.</p>
          <div className="mx-auto mt-8 max-w-xl text-left">
            <WaitlistForm source="landing-footer" visibleLabel="Your email" />
          </div>
        </div>
      </section>
    </>
  );
}
