---
name: propose-roadmap-item
description: Turn an idea or a new source into a verified backlog line or issue.
---

# propose-roadmap-item

## When to use
You found a gap, a source or a feature worth tracking but are not building it now.

## Steps
1. Check `docs/BACKLOG.md` and `docs/ROADMAP.md` for duplicates.
2. State the public question it answers and the section it belongs to.
3. For a source: verify the URL with `curl`, check `robots.txt` and terms, note licence, format, update frequency, size estimate.
4. Open an issue from the matching template, or add one backlog line: `- [ ] <title>: <question>; source <URL> (licence, robots checked <date>); est. size/time/RAM`.
5. Never attach data.

## Checks
The URL answers, the licence and robots status are written down, no duplicate exists.
