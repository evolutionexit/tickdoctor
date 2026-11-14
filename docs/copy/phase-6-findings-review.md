# Phase 6: read-through of the 11 rules' finding texts

Read as a server owner who plays Minecraft but doesn't know Java. Sources: `apps/api/src/rules/*.ts` and the real Pi findings in `docs/phase-reports/phase-4.md`. Rule files were not edited. "Keep" = fine as is. Rewrites are suggestions for the rules-engineer; numbers in `{braces}` stay filled by the rule.

## Cross-cutting issues (apply to several rules)

1. **"Tick" is used before it's explained.** Most explanations say "every tick" / "20 ticks per second". The UI glossary line fixes this once ("each tick has 50 ms"); rules can then rely on a `?` tooltip on the word "tick". Suggestion for the finding card: underline "tick", "TPS", "heap", "chunk", "swap" with the glossary tooltip.
2. **Certainty.** Several texts state a cause as fact from circumstantial data ("so something was loading new land by itself", "the machine runs out of time per tick"). Prefer "probably", "most likely", "this points to". Listed per rule below.
3. **"During the lag" in server-scope findings.** Config rules (view-distance, jvm-flags) sometimes read as if tied to an incident. Fine when linked to one; check the wording when the finding is shown on the findings page alone.
4. **Config file jargon.** Many fix steps end with `paper-world-defaults.yml` / `spigot.yml` keys. They are correct but intimidating. Suggest the card shows the first 2–3 steps normally and puts YAML steps under "Optional, for when the simple steps aren't enough" (the UI string `card.advanced.note` exists). That needs the rules to mark such steps, or the UI to detect steps containing a `.yml` file name.
5. **`/kill` commands.** Several fixes hand the owner a `/kill @e[...]`. Good that they say "look first". Two gaps: (a) `distance=..24` only works when run in-game, from the console it matches nothing; say "run this in-game while standing there"; (b) wording should never imply it's safe: "removes everything of that type nearby, including named pets" appears only for the mixed case. Add it to the others.
6. **"usually none" / "usually there are no entities loaded at all".** Reads fine for a healthy server with no baseline; but on a brand-new server a baseline of "none" can mislead. Fine as long as the UI says "usually" and shows the baseline window ("compared with {n} healthy minutes").
7. **Numbers with two baselines of different kinds** ("95th percentile", "p95") appear in labels. Owners won't know it. Use "slowest 5 % of ticks" everywhere (the UI does).

---

## 1. entity-explosion

Old title: "Far more villagers and other mobs than usual"
→ New: "Far more villagers and other creatures than usual" when the group includes dropped items. Why: the real Pi finding lists 147 dropped items; items are not mobs. Or "...and other entities" if you accept the word "entities" (it is used elsewhere on the page).

Old: "There are 450 villagers, 151 chickens and 147 dropped items in the world `world`, spread over 25 chunks (the most around X 3,016, Z 3,032); usually there are no entities loaded at all. Villagers are among the most expensive mobs: each one keeps looking for a job site, a bed and a path. The server updates every one of them on every tick, and for a Raspberry Pi this many takes a large part of each of the 20 ticks per second."
→ New: "There are 450 villagers, 151 chickens and 147 dropped items in the world `world`, spread over 25 chunks (most of them around X 3,016, Z 3,032). Usually your server has almost none loaded. Villagers are the most expensive mobs: each one keeps searching for a job block, a bed and a path. The server has to update every one of them 20 times a second, and a Raspberry Pi has little time to spare, so this many take up a large part of it."
Why: "chunks" unexplained but the /tp buttons cover it; "usually there are no entities loaded at all" sounds odd ("no entities"). "The most expensive" is true and is stronger than "among". Keep the Pi-specific clause only when hardware is an SBC (already done). Certainty is fine: counts are measured, the cost claim is general knowledge, and the finding says "takes a large part", not "caused".

Old fix, step 3: "Turn off breeders (remove the beds or food) and reduce the number: `/kill @e[type=minecraft:villager,distance=..24,limit=50]` removes at most 50 nearby; look first so you don't remove villagers someone trades with."
→ New: "Switch off the breeders (take away the beds or the food). To thin them out, stand in the chunk and run `/kill @e[type=minecraft:villager,distance=..24,limit=50]`. It removes up to 50 villagers within 24 blocks, including ones players trade with, so look around first."
Why: must say "in-game, standing there"; "someone trades with" is vague about the risk.

Old step 5: "In `paper-world-defaults.yml` let villagers look for job sites and beds less often: under `tick-rates.sensor.villager` set `secondarypoisensor: 80`..."
→ Keep content, move under the "Optional / advanced" marker, and add "(Paper setting; restart afterwards)". Why: jargon, and it's the step most likely to be copy-pasted wrongly; also note that these keys differ between Paper versions (TODO rules-engineer: confirm they exist in the Paper version the Pi runs).

Old step 1: "Go to the busiest chunk: use the /tp buttons (the chunks are listed busiest first), or `/tp @s 3016 ~ 3032`." Keep. Why: concrete, works.

Title variant "Too many {name} in one chunk": keep.

---

## 2. tile-entity-hotspot

Old title (incident): "Too many hoppers packed into one chunk" Keep. "block entities" in the mixed case is jargon: → "Too many machines and storage blocks packed into one chunk". Why: owners know hoppers/furnaces/chests, not "block entities".

Old (incident): "There are {n} hoppers{where}{usual}. Every hopper checks for items above it and tries to move items several times per second, so hundreds of them in one place take a noticeable part of every tick."
Keep, but "several times per second" is vague and "tick" unexplained; fine with the tooltip.

Old title (early warning): "Early warning: a very large hopper build is costing tick time"
→ New: "Early warning: a very large hopper build is slowing the server a little". Why: "costing tick time" is jargon.

Old explanation: "About 1,280 hoppers sit in a single chunk in the world `world` around X 3,032, Z 3,032, and 5 chunks there have 500 or more (about 3,841 together; the world has 5,120 hoppers in total). The server doesn't lag yet, but since they appeared each tick takes about 4.2 ms longer (4.3 ms instead of 0.1 ms). With more players or more builds like this, that adds up to lag."
→ New: "About 1,280 hoppers sit in a single chunk of `world`, around X 3,032, Z 3,032. Five chunks there hold 500 or more each (about 3,841 together), and the world has 5,120 hoppers in total. The server isn't lagging yet, but each tick now takes about 4.2 ms longer than before (4.3 ms instead of 0.1 ms; a tick has 50 ms). That is probably because of these hoppers. With more players or more builds like this, it adds up to lag."
Why: explains the budget (50 ms) so "4.2 ms" has meaning; "since they appeared ... longer" implies causation, so add "probably". Also: "(estimated)" appears in evidence labels with no explanation. Tooltip text: "Counts for packed chunks are estimates from a sample of the world."

Fix: keep. The warning on `hopper-check: 8` is excellent (what breaks, how to revert). Step 3 `hopper.ignore-occluding-blocks: true` is jargon plus a risk: add "(this can change how some item sorters behave)" only if true (TODO rules-engineer confirm; I believe it can affect hoppers fed from above through transparent blocks).

---

## 3. plugin-change-before-lag

Old title: "The server got slower after {plugin} was updated" Keep. It states what was seen (after), not the cause. Good.

Old: "{what} {ago} before this lag started. Since then the average tick takes {after} ms instead of {before} ms with the same number of players online, so the change is the most likely cause."
→ New: "{what} {ago} before this lag started. Since then the average tick takes {after} ms instead of {before} ms with the same number of players online. That points to this change as the likely cause, but it can't prove it."
Why: "most likely cause" is a strong claim from timing alone; the honest hedge costs 8 words. "average tick takes X ms" needs the "50 ms per tick" context (tooltip).

Fix steps: good structure (back up, roll back, watch a day, decide). Two suggestions.
- "Make a backup of the `plugins/` folder first." Keep, but say "copy the whole `plugins` folder somewhere safe". Why: non-experts may not know a backup is just a copy.
- "Keep the plugin's config folder (back it up too, newer versions sometimes rewrite it)." Keep.
- Last step: "If the lag stays the same, the change wasn't the cause: put the new version back..." Keep. Honest and testable.

---

## 4. player-count-threshold

Old title: "The server starts lagging above about {safe} players" Keep. Clear to owners.

Old: "Over the last week the server kept up well with up to {safe} players, but with {n} or more it lagged in {x} % of the minutes. Each extra player adds chunks, mobs and redstone that have to be updated every tick, and at this point the machine runs out of time per tick."
→ New: "Over the last week the server kept up well with up to {safe} players. With {n} or more, it lagged in {x} % of the minutes. Every extra player means more chunks, mobs and redstone to update, and around this number your machine probably can't finish all of it in time."
Why: "runs out of time per tick" is jargon and certain. Also say what "lagged" means in one phrase in evidence: "Minutes with slow ticks".

Evidence labels: "Slowest ticks with {n}+ players (95th percentile)" → "Slowest ticks with {n}+ players (the worst 5 %)". "max-players setting" → "Your max-players setting".

Fix: first step ("check the other findings first") is the right call. Step 4 gives `per-player-mob-spawns` and `spawn-limits.monster: 50` with the explanation "default -1 means vanilla 70": keep the explanation, but move to "Optional / advanced". Last step "set max-players={safe}" is concrete and blunt: say so ("it caps how many can join; a stop-gap until you move to faster hardware"). Why: owners should know it has a cost to the community.

---

## 5. gc-pressure

Old title: "The server is running out of memory (heap too small)"
→ New: "The server is running low on memory (Java's memory limit is too small)". Why: "heap" is Java jargon; "running out" overstates (it's still running).

Old: "Even right after Java cleans up memory, {x} % of the {size} heap stays in use, so it has to clean up again and again. Each clean-up briefly freezes the server; right now that adds up to {y} % of the time, which players feel as lag spikes."
→ New: "Even right after Java cleans up memory, {x} % of the {size} it's allowed to use is still taken, so it has to clean up again and again. Each clean-up briefly freezes the server. Right now that adds up to {y} % of the time, and players can feel it as lag spikes."
Why: "heap" explained inline; "which players feel" → "can feel" (we don't know players noticed). It correctly says what was measured. Keep the structure (what's wrong → evidence).

Evidence labels: "Heap still in use after clean-ups" → "Memory still in use after a clean-up". "Heap limit (-Xmx)" → keep, the flag in brackets is useful when they edit the script. "Full clean-ups (whole server frozen)" is good; explain once "A full clean-up stops everything".

Fix: the can-grow steps are the best-written in the set (where to edit, what to type, how to check). Keep. One tweak, step 3: "Restart the server and check that this finding clears within an hour of normal play." → "...and check back in an hour or two of normal play. If this finding is gone, mark it as fixed." Why: ties to the Mark as fixed flow. Step 4 ("something keeps growing... restart once a day") is hedged enough; add "probably" ("something probably keeps growing").

---

## 6. thermal-throttling

Old title: "The CPU is overheating and slowing itself down" Keep.

Old: "The CPU is at {t} °C (usually {u} °C) and is running at reduced speed to cool off (thermal throttling). A slower CPU needs longer for every tick, so the server lags even though nothing in the game changed."
Keep. Two edits: "so the server lags even though nothing in the game changed" is certain; fine when throttling is measured, but the finding can fire without lag. → "so the server lags even though nothing in the game changed" only if `lag` is true, else "so the server can lag". Also "(thermal throttling)" is fine as a search term.

Old title (power): "The power supply is too weak, so the CPU slows down" → "The power supply is probably too weak, so the CPU slows down". Why: the board reports under-voltage; the cause could also be a poor cable. Add "(or its cable)" in the explanation.

Fix: concrete and kind to Pi owners. Keep. "`vcgencmd get_throttled` should print `throttled=0x0` after a reboot" is exactly the kind of check an owner can do. The "overclocked ... remove `arm_freq`" step fits only some owners; fine as "If you overclocked it".

---

## 7. swap-in-use

Old title: "The machine is running out of memory and swapping"
→ New: "The machine ran out of RAM and is using its disk as memory (swap)". Why: "swapping" is jargon; also "running out" vs measured swap use.

Old: "{x} of memory has been moved to swap and {why}. Swap is far slower than RAM; when the server needs memory that was swapped out, ticks and garbage collection have to wait for it, which shows up as lag spikes."
→ New: "{x} of memory has been moved to swap, which is the disk acting as extra memory, and {why}. Disk is far slower than RAM, so whenever the server needs something that was moved there it has to wait, which shows up as lag spikes."
Why: drop "garbage collection" (jargon, adds nothing for the reader); define swap on first use. "which shows up as lag spikes" is measured-adjacent, OK; "can show up" is safer when no incident is linked.

Fix: step 1 (`free -h`, `top` + `Shift+M`) is fine for owners who have SSH. Step 4 (the zram nuance) is correct and valuable for Raspberry Pi OS but is a wall of text. Suggest splitting: "Check what kind of swap it is with `swapon --show`." then two short lines: "If it lists `/dev/zram0`: this is compressed memory, normal on Raspberry Pi OS. Leave `vm.swappiness` alone and use the steps above." / "If it's a file or partition on disk: `sudo sysctl vm.swappiness=10` makes Linux prefer RAM. Add `vm.swappiness=10` to `/etc/sysctl.conf` to keep it after a restart." Why: scannable. The final step "the machine needs more RAM" is honest.

---

## 8. view-distance-too-high

Old title: "View or simulation distance is too high for this hardware"
→ New: "View or simulation distance is probably too high for this hardware". Why: it's a heuristic against a budget, not a measured fault.

Old: "The server keeps {n} chunks loaded with view distance {v} and simulation distance {s}, more than {hw} handles comfortably (around {mv} / {ms}). Every simulated chunk around each player is updated on every tick, so the work grows quickly with the distance and the number of players."
→ New: "The server keeps {n} chunks loaded (view distance {v}, simulation distance {s}). That is more than {hw} usually handles comfortably (around {mv} / {ms}). View distance is how far players can see; simulation distance is how far away mobs, crops and redstone keep running. The further they reach, the more the server has to update, and it grows quickly with every player."
Why: neither setting is defined anywhere in the original, and an owner may only know one. "Around {mv}/{ms}" needs "view / simulation" labels. Evidence labels already say "recommended here: X or less", good.

Fix: Good. Step 1's trade-off sentence ("Players will see a bit less far, and ..." / "Players still see as far as before") is exactly right. Step 3 about per-world overrides in `spigot.yml` is correct but advanced; keep it as the last "optional" step. The final step ("watch the next busy evening") is good, hint at the Mark-as-fixed flow.

---

## 9. live-chunk-generation

Old title: "Lag while new land is being generated" Keep. Plain, vivid.

Old (no players): "During the lag the server generated about {n} new chunks per minute (usually {u}) while no players were online, so something on the server was loading new land by itself: a force-loaded area (`/forceload`), a pre-generation tool running at the wrong time, or a plugin that loads far-away chunks (for example for teleports, maps or world borders). The server froze for up to {t} seconds at a time and TPS fell to {tps}. Creating new terrain is heavy work for the CPU and holds up the server until it's done."
→ New: "During the lag the server created about {n} new chunks per minute (usually {u}) while nobody was online. That probably means something on the server was loading new land by itself: an area kept loaded with `/forceload`, a pre-generation tool (like Chunky) running at the wrong time, or a plugin that loads far-away land (random teleport, map or world-border plugins). The server froze for up to {t} seconds at a time and TPS fell to {tps}. Creating new terrain is heavy work for the CPU, and the server waits until it's done."
Why: "so something ... was loading" is an inference; "probably" is honest. A "chunk" is "a 16 × 16 block column of the world": use the glossary tooltip.

Fix, step 4 and 5 ("Install the Chunky plugin...", "Pre-generate...") are written as if the owner always needs Chunky, even when step 1 may find a `/forceload` area. Suggest ordering: steps 1–3 (find the cause), then "If it's players exploring or the cause isn't clear: ...pre-generate". Also:
- Step 5 "centre on your spawn coordinates (or the middle of where people play)": but the lag area in the real Pi run was around X 3,000, nowhere near spawn. Say "the area that was being generated (see the chunk list above if it shows coordinates), or your spawn".
- Step 6, the world border: `/worldborder set 6000` can lock players out of existing far-away bases and is the riskiest command in the whole fix list. Old: "Set a world border around the same centre so no new chunks get created during play..." → New: "Optional, and only if nobody has built outside it: set a world border around the same centre so no new land is created while people play: `/worldborder center <x> <z>`, then `/worldborder set 6000` (twice the radius). Players can't go past the border, so check where everyone lives first."
- "On a Raspberry Pi this can take many hours" good, honest; keep.

---

## 10. plugin-exceptions

Old title: "{plugin} keeps throwing errors" / "The same error keeps repeating in the server log"
→ New: "Errors from {plugin} keep repeating" . Why: "throwing" is programmer slang; also the plugin is inferred from the Java package name, so don't assert it too hard. For the unknown case "The same error keeps repeating in the server log" is fine.

Old: "{who} reported {n} errors in {m} minutes (about {p} a minute), mostly {cls}. Something in it is failing again and again; writing each error to the log takes server time, and whatever the plugin was trying to do isn't working."
→ New: "{who} reported {n} errors in {m} minutes (about {p} a minute), mostly `{cls}`. The same thing is failing again and again, so whatever the plugin was trying to do probably isn't working, and writing each error to the log costs the server a little time."
Why: `{cls}` (for example NullPointerException) is meaningless to owners: add a gloss when it's one of the well-known ones: "NullPointerException (the plugin looked for something that wasn't there)". The cause-of-lag claim is not made, good: but the rule's severity should reflect that errors may not cause lag at all, and the UI should not present it as an explanation of the lag unless the numbers show it. TODO rules-engineer: confirm the plugin attribution can be wrong (shaded libraries, a plugin crashing inside another) and word "from {plugin}" as "from what looks like {plugin}" if so.

Fix: "Update {plugin} to its newest version (and check that it supports your Paper version, {mc})" is right. "The first lines of the error usually name the plugin's package (for example `com.example.someplugin`)" is useful for the unknown case. "report to the plugin's author, or remove it and restart to confirm the errors stop": keep. Add: "Send the author the lines from the log (use the server log, not a screenshot)".

---

## 11. jvm-flags

Five sub-findings; four are lag causes, two are tuning tips.

**a) memory limit above or near RAM** — Old title: "Java may use more memory than the machine has" / "Java's memory limit leaves too little for the rest of the machine". Keep both ("may" is right).
Old: "The server may use up to {x} for its Java heap, on a machine with {y} of RAM. Java needs some memory on top of the heap, and so does the operating system; when it runs out, the machine starts swapping to disk and every tick slows down."
→ New: "The server is allowed to use up to {x} of memory (Java's \"heap\"), on a machine with {y} of RAM. Java needs some on top of that, and so does the operating system. When the machine runs out, it starts using its disk as memory (swapping), which slows every tick."
Why: "heap", "swapping" glossed. Evidence "Suggested maximum heap" → "Suggested memory limit".

**b) memory size not set** — Old title "The server's memory size isn't set". Keep, add "(Java picks one)": "The server's memory limit isn't set, so Java picks one". Why: owner can't tell what's wrong from the title.
Old: "There is no -Xmx flag, so Java picked a heap size on its own ({x} of {y} RAM) and grows into it step by step. Setting the size yourself keeps memory use predictable and avoids extra garbage collection while the heap grows."
→ New: "Your start command doesn't say how much memory the server may use (the `-Xmx` setting), so Java chose {x} on its own, out of {y} RAM, and grows into it step by step. Setting it yourself keeps memory use predictable and avoids a few extra pauses while it grows."
Why: "garbage collection" gone.

**c) tiny memory limit** — Old title: "The server gets very little memory on a machine that has plenty" Keep, very clear (good example of the voice).
Old: "Java may use at most {x} for the server, while the machine has {y} of RAM. A Paper server with players, mobs and loaded chunks usually needs 2–4 GB; with less, Java has to clean up memory constantly and the server stalls under load."
→ New: "Java may use at most {x} for the server, while the machine has {y} of RAM. A Paper server with a few players usually needs about 2–4 GB; with less, Java has to clean up memory constantly and the server can stall under load."
Why: "usually needs 2–4 GB" is player-dependent; "can stall" not "stalls". Severity low is right: it's a cause only in combination with gc-pressure.

**d) slow garbage collector** — Old title: "The server uses a garbage collector that causes long pauses"
→ New: "The server is set to a memory cleanup mode that freezes it for long stretches". Why: "garbage collector" is jargon in the title.
Old: "The flag {flag} selects a garbage collector that freezes the whole server while it cleans up memory. Paper recommends G1 with Aikar's flags, which keeps those pauses short."
→ New: "The flag `{flag}` makes Java freeze the whole server while it cleans up memory. Paper recommends the G1 cleanup mode with \"Aikar's flags\", a set of Java options the Paper community tested to keep those freezes short."
Why: nobody knows who Aikar is or what G1 means; one clause explains both.

**e) Tuning tip: Xms ≠ Xmx** — Old title: "Tuning tip: starting memory and maximum memory are different" Keep (the real Pi finding F reads well).
Old: "The server starts with 1 GB of heap (-Xms) and may grow to 3 GB (-Xmx). This is not why a server lags, but setting both to the same value is the recommended setup for Paper: Java then doesn't have to grow and shrink the heap, which avoids a few small extra pauses, and the memory is reserved up front."
→ New: "The server starts with 1 GB of memory (`-Xms`) and may grow to 3 GB (`-Xmx`). This isn't why your server lags. Paper recommends setting both to the same value: Java then doesn't have to grow and shrink its memory, which avoids a few small pauses, and the memory is reserved up front."
Why: "heap" → "memory", flags kept in code because they're what the owner edits. The last step "This finding clears by itself once the new values are reported." → "...once the server restarts and reports the new values." (a restart is required; "reported" alone hides that).

**f) Tuning tip: Aikar's flags missing** — Old title: "Tuning tip: the Java flags recommended for Paper aren't used"
→ New: "Tuning tip: your server doesn't use the Java settings Paper recommends". Why: "flags" is jargon in the title.
Old: "The server runs with Java's default memory-cleanup settings, which are tuned for business software rather than games. This is not why a server lags, but Paper recommends Aikar's flags: they keep garbage-collection pauses shorter and less frequent, which avoids small spikes."
→ New: "The server uses Java's default memory-cleanup settings, which are meant for general-purpose programs rather than games. This isn't why your server lags. Paper recommends \"Aikar's flags\", a set of options that keeps the cleanup freezes shorter and less frequent, which avoids small spikes."
Why: "tuned for business software" is a claim we can't back up; "general-purpose" is accurate. Evidence label "Garbage-collection tuning flags (Aikar's set has 17)": → "Cleanup tuning options in use (the recommended set has 17)". Value 0 is clear.

Tips never trigger alerts and live in their own section, so the "Tuning tip:" prefix in the title is redundant there but useful in an exported/shared view: keep.

---

## Summary table

| Rule | Verdict | Main changes |
|---|---|---|
| entity-explosion | Rewrite (small) | "mobs" is wrong for dropped items; `/kill` only in-game; YAML steps to "optional" |
| tile-entity-hotspot | Rewrite (small) | Explain 50 ms budget; hedge "since they appeared"; "block entities" jargon |
| plugin-change-before-lag | Rewrite (one sentence) | "most likely cause" → "points to... can't prove it" |
| player-count-threshold | Rewrite (small) | Hedge "machine runs out of time", "95th percentile" labels, mention max-players cost |
| gc-pressure | Rewrite (title + one sentence) | "heap" jargon, "players feel" → "can feel"; good fix steps |
| thermal-throttling | Keep + 2 hedges | "can lag" when no lag, "probably" for power |
| swap-in-use | Rewrite (small) | Define swap, drop "garbage collection", split zram step |
| view-distance-too-high | Rewrite (explanation) | Define both distances; "probably too high" |
| live-chunk-generation | Rewrite (explanation + fix order) | "probably" for the by-itself inference; world border warning; centre on the lagging area, not spawn |
| plugin-exceptions | Rewrite (small) | Title and attribution hedge; gloss exception class names |
| jvm-flags | Rewrite titles and glosses | Heap/GC/Aikar jargon in titles; Xms tip says restart needed |

Best-written already, use as the model for the others: gc-pressure's fix steps, jvm-flags "very little memory on a machine that has plenty", thermal-throttling's fix steps, plugin-change-before-lag's title.
