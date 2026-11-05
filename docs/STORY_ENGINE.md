# Story engine

Scroll-driven stories for the Estado Aberto sections. One sticky particle canvas morphs between shapes while the text scrolls past. Files:

| File | Role |
|---|---|
| `public/story-morphs.js` | Morph library (`Story.morphs`), geometry, number and date formatters (`Story.fmt`) |
| `public/story-engine.js` | `Story.register`, routing, particle view, mini-nav, rail, keys, directory overlay, static mode |
| `public/story.css` | Styles, theme-aware (follows `data-theme` set by `edicao.js`) |
| `public/historias/<slug>.js` | One file per story, calls `Story.register` |
| `public/historias/_demo.js` | Demo story `demo` with fake data for every morph type |

Demo: `#/historia/demo`, `#/historia/demo/rede`, `#/historia/demo?fail=1` (failure panel), `?static=1` (static mode).

## Registering a story

```js
Story.register("parlamento", {
  title: "Quem manda no *Parlamento*",
  question: "Como se divide o poder em São Bento?",
  load: () => fetch("/api/historias/parlamento").then((r) => r.json()),
  scenes: [ /* see below */ ],
  directory: [{ label: "Deputados", href: "#/deputados", desc: "Lista completa." }],
  fallback: [{ label: "Parlamento", href: "#/parlamento" }],
});
```

`load()` returns a Promise of the data object `d`. Rejection, a non-object, or a 20 s timeout shows the "Dados indisponíveis" panel with links (`fallback`, default: the six section pages) and a retry button. Nothing is invented. `*word*` in `title` and in headlines renders as emphasis.

The router loads `/historias/<slug>.js` on demand (also tries `/historias/_<slug>.js`), so a story needs no `<script>` tag.

## Scene

```js
{
  id: "hemiciclo", label: "Hemiciclo", kicker: "Parlamento",
  morph: { type: "hemicycle", items: (d) => ({ title: "XVII Legislatura", seats: d.seats }) },
  headline: (d) => `${d.total} deputados, *${d.parties} partidos*`,
  copy: "O {{leader.party|str}} tem {{leader.seats|int}} lugares. Última votação em {{asof|date}}.",
  source: { label: "Assembleia da República", href: "#/partidos", asof: (d) => d.asof },
  when: (d) => d.seats && d.seats.length > 0,
}
```

- `when(d)` false (or throwing) skips the scene. A scene without `morph` is skipped.
- `morph.items(d)` throwing or returning an invalid spec shows an honest "Sem dados para esta cena." state, never a broken chart.
- `headline` returning null, empty, or text containing `undefined`/`NaN` falls back to `label`.
- `source.asof(d)` returning falsy omits the "dados de ..." part.

### Copy slots

`{{field.path|fmt}}` is read from `d`. Formats: `int` (1 234), `dec1` (12,3), `pct` (12,3%), `eur` (1,2 mM€ / 3 M€ / 4 mil €), `date` (2 de novembro de 2026), `str`. A slot whose value is null, undefined, NaN or empty drops its whole sentence; paragraphs are separated by a blank line and empty paragraphs vanish. Output containing `undefined` or `NaN` is dropped too.

## Morph specs

All values are numbers (numeric strings are accepted). Colour names: `ink mute paper line red green gold blue na`, or any hex. Every region supports hover tooltips; `href` makes it clickable (`#/...` hash links or full URLs).

**counter**
```js
{ type: "counter", items: (d) => ({ value: 98.6, label: "Despesa pública", unit: "mil milhões €", delta: 3.4 }) }
```

**bars** (up to 14 rows, 10 on mobile; arg highlights a row by label)
```js
{ type: "bars", items: (d) => ({ rows: [{ label: "Saúde", value: 12.8e9, color: "red", href: "#/orcamento" }], max: 15e9, unit: "€" }) }
```

**hemicycle** (`vote` colours seats green/red/gold, otherwise `color` or the palette; any non-null `vote` switches to vote mode)
```js
{ type: "hemicycle", items: (d) => ({ title: "Lei X", seats: [{ party: "PS", n: 78, color: "#e0457b", vote: "favor" }, { party: "CH", n: 40, vote: "contra" }, { party: "IL", n: 9, vote: "abstencao" }, { party: "PAN", n: 1, vote: null }] }) }
```

**sankey** (columns derived from link direction)
```js
{ type: "sankey", items: (d) => ({ nodes: [{ id: "imp", label: "Impostos", color: "green" }, { id: "est", label: "Estado" }, { id: "sau", label: "Saúde", href: "#/saude" }], links: [{ s: "imp", t: "est", v: 52 }, { s: "est", t: "sau", v: 15 }] }) }
```

**scatter** (max `N/3` points, evenly subsampled; extremes are labelled)
```js
{ type: "scatter", items: (d) => ({ points: [{ x: 5000, y: 1800, label: "Alvito", color: "blue", href: "#/autarquias" }], xLabel: "População", yLabel: "Despesa por habitante (€)", median: { x: 20000, y: 1500 } }) }
```

**timeline** (`t` is an ISO date or a number such as a year)
```js
{ type: "timeline", items: (d) => ({ points: [{ t: "2019-01-01", v: 100 }, { t: "2019-02-01", v: 104 }], events: [{ t: "2020-03-18", label: "Estado de emergência", href: "#/dre" }] }) }
```

**network** (force layout computed once, capped at 400 nodes by `size`; labels on the largest)
```js
{ type: "network", items: (d) => ({ nodes: [{ id: "a", label: "Ministério", size: 130, group: "Norte", href: "#/entidades" }, { id: "b", label: "Instituto", size: 12, group: "Sul" }], links: [{ s: "a", t: "b", v: 3 }] }) }
```

**tiles** (colour by `value` on a light-to-dark ramp, grey when null; grouped when `group` is present)
```js
{ type: "tiles", items: (d) => ({ tiles: [{ label: "Mértola", value: 42.5, group: "Sul", href: "#/autarquias/Mértola" }] }) }
```

**list** (up to 8 rows, 6 on mobile)
```js
{ type: "list", items: (d) => ({ rows: [{ title: "Lei da habitação", sub: "Aprovada em votação final global", tag: "Lei", href: "#/leis" }] }) }
```

## Routing

`#/historia/<slug>[/<sceneId>[/<arg>]]?t=<0..1>`

- Scene ids: `inicio` (cover), each scene `id`, `directorio` (last). A deep link scrolls to the scene; `t` is the progress inside that scene, or overall progress when no scene is given.
- `arg` is passed to the morphs and highlights the item whose `label`/`title`/`id` matches (bars, sankey, scatter, network, tiles, list), e.g. `#/historia/demo/barras/Defesa`.
- The hash is kept in sync while scrolling (`history.replaceState`).
- Hooks in `portal.js`: `Portal.storyHandle` (same slug: just scrolls) and `Portal.storyUnmount` (any other route cleans up).

## Interaction

Keys: `←`/`→` scene, `1`-`9` jump, `M` directory overlay, `/` overlay with filter focused, `Esc` close. Mini-nav, progress bar and rail (desktop), `Directório` overlay, last scene lists `directory` and the sources of every scene. The theme button toggles the same `ed-tema` setting as the edition page; the canvas recolours live.

The story scrolls inside its own container (`.st-scroll`) with soft snapping, not the document.

## Modes

- Desktop: full-viewport sticky canvas (2 400 particles), text card on the left.
- Below 720 px: canvas becomes a sticky strip of 45 vh with 900 particles, text card below.
- `prefers-reduced-motion` or `?static=1`: no animation; every scene is drawn once at its end state in its own canvas next to its text.
- Particle motion is time based, so low frame rates or paused clocks still converge.

## Adding a morph

Add `Story.morphs.<name> = (spec, box, ctx) => ({ regions, labels, lines, maxPer? })` in `story-morphs.js`. `box` is `{x,y,w,h}`; `ctx` has `pal`, `col(name)`, `mobile`, `N`, `arg`, `measure(text,size,weight,family)`. Regions: `rect`, `disc`, `ring`, `ribbon`, `path` with optional `c`, `a`, `fill` (soft backing shape), `mw` (particle weight), `rr` (particle radius), `tip` (HTML or function), `href`.
