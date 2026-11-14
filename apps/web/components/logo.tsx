import { brand } from "@tickdoctor/shared";

// Original mark: a heartbeat line built from square blocks, one teal "pixel" at the peak.
const cells: [number, number][] = [
  [0, 4], [1, 4], [2, 3], [3, 1], [4, 6], [5, 4], [6, 4], [7, 4],
];

export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {cells.map(([x, y]) => (
        <rect
          key={`${x}-${y}`}
          x={x * 3}
          y={y * 3}
          width="2.6"
          height="2.6"
          rx="0.4"
          fill={x === 3 ? "var(--accent)" : "currentColor"}
        />
      ))}
    </svg>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-lg font-semibold tracking-tight">
      <LogoMark />
      {brand.name}
    </span>
  );
}
