import { worldToDimension } from "@tickdoctor/shared";

/** Teleport command for a chunk. "~" keeps the player's height. Unknown world names can't be targeted with /execute in. */
export function chunkTp(world: string, cx: number, cz: number): { command: string; note: string | null } {
  const x = cx * 16 + 8;
  const z = cz * 16 + 8;
  const dim = worldToDimension(world);
  return dim
    ? { command: `/execute in ${dim} run tp @s ${x} ~ ${z}`, note: null }
    : { command: `/tp @s ${x} ~ ${z}`, note: `Go to the world "${world}" first, then paste this.` };
}
