/**
 * Minecraft dimension id for a Paper world name, for commands like `/execute in <dim> run …`.
 * Only the three default world names map (Paper's default level-name "world"); any other name (Multiverse etc.)
 * returns null, and callers must fall back to an in-game command without `/execute in` plus "go to that world first".
 * Never pattern-match suffixes: "creative_nether" is NOT minecraft:the_nether.
 */
export function worldToDimension(world: string): "minecraft:overworld" | "minecraft:the_nether" | "minecraft:the_end" | null {
  switch (world) {
    case "world":
      return "minecraft:overworld";
    case "world_nether":
      return "minecraft:the_nether";
    case "world_the_end":
      return "minecraft:the_end";
    default:
      return null;
  }
}
