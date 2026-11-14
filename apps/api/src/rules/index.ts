// Rule registry. Owned by rules-engineer; the engine (apps/api/src/findings/) imports RULES from here.
// Order = RULE_IDS order. Scopes per rule (and why) are documented at the top of each file:
// - incident only (lag causes; outside an incident they'd fire on healthy servers): entity-explosion,
//   tile-entity-hotspot, plugin-change-before-lag, player-count-threshold, view-distance-too-high, live-chunk-generation
// - server + incident (host/runtime states worth knowing before an incident): gc-pressure, thermal-throttling,
//   swap-in-use, plugin-exceptions
// - server only (configuration, visible in every hello): jvm-flags
import type { Rule } from "./types.js";
import { entityExplosion } from "./entity-explosion.js";
import { tileEntityHotspot } from "./tile-entity-hotspot.js";
import { pluginChangeBeforeLag } from "./plugin-change-before-lag.js";
import { playerCountThreshold } from "./player-count-threshold.js";
import { gcPressure } from "./gc-pressure.js";
import { thermalThrottling } from "./thermal-throttling.js";
import { swapInUse } from "./swap-in-use.js";
import { viewDistanceTooHigh } from "./view-distance-too-high.js";
import { liveChunkGeneration } from "./live-chunk-generation.js";
import { pluginExceptions } from "./plugin-exceptions.js";
import { jvmFlags } from "./jvm-flags.js";

export const RULES: Rule[] = [
  entityExplosion,
  tileEntityHotspot,
  pluginChangeBeforeLag,
  playerCountThreshold,
  gcPressure,
  thermalThrottling,
  swapInUse,
  viewDistanceTooHigh,
  liveChunkGeneration,
  pluginExceptions,
  jvmFlags,
];
