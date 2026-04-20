---
name: rewrite
description: Rewrite a file following readability rules.
user-invocable: true
disable-model-invocation: true
argument-hint: "<file path>"
---

# Readability rewrite

Rewrite the specified file (or the most recently discussed file) following these rules.

## Respect the reader

Every sentence should earn its place. Every section should help the reader understand or decide. The reader's time is valuable.

Core qualities:

- **Clear** — reader understands on first read
- **Efficient** — no filler, no padding
- **Honest** — unknowns are marked, not hidden
- **Traceable** — claims have sources

## Structure for comprehension

1. **Inverted pyramid** — key concepts first, details below. Reader should grasp the essence by scanning headings and first lines. Lead with what matters most.
2. **Equip, don't guess** — include enough detail so the reader can make informed decisions. If they need information to decide, include it. If a choice is theirs, say so explicitly. Provide context, not just conclusions.
3. **Concise != truncated** — "concise" means no filler words, not cutting substantive content. Details that help the reader are not filler. Don't sacrifice clarity for brevity.
4. **Code-first** — prefer code/pseudocode with comments to text descriptions. Descriptions follow code blocks, never precede them.

## Content rules

1. **Never fabricate** — no invented names, numbers, dates, or unverified details.
2. **Source everything** — mark origin of information: (from user), (via source X), (from file:line).
3. **Mark unknowns** — use explicit placeholders like `[TODO: X]` or `[TBD]`. Never hide unknowns behind vague language.
4. **No filler** — remove "I'd be happy to", "It's worth noting", "At the end of the day", empty affirmations. Avoid hedging that obscures meaning ("might", "could potentially", "generally").
5. **Concrete > Vague** — if you can't be specific, mark as unknown. Not "several" but "3" or `[count unknown]`. Not "significant improvement" but "2x faster" or `[improvement TBD]`.

## What to include vs. omit

- **Include:** Key definitions, processing steps with logic hints, formulas and thresholds, defaults and edge cases, decision-relevant context
- **Omit:** Internal implementation details the reader won't act on, line-by-line minutiae, information that doesn't help the reader understand or decide

## Target audience

Developers familiar with the codebase. There should be only after, no before.

## Process

1. Read the file
2. Rewrite applying all rules above
3. Run `npx -y markdownlint-cli2 --config SKILL_DIR/.markdownlint-cli2.jsonc --fix <file>` where SKILL_DIR is this skill's base directory
4. Fix all reported violations, re-run until clean
5. Show the user what changed (brief summary, not a diff)
