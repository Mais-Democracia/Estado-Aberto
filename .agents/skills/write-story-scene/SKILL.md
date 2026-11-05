---
name: write-story-scene
description: Add or edit a scene in a scrollytelling story under public/historias.
---

# write-story-scene

## When to use
A finding from the data deserves a scene in a story or the Edição Diária.

## Steps
1. Read `docs/STORY_ENGINE.md` and `docs/HISTORIAS.md`; open the nearest existing story in `public/historias/`.
2. Every figure in the scene comes from an API route or a fixture, never typed in by hand; show the source link.
3. Write in Portuguese, plain and neutral; no verdicts the data does not support.
4. Test with synthetic fixtures only; do not copy real records into the repo.
5. Handle the empty case: the scene says what is missing instead of rendering zeros.

## Checks
`node --check` on the story files, `npm run check`, screenshot at desktop and mobile widths, scroll through every step.
