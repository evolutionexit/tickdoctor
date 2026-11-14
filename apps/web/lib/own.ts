/** Own-property lookup for maps keyed by user-controlled strings (`__proto__`, `constructor`, ...). */
export function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}
