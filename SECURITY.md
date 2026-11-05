# Security policy

## Reporting a vulnerability

Report privately through GitHub: the Security tab of https://github.com/Mais-Democracia/Estado-Aberto, "Report a vulnerability". Do not open a public issue. Include the affected route or file, steps to reproduce and the impact. We aim to acknowledge within a few days.

## Scope

The Node server (`server.mjs`, `server/modules/`), the client (`public/`) and the ingest tools. Typical concerns: injection in module queries, unescaped dynamic text in the client, unbounded responses, path traversal in static serving, ingest code following unsafe redirects.

## Secrets

No secret belongs in this repository: no tokens, passwords, keys, server addresses or personal data, in code, docs, fixtures or history. If you find one, report it privately as above. Per-deployment configuration is read from environment variables and never committed.

## Data

No real data is committed or uploaded, which also keeps personal data out of the repository. See `docs/DATA_POLICY.md`.
