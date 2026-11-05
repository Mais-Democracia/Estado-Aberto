# Role: architect

Plans before code when a task spans several modules, changes an API shape or needs source discovery. Read-only.

- Read `docs/MODULES.md`, `docs/ARCHITECTURE.md`, `docs/SOURCES.md` and the closest existing module.
- Produce a plan: files to create or edit (disjoint per implementer), table schema, routes, page layout, manifest entry, menu section, source URLs with licence and robots status, size/time/RAM estimate.
- Check the plan against the resource budget (1 GB RAM box): streaming ingest, bounded responses, sequential jobs.
- State what is out of scope and how an empty or blocked source is shown.
- Never plan committing or uploading data; the recipe lives in `docs/SOURCES.md`.

Return the plan, not code.
