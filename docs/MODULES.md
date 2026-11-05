# Plug-in modules (how to add a data domain without touching shared files)

Each data domain (e.g. `dre`, `autarquias_financas`, `educacao`, `parlamento_ar`, `ministerios`) is made of up to 3 files.
**Never edit `server.mjs`, `public/portal.js`, `public/app.js`, `ingest/common.py` or `data/politica.db`** from a module — use the hooks below.

## 0. Scaffold and menu

Create the three files, the manifest entry and the menu entry in one step:

```sh
python3 tools/new_module.py <name> --section <parlamento|governo|dinheiro|poder-local|instituicoes|leis-justica|indicadores>
```

The portal menu has seven sections plus Roadmap, defined in `Portal.NAV_GROUPS` (`public/portal.js`):

| Section | `--section` | Typical content |
|---|---|---|
| Parlamento | `parlamento` | calendário, leis, votações, posições, deputados, intervenções |
| Governo | `governo` | Governo, ministérios, quem decide, Presidência, Estado e empresas |
| Dinheiro público | `dinheiro` | contratos, orçamento, apoios, anúncios, fundos, dívida |
| Poder local | `poder-local` | municípios, freguesias, regiões, empresas locais, eleições |
| Instituições | `instituicoes` | diretório, reguladores, educação, saúde, segurança |
| Leis e justiça | `leis-justica` | Diário da República, justiça, Provedor, atos do Presidente |
| Indicadores | `indicadores` | séries do INE, habitação, imigração, educação |

The scaffold writes working stubs without comments, adds the job to `ingest/jobs.json` (or prints the snippet if the manifest is absent) and appends the page to the chosen menu group, then prints a TODO checklist. Replace the placeholder source URL and schema before running. Resource budget: the production box has 1 GB RAM, so stream downloads, run sequentially and bound every response.

## 1. Ingest job — `ingest/jobs/<name>.py`
* Must define `main()`; run with `python3 ingest/run_all.py <name>` (or no arg = all jobs).
* **Open your database with `PRAGMA journal_mode=WAL` (and `timeout>=60`) and commit in small batches**, so the live site (read-only connections) is never blocked while your ingest runs. A long write transaction in the default mode makes your API return "Dados em atualização".
* Writes ONLY to its own SQLite file `data/<name>.db` (create tables yourself; `from common import ROOT`; `DB = ROOT/"data"/f"{name}.db"`).
* Raw downloads go to `data/raw/<name>/` (gitignored). Stream big files; never load multi-GB JSON in memory.
* Link to the entity registry through the **NIF** (9-digit tax number): `entities.nif` in `data/politica.db` (read-only for you), or by name when no NIF exists.
* Be polite: send `common.UA`, cache downloads, sleep between requests to the same host, respect robots.txt.
* Every row you store should carry `source_url` so the UI can cite it.

## 2. Server module — `server/modules/<name>.mjs`
```js
export default function register({ db, userDb, all, one, has, num, like, fts, routes, openData }) {
  const mine = openData("<name>");               // read-only DatabaseSync for data/<name>.db (or null)
  routes["/api/<name>/something"] = (q, req, body) => ({ ... });   // q = URLSearchParams
}
```
Prefix every route with `/api/<name>/`. Return plain JSON. Keep queries indexed and `LIMIT`ed.

## 3. Client module — `public/modules/<name>.js`
```js
Portal.page("<name>", async (arg, params) => { $app.innerHTML = `...`; });   // route #/<name>/<arg>?<params>
Portal.nav("Label", "#/<name>");                                             // adds an item to the main nav (optional)
Portal.entityHooks.push(async (data, el) => { el.insertAdjacentHTML("beforeend", "<section class='panel'>…</section>"); }); // add a section to every entity profile (data.entity.nif / .id / .kind)
```
Helpers on `Portal`: `esc, api, eur, eurFull, int, pct, fmtDate, table, pager, bars, followButton, qs, go, kindLabel`.
Always escape dynamic text with `Portal.esc`. Style with existing CSS classes (`panel`, `kpis`, `tbl`, `tag`, `note`, `cols`, `flag`…). If you need new CSS, put it in a `<style>` inside your page or in `public/modules/<name>.css` loaded by your module.

## Quality bar
* Real data only — if a source is unreachable, say so on the page (`<p class="note warn">`) instead of inventing anything.
* Add a short entry to `docs/SOURCES.md`: source, URL, licence, update frequency, coverage, known gaps.
* Commit only your own files, as `Location: Description.`. No real data is ever committed (`docs/DATA_POLICY.md`).
