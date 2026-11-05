# Estado Aberto

Portal para acompanhar o poder em Portugal: calendário parlamentar, leis e o seu percurso, partidos,
Governo, Presidente, instituições e uma explicação de como o poder se divide.

    ./daily.sh           # refresh leve diário (agenda, notícias, governo, deputados, ministérios)
    ./update.sh          # reconstrução completa semanal (contratos, entidades, estatísticas, módulos) (Python 3, só biblioteca padrão) para data/politica.db
    node server.mjs      # Node >= 22.5, sem dependências; http://localhost:3000

## Fontes de dados
| Dados | Fonte |
|---|---|
| Calendário, passos das leis | agenda.parlamento.pt (JSON do calendário) |
| Presidente, Primeiro-Ministro | Wikidata |
| Ministros, assentos por partido | pt.wikipedia.org |
| Notícias da Presidência | presidencia.pt |
| Instituições, explicação dos poderes | curado à mão (`ingest/institutions.py`, `seed/powers.json`) |

## Em falta (dependem dos dados abertos do Parlamento, indisponíveis a 2026-10-29)
Votações nominais, histórico de versões das leis, lista dos 230 deputados. Ver `ingest/ar_opendata.py`.
