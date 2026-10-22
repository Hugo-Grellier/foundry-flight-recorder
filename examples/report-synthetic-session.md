# Session report — Session 1 - Crypt (20261003-2000-synA, 3 October 2026, 58 minutes)

Compared with **20261010-2000-synB**, Session 2 - Crypt (after fixes), 10 October 2026, also 58 minutes. Both began at 20:00 Europe/Paris (18:00 UTC). Evidence below uses corrected session-relative time. Session A is the default; B evidence is explicitly labelled. Actor labels identify combat turns; participant identifiers remain pseudonyms.

## 1. Executive summary

- **Targeting workflow merits the first table intervention (F4).** Three warnings, six target toggles, a targetless check and an explicit rules marker occurred inside a 250-second turn (+11:15.0–+15:25.0; `cjl1xllg9z4.85` → `cjl1xllg9z4.113`). Rehearse selecting targets and using the intended spell workflow before combat.
- **Reduce scene effects before considering hardware replacement (F2–F3).** One client recorded a 2.4-second stall with 1.9 seconds attributed to FXMaster (+17:02.0; `c3x7gnz6krl.131`–`c3x7gnz6krl.132`) and a 12.5-second scene load (+0:47.5; `c3x7gnz6krl.6`). Its session FPS median was 31. Test effects on the same client.
- **Recheck Toolbelt's share flow (F1).** A share-button click preceded an undefined-actor exception and a visible error (+16:20.0–+16:23.0; `crms8bk1ar1.117`, `crms8bk1ar1.116`, `crms8bk1ar1.120`). The stack implicates Toolbelt 2.1.0, without proving the underlying cause.
- **Prepare a disconnect fallback (F6).** A socket loss and new page load fell within a 180-second turn (+19:02.0–+22:02.0; `cjl1xllg9z4.150` → `cjl1xllg9z4.170`, `co0sfe2mmdm.124`, `cgjammyb6tw.1`).
- **Preserve the improvements observed in B, and verify them with complete coverage.** `ffr compare` reports turn p90 falling from 180 to 75 seconds, worst-client median FPS rising from 31 to 52, and no recorded stall, exception or friction marker in B. Multiple simultaneous configuration changes prevent causal attribution. A lost 253 events from `u_kyra`, so its interaction totals are incomplete.

## 2. Telemetry completeness and limitations

Source: `ffr sessions`, `info`, `digest`, `gaps`, expanded `around` windows, filtered `timeline`, `turns`, `perf`, and `compare`, with `FFR_DB=data/fixture.db`. The digest contained **one high and fifteen medium anomalies**. All are accounted for below: the marker, warnings, initial spellcasting repetitions and target toggles in F4; exception in F1; freeze in F2; both slow loads in F3; all four slow turns in F4/F6/F7; both later tab repetitions in F5; disconnect in F6. Lower-severity dialog closure and targetless check are also included in F4. Repeated detector entries describing the same sequence are not independent incidents.

### Recording coverage

| Participant | Client | Observed interval | Ending and loss |
|---|---|---|---|
| `u_gm` | `cjl1xllg9z4` | +0:00.0–+58:00.0 | Clean unload; no sequence gaps or reported drops |
| `u_kyra` | `crms8bk1ar1` | +0:20.0–+58:00.0 | `cleanUnload: true`, although final event is `rec.loss`; 253 missing and 253 reported dropped |
| `u_ezren` | `c3x7gnz6krl` | +0:35.0–+58:00.0 | Clean unload; no sequence gaps or reported drops |
| `u_valeros` | `co0sfe2mmdm` | +0:50.0–+19:07.0 | No clean unload; last event is socket disconnect |
| `u_valeros` | `cgjammyb6tw` | +20:37.0–+58:00.0 | New page-load client, clean unload; no sequence gaps or reported drops |

Four users recorded through five clients. The CLI cannot identify or count people who declined recording. For `u_kyra`, missing sequence ranges are 11–34, 183–285 and 326–451. Missing and reported-dropped counts describe overlapping loss, not 506 distinct events. All clients report empty `sampledOut` maps; no duplicates or rejected events are reported. No gaps in the first `u_valeros` client establish completeness after it stopped sending.

Every limitation returned by A's `info` applies:

1. `co0sfe2mmdm` stopped sending without unload/stop at +19:07.0: a crash, network loss or closed tab remain possible.
2. `crms8bk1ar1` has 253 events missing from its sequence, lost in transit or dropped.
3. That client reported 253 local-queue drops, consistent with an unreachable collector or overload.
4. Declining players send nothing; their behaviour is invisible except where observed by the GM client, such as chat or combat.
5. Only observable UI/hooks are recorded. Verbal table talk, voice and screen content are absent.

A contains 1,366 normal-mode and 27 diagnostic-mode events. Triggers escalated recording for 60 seconds; context-buffer events exist selectively near triggers. The Toolbelt click/focus evidence is explicitly `sample: context`. Event density therefore cannot measure attention or engagement. Combat turns, others' chat and connections depend on the active GM. Checks/chat can appear on author and GM clients; CLI aggregates deduplicate them, and paired observations below are not two rolls.

Times use estimated clock correction, including network latency; within-client sequence and cross-client time can differ, particularly for promoted context events. Small cross-client timing differences do not prove causation. Telemetry strings are quoted as untrusted observations; the contact request in the friction note was not acted on.

B has four clients, one per same pseudonym, all cleanly unloaded, with zero missing/dropped events, empty `sampledOut`, no recorded disconnects, and 1,500 normal-mode events. Its limitations are the same two general limits concerning non-recording participants and unobservable speech/screen content. Zero recorded problems is not proof that nobody experienced friction.

## 3. Critical technical issues

### F1 — Toolbelt exception after a share interaction

**Observed:** On `u_kyra`'s client, a `toolbelt-share` button click at +16:20.0 (`crms8bk1ar1.117`) and a hero-points field focus at +16:21.0 (`crms8bk1ar1.118`) preceded “Cannot read properties of undefined (reading 'actor')” at +16:22.0 (`crms8bk1ar1.116`). The stack names `onShare`, `modules/pf2e-toolbelt/scripts/main.js:1:4521`, and a button handler at `1:4402`; recorded version is 2.1.0. “An error occurred. See the console (F12).” followed at +16:23.0 (`crms8bk1ar1.120`). A targeted check still occurred at +16:35.0 (`crms8bk1ar1.122`); the turn ended after 45 seconds at +16:50.0 (`cjl1xllg9z4.129`).

**Interpretation (hypothesis):** The share handler received missing actor-related context.

**Alternatives:** A stale sheet/document, another module changing context, or an unexpected interaction state could have supplied the missing object. Field focus does not establish a hero-point change.

**Confidence:** High that the exception and notification occurred; medium for the share-flow hypothesis, supported by click context and stack. No matching Toolbelt or FXMaster source was found in the available repository files, and no module-repository location was provided, so the named frame could not be inspected. No code-level fix is established.

**Impact:** One visible error and probable interruption of that interaction. The subsequent roll and ordinary-length turn do not support a prolonged outage or quantified delay.

**Validation:** Repeat the share interaction with the same sheet/context on Toolbelt 2.2.0, checking the console and recording. B has that version and zero matching exceptions, but does not establish that the failing interaction was repeated.

### F2 — Slow rendering on the Intel client, including an FXMaster-attributed stall

**Observed:** At +17:02.0, `c3x7gnz6krl.131` records a 2,400 ms stall with 1,900 ms attributed to FXMaster; companion LoAF `c3x7gnz6krl.132` records 2,350 ms, 2,290 ms blocking, and the same script duration. Four lighting and six sight refreshes are reported. FXMaster 6.0.3 was present (`c3x7gnz6krl.3`, +0:35.0). The same client's Intel UHD 620/four-core environment is recorded in `c3x7gnz6krl.2` (+0:35.0); other recorded clients have RTX 3060/eight-core environments. `ffr perf` reports 31 median FPS and 48 ms median window-p95 frame time for this client, versus approximately 57–58 FPS and 22 ms elsewhere in this scene.

**Interpretation (hypothesis):** Scene effects and vision work imposed disproportionate load on this client; FXMaster is a plausible contributor.

**Alternatives:** Other scene work, browser scheduling or hardware constraints could contribute. Script attribution shows involvement, not exclusive root cause; GPU time is invisible.

**Confidence:** High for the measured stall and performance disparity; medium for the effects hypothesis. The source limitation in F1 also applies here.

**Impact:** A measured 2.4-second local rendering stall and sustained lower rendering throughput. It occurred during an NPC turn, ten seconds before the next PC turn began (+17:12.0; `cjl1xllg9z4.136`). It cannot explain the earlier targeting cluster, and does not establish minutes of combat delay.

**Validation:** Keep the effects-reduced B configuration as baseline; compare the same scene/client with one setting changed per controlled trial. Seek no stalls and a client FPS median at least near B's 52, without changing hardware first.

### F3 — Scene entry was slow initially and after reconnect

**Observed:** `u_ezren`'s scene load ran +0:35.0–+0:47.5, taking 12,500 ms (`c3x7gnz6krl.5` → `c3x7gnz6krl.6`). `u_valeros`'s replacement client took 9,000 ms from +20:37.0 to +20:46.0 (`cgjammyb6tw.5` → `cgjammyb6tw.6`), whereas its initial load took 3,500 ms (`co0sfe2mmdm.6`, +0:53.5). The scene summary records 4,000 × 3,000 dimensions, 14 tokens, 23 lights, nine animated lights and 410 walls (`c3x7gnz6krl.7`, +0:35.0).

**Interpretation (hypothesis):** Scene preparation/rendering load contributed to entry delays; the second load prolonged recovery from F6.

**Alternatives:** Asset delivery, cache state, network delay or unrelated client load could explain part of either duration. The RTX client's slow reload means the Intel hardware alone cannot explain both.

**Confidence:** High for both measured durations; low-to-medium for a shared cause.

**Impact:** 12.5 and 9 seconds of measured canvas-loading intervals, respectively. Initial entry is not proven to have delayed everyone. The reload interval is included within F6's recovery timeline and must not be added to it again.

**Validation:** Preload and enter the scene before combat, then repeat cold/warm loads on both clients. B's largest load was 6,000 ms (`cqol1cvp3i3.6`, +0:41.0); retain a comparable ceiling before simplifying scene content further.

## 4. Recurring usability friction

### F4 — Targeting and spell navigation clustered within a long turn

**Observed:** Round 1 turn 2 lasted 250 seconds, +11:15.0–+15:25.0 (`cjl1xllg9z4.85` → `cjl1xllg9z4.113`), five times the session PC median of 50 seconds. `u_ezren` selected the spellcasting tab at +11:20.0, +11:26.0 and +11:32.0 (`c3x7gnz6krl.74`, `.75`, `.77`). A CheckModifiersDialog opened at +11:55.0 and closed eight seconds later with no intervening recorded check (`c3x7gnz6krl.81`, `.83`). Three warnings said “You must target exactly one token.” at +12:10.0, +12:15.0 and +12:20.0 (`c3x7gnz6krl.85`, `.86`, `.88`). Six toggles alternated the same token on/off from +12:25.0 to +12:35.0, ending with zero targets (`c3x7gnz6krl.89`, `.90`, `.91`, `.93`, `.94`, `.95`).

At +12:45.0 a check labelled “Electric Arc” was recorded as `spell-attack-roll`, total 9, with `target: null` (`c3x7gnz6krl.97`; GM duplicate `cjl1xllg9z4.95`). At +13:15.0 the rules marker asked “how do I target two enemies with Electric Arc?” (`c3x7gnz6krl.102`; contact-request suffix omitted). A targeted check total 19 appeared at +14:35.0 (`c3x7gnz6krl.112`), followed by a hero-point reroll record, old 9/new 19, at +14:55.0 (`c3x7gnz6krl.116`).

**Interpretation (hypothesis):** Selecting targets and finding the intended spell flow required assistance or experimentation.

**Alternatives:** Deliberate testing, tactical discussion, misclicks, module interference or slow rendering can fit portions of the sequence. The marker supports a workflow question, not a judgement of understanding or competence.

**Confidence:** Medium-to-high for a targeting-workflow obstacle, because warnings, toggles, the targetless check and self-report corroborate one another. The exact rule/UI mistake remains uncertain without screen or voice data.

**Impact:** A 4-minute-10-second turn, 200 seconds above the PC median, containing an eight-second abandoned dialog and one recorded targetless check. This is elapsed time associated with the cluster, not 200 seconds proven wasted. The CLI reports a 110-second longest quiet gap; quiet describes observed activity, not silence at the table.

**Validation:** Rehearse targeting, opening the intended spell card, checking selected targets and resolving the spell before initiative. Repeat the same workflow with the target helper. Seek no warnings, repeated toggles or targetless attacks; compare turn duration with B's 75-second corresponding turn (`c1tvnwp2a07.85` → `.95`, +11:15.0–+12:30.0).

### F5 — Alternating sheet tabs amid telemetry loss

**Observed:** `u_kyra` alternated actions/spellcasting tabs every three seconds from +29:32.0 to +30:14.0 (15 observed tab events; `crms8bk1ar1.288` through `.320`). The digest's two medium repeat summaries cite later subsets: actions `.306`, `.311`, `.315`, `.320` at +29:56.0, +30:02.0, +30:08.0, +30:14.0; spellcasting `.304`, `.308`, `.313`, `.318` at +29:53.0, +29:59.0, +30:05.0, +30:11.0. These expanded times supersede the summaries' earlier labels. Loss notices are interleaved, including `.289` (+29:32.0) and `.321` (+30:14.0).

**Interpretation (hypothesis):** Finding an action or spell required repeated navigation.

**Alternatives:** Comparing options deliberately, demonstrating the sheet, or testing navigation could produce the same pattern. Loss reporting may reflect collection trouble rather than UI trouble. No evidence ties this later sequence to the Toolbelt exception approximately 13 minutes earlier.

**Confidence:** High for repeated switching; low for why, given missing telemetry and no accompanying friction note.

**Impact:** A 42-second navigation interval; no combat delay or abandoned action is demonstrated.

**Validation:** Ask what task was being attempted, then rehearse that task and pin a shortcut if useful. Repeat with zero collection loss; compare repetitions and completion, not just click counts.

## 5. Pathfinder 2e learning opportunities

F4 supports a brief, practical targeting demonstration and a check that the intended spell resolution is selected. The recorded Electric Arc check type is an observation about telemetry, not proof of the correct PF2e procedure. Verify the configured spell/item flow before teaching from it; the permitted evidence does not establish a rules adjudication or module defect.

The hero-point event in F4 supports demonstrating the reroll UI if requested, but one reroll does not establish resource misuse. `ffr pf2e`/digest deduplicate A to 13 checks (seven spell attacks and six attacks); the raw event count is 23 because GM observations overlap. Empty condition/action aggregates cannot establish that nobody used conditions or other actions verbally. There is no basis to rank participants or prescribe broader rules remediation.

## 6. Combat flow

For 12 recorded turns, A's median was 45 seconds, PC median 50, NPC median 25, and p90 180 (`ffr turns`). F4 explains the evidence cluster inside the longest turn; F6 and F7 cover the remaining three medium slow-turn anomalies.

### F6 — Disconnect overlapped a 180-second turn

**Observed:** Round 2 turn 3 lasted +19:02.0–+22:02.0 (`cjl1xllg9z4.150` → `.170`). At +19:07.0 the first `u_valeros` client recorded socket disconnect, reason “transport close” (`co0sfe2mmdm.124`), then stopped without clean unload. A new page-load client appeared at +20:37.0 (`cgjammyb6tw.1`), 90 seconds later, and its scene was ready at +20:46.0 (`cgjammyb6tw.6`). The next recorded attack was at +21:32.0 (`cgjammyb6tw.14`, GM duplicate `cjl1xllg9z4.166`). The turn analysis reports a 150-second longest quiet gap.

**Interpretation (hypothesis):** Reconnection and loading contributed substantially to this turn's duration.

**Alternatives:** Tactical/table discussion could occupy part of the same interval. A crash, network interruption or intentional page closure/reload could each explain the client transition; the socket reason does not distinguish them.

**Confidence:** High for disconnect/reload overlap; medium for its share of the delay. No recording describes the old client's missing interval.

**Impact:** A three-minute turn, 130 seconds above the PC median. There were 99 seconds between disconnect and the replacement scene becoming ready. These durations overlap and are not additive or wholly attributable to network failure.

**Validation:** Agree on a verbal/proxy action fallback, and test recovery before play. Inspect connectivity and browser crash evidence if it recurs. B records no disconnect and the corresponding turn lasts 40 seconds (`c1tvnwp2a07.128` → `.134`, +15:32.0–+16:12.0); that does not prove a particular networking fix.

### F7 — Two later 110-second turns remain only partly explained

**Observed:** Round 2 turn 2 ran +17:12.0–+19:02.0 (`cjl1xllg9z4.136` → `.149`); round 3 turn 2 ran +23:17.0–+25:07.0 (`cjl1xllg9z4.186` → `.199`). Each lasted 110 seconds (2.2 times the PC median), with a 70-second longest quiet gap. Targeted checks occurred 40 seconds into each turn, at +17:52.0 (`c3x7gnz6krl.140`) and +23:57.0 (`c3x7gnz6krl.179`), followed by 70 seconds until turn end. Each turn's activity includes one target event and one deduplicated check, also observed by the GM.

**Interpretation (hypothesis):** Resolution, discussion or turn completion after the check may account for the long tail.

**Alternatives:** Unobserved actions, deliberate planning, slow UI or a delayed advance of the tracker are equally possible. F2's stall preceded the first of these turns; it does not explain the repeated 70-second post-check interval by itself.

**Confidence:** High for durations and event timing; low for cause, with no explanatory marker or voice data.

**Impact:** Two 110-second turns, each 60 seconds above the PC median; no defensible estimate of avoidable time.

**Validation:** During a comparable encounter, note whether post-check time is discussion, damage/resolution or waiting to advance. Offer an end-turn prompt when appropriate. B's corresponding turns are each 75 seconds with 35-second quiet gaps (`c1tvnwp2a07.117` → `.127`, +14:17.0–+15:32.0; `.150` → `.160`, +17:27.0–+18:42.0).

## 7. Unexplained anomalies

### F8 — Collection loss limits interpretation of later activity

**Observed:** `ffr info` and `gaps` report 253 sequence-missing and 253 locally dropped events for `crms8bk1ar1`. At +29:32.0, loss notice `crms8bk1ar1.289` reports totalDropped 90; at +30:14.0, `.321` reports 122, interleaved with F5's tab events. No sampling-out counts are reported.

**Interpretation (hypothesis):** Collector reachability or queue overload caused loss.

**Alternatives:** Other ingest/transport failures can cause incomplete recording; these events do not identify an HTTP status or prove the Foundry connection itself failed. This is distinct from F6's socket loss on another client.

**Confidence:** High for incomplete collection; low for cause. The 253 missing IDs and reported drops must not be counted twice.

**Impact:** Lost visibility into `u_kyra`'s activity and performance; action/repetition totals are lower bounds. No amount of table delay can be inferred from the missing events.

**Validation:** Check recorder collector status and ingest/network failures before play, following `docs/troubleshooting.md`; address the observed failure mode rather than assuming rate limits. Require zero gaps and drops in `info`/`gaps` before interpreting next-session totals. B meets that criterion.

## 8. Recommendations for the GM (table, prep, communication)

| Priority | Action | Finding and purpose |
|---|---|---|
| 1 | Rehearse selecting one/two targets and the intended spell-card flow on the actual client before combat. | F4: address the corroborated workflow obstacle; verify the spell setup first. |
| 2 | Agree on a verbal/proxy fallback during disconnection; pause or advance the tracker explicitly. | F6: reduce recovery-related interruption without blaming a participant. |
| 3 | Ask what the alternating tabs were intended to accomplish; add a convenient shortcut only if needed. | F5: distinguish navigation difficulty from deliberate comparison. |
| 4 | Briefly identify what occupies post-check time, then offer an end-turn prompt if helpful. | F7: test the hypothesis without treating discussion as wasted time. |
| 5 | Enter/preload the scene before initiative. | F3: expose loading delays before a live turn. |

## 9. Prioritized technical fixes (modules, settings, scenes, hardware)

1. **F2–F3:** Retain B's removal of FXMaster 6.0.3 and disabled `core.visionAnimation` as the working baseline. Test the Intel client in the same scene before considering hardware changes. If further simplification is needed, trial fewer animated lights separately; scene counts alone do not prove overload.
2. **F1:** Retain Toolbelt 2.2.0 provisionally and reproduce the share operation. If it fails, collect the relevant module source and exact stack/context before proposing a patch; use a manual sharing fallback during play.
3. **F8:** Verify collector connectivity and recording health on `u_kyra`'s client before comparing interaction counts. Inspect actual failure statuses before changing limits or configuration.
4. **F4:** Evaluate `pf2e-target-helper` 1.0.0 with the rehearsed workflow. Its addition coincides with improvement, but telemetry does not demonstrate that it caused it or that its spell handling is correct.
5. **F6:** Check network/browser recovery if the disconnect recurs; do not attribute it to Toolbelt, FXMaster or hardware from this evidence alone.

## 10. Experiments for next session

| Finding | Controlled check | Success measure |
|---|---|---|
| F4 | Repeat the spell targeting flow before combat with helper configuration fixed. | Correct intended resolution, no target warnings/toggle loop/targetless attack; corresponding turn no slower than B's 75 s. |
| F1 | Repeat share on the same document/context with Toolbelt 2.2.0. | Share completes; no matching exception or visible error. |
| F2–F3 | Repeat scene entry and movement on the same Intel client; vary effects or vision animation one at a time outside live play. | FPS near or above B's 52 median, no ≥1 s stalls, scene load ≤6 s under comparable cache conditions. |
| F6 | Rehearse disconnect recovery and the verbal/proxy fallback outside combat. | Recovery is observable; no unexplained client disappearance or prolonged live turn. |
| F5/F8 | Repeat the intended sheet task with recorder status healthy. | Task completes with zero sequence gaps/drops; interpret repetitions only after coverage passes. |
| F7 | Record the reason for post-check waiting in a comparable combat. | Explain the quiet gap, then assess whether an end-turn prompt helps; preserve useful discussion. |

## 11. Changes to evaluate next time (what `ffr compare` should show if a fix worked)

The requested comparison runs chronologically **A → B**. B is later than the investigated session, so it is follow-up evidence, not a pre-A baseline. Both use Foundry 14.369 and PF2e 8.6.1. Module/settings evidence in A (`c3x7gnz6krl.3`–`.4`, +0:35.0) and B (`cqol1cvp3i3.3`–`.4`, +0:35.0) confirms:

- Added `pf2e-target-helper` 1.0.0.
- Removed FXMaster 6.0.3 and its `fxmaster.enable: true` setting.
- Upgraded Toolbelt 2.1.0 → 2.2.0.
- Changed `core.visionAnimation` true → false; configuration fingerprint fpA → fpB.

| Metric from `ffr compare` | A | B | Related finding |
|---|---:|---:|---|
| Recorded turns | 12 | 12 | F4/F6/F7 |
| Overall turn median / PC median | 45 / 50 s | 40 / 45 s | F4/F6/F7 |
| NPC median / overall p90 | 25 / 180 s | 25 / 75 s | F4/F6/F7 |
| Crypt worst-client median FPS (`u_ezren`) | 31 | 52 | F2 |
| Crypt aggregate median FPS | 58 | 58 | F2: aggregate conceals client disparity |
| Largest scene load | 12,500 ms | 6,000 ms | F3 |
| Recorded stalls | 1 | 0 | F2 |
| Matching Toolbelt exception | 1 | 0 | F1 |
| Friction markers | 1 | 0 | F4 |
| Target-toggle clusters / targetless attacks | 1 / 1 | 0 / 0 | F4 |
| Repeated-interaction groups / dialog closure without roll | 4 / 1 | 0 / 0 | F4/F5 |

These are session-level aggregates; the event windows supporting their interpretation are cited in F1–F7. B's concrete load improvement is `cqol1cvp3i3.5` → `.6` (+0:35.0–+0:41.0), with the same recorded Intel GPU/four-core environment (`cqol1cvp3i3.2`, +0:35.0). The follow-up turn spans are cited in F4/F6/F7. `info` separately shows disconnects falling from one to zero and missing/dropped counts from 253/253 to zero/zero, supporting better observability rather than proving all problems resolved.

Next time, preserve or improve B's coverage, no matching exceptions/stalls, no targeting-warning cluster, FPS and loading performance, and turn p90. Interpret condition/action/check totals cautiously: check counts fell from 13 to 12 after deduplication, which does not by itself measure learning or correctness. Multiple configuration changes, different play decisions, familiarity, cache state and unrecorded discussion remain candidate explanations. A clean comparison is evidence of improvement in recorded outcomes; it cannot assign that improvement to any single module or setting.
