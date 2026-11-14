"use client";

import type { MetricName } from "@tickdoctor/shared";
import type { Aligned } from "@/lib/chart-data";
import { lastValue } from "@/lib/chart-data";
import { bytes, num } from "@/lib/format";
import type { LiveSample } from "@/lib/hooks";
import { Card } from "../ui";

function Spark({ xs, values }: { xs: number[]; values: (number | null)[] }) {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const w = 120;
  const h = 26;
  const x0 = xs[0] ?? 0;
  const span = Math.max(1, (xs[xs.length - 1] ?? x0) - x0);
  const segs: string[][] = [[]];
  values.forEach((v, i) => {
    if (v === null) {
      if (segs[segs.length - 1]?.length) segs.push([]);
      return;
    }
    const x = (((xs[i] ?? x0) - x0) / span) * w;
    const y = h - 2 - (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * (h - 4);
    segs[segs.length - 1]?.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" className="mt-2 text-accent-text">
      {segs.filter((s) => s.length > 1).map((s, i) => (
        <polyline key={i} points={s.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

interface Def {
  metric: MetricName;
  label: string;
  hint: string;
  live?: (s: LiveSample) => number | null;
  fmt: (v: number) => string;
}

export function HostPanel({ data, live, memTotal }: { data: Aligned | null; live: LiveSample | null; memTotal?: number }) {
  const defs: Def[] = [
    { metric: "host_cpu", label: "CPU", hint: "How busy the whole machine is.", live: (s) => s.hostCpu, fmt: (v) => `${(v * 100).toFixed(0)} %` },
    { metric: "cpu_temp_c", label: "Temperature", hint: "CPU temperature. Small boards slow down when they get hot.", live: (s) => s.cpuTempC, fmt: (v) => `${num(v)} °C` },
    { metric: "mem_available_bytes", label: "RAM available", hint: memTotal ? `Memory the machine can still use, out of ${bytes(memTotal)}.` : "Memory the machine can still use.", live: (s) => s.memAvailableBytes, fmt: bytes },
    { metric: "swap_used_bytes", label: "Swap used", hint: "Disk used as slow memory. It should stay close to zero.", live: (s) => s.swapUsedBytes, fmt: bytes },
    { metric: "disk_used_bytes", label: "Disk used", hint: "Space used on the server's disk.", fmt: bytes },
  ];
  const tiles = defs
    .map((d) => {
      const series = data?.values[d.metric];
      const fromLive = live && d.live ? d.live(live) : null;
      const value = fromLive ?? lastValue(series);
      return { d, value, series };
    })
    .filter((t) => t.value !== null); // never show 0 for a metric the server doesn't send

  return (
    <Card>
      <h2 className="text-lg font-semibold">Host machine</h2>
      {tiles.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          This server doesn&apos;t report machine stats (CPU, temperature, memory, disk), or hasn&apos;t sent any in this time range.
        </p>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          {tiles.map(({ d, value, series }) => (
            <div key={d.metric} className="rounded-md border border-line p-3">
              <dt className="text-xs uppercase tracking-wide text-muted">{d.label}</dt>
              <dd className="mt-1 font-mono text-xl font-semibold">{d.fmt(value as number)}</dd>
              {data && series ? <dd><Spark xs={data.xs} values={series} /></dd> : null}
              <dd className="mt-2 text-xs text-muted">{d.hint}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}
