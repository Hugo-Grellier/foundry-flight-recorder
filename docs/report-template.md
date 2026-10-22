# Post-session report template

Write the report in the GM's language. Keep it actionable; cut sections with nothing evidenced.

```markdown
# Session report — <label> (<session id>, <date>, <duration>)

## 1. Executive summary
3-6 bullets: the most important problems and the top recommended changes.

## 2. Telemetry completeness and limitations
Clients recorded / declined / crashed, lost or dropped events, modes, what cannot be concluded.

## 3. Critical technical issues
Errors, freezes, disconnects with module/version attribution.

## 4. Recurring usability friction
Repeated interactions, abandoned dialogs, warnings shown repeatedly, friction markers.

## 5. Pathfinder 2e learning opportunities
Patterns in checks/actions/targeting/conditions/rerolls that suggest a rule or UI flow to explain.

## 6. Combat flow
Turn durations (median, slow outliers), quiet gaps, what happened during slow turns.

## 7. Unexplained anomalies
Things observed that no hypothesis explains yet.

## 8. Recommendations for the GM (table, prep, communication)
## 9. Prioritized technical fixes (modules, settings, scenes, hardware)
## 10. Experiments for next session
## 11. Changes to evaluate next time (what `ffr compare` should show if a fix worked)
```

## Finding format (sections 3-7)

Every finding has all six parts:

| Part | Content |
|---|---|
| **Observed** | What the events show, with evidence ids and `+mm:ss` times. Facts only. |
| **Interpretation** | The most likely explanation, labelled as a hypothesis. |
| **Alternatives** | At least one other explanation consistent with the same evidence. |
| **Confidence** | low / medium / high, and why (coverage, number of occurrences, corroboration). |
| **Impact** | What it cost the session (time, errors seen by players, turns delayed). |
| **Validation** | How to confirm next session (an experiment, a setting change + `ffr compare` metric). |

Example:

> **Targeting a spell attack took 3+ minutes (Ezren, round 1)**
> *Observed:* turn `r1t2` lasted 250 s (5× median) [`c6rh2t761yb.85`→`.113`]. Within it: 3× warning
> "You must target exactly one token." [`cy054khzox6.85,.86,.88`], 6 target toggles on the same token in 12 s
> [`.89`–`.95`], a spell-attack roll with no target [`.97`], a friction marker "rules" [`.102`].
> *Interpretation (hypothesis):* the player did not know how to target for Electric Arc's two-target attack.
> *Alternatives:* table discussion of tactics during the turn; a module conflict on targeting; trackpad misclicks.
> *Confidence:* medium — single occurrence, but four independent signals in one window; no voice data.
> *Impact:* ~3 min of table time; attack resolved without AC comparison once.
> *Validation:* show T-key targeting before next combat; expect no `attack-without-target` and Ezren turns near the PC median in `ffr compare`.
