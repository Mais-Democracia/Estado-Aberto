# Diário: livro-razão diário (diario.db)

Contrato congelado. Outros componentes (pipeline de IA, servidor, front end) programam contra este esquema.

## Contrato de dados

Ficheiro `diario.db` na pasta de dados (`ESTADO_ABERTO_DATA`), modo WAL.

```
eventos(
  id INTEGER PRIMARY KEY,
  hash TEXT UNIQUE NOT NULL,
  data_evento TEXT NOT NULL,        -- data ISO do evento segundo a fonte
  ingerido_em TEXT NOT NULL,        -- datetime ISO UTC da primeira observação; nunca muda
  edicao_data TEXT NOT NULL,        -- data ISO da edição; fixada na primeira inserção; nunca muda
  secao TEXT NOT NULL,              -- parlamento|governo|fiscalizacao|nomeacoes|poder-local|dinheiro|indicadores
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  resumo_curto TEXT,
  fonte_modulo TEXT NOT NULL,
  fonte_ref TEXT,
  rota TEXT,                        -- rota hash existente do site, p. ex. '#/votacoes/...', '#/igf'
  source_url TEXT,
  entidades TEXT,                   -- JSON: array de {nome,tipo,id?}
  score REAL NOT NULL,
  revisao INTEGER NOT NULL DEFAULT 1,
  atrasado INTEGER NOT NULL DEFAULT 0,   -- 1 se registado depois de data_evento+1
  ia_artigo_id INTEGER NULL
)
edicoes(numero INTEGER PRIMARY KEY, data TEXT UNIQUE NOT NULL,
        estado TEXT NOT NULL,       -- 'preliminar'|'fechada'
        fechada_em TEXT)
cursores(fonte TEXT PRIMARY KEY, max_rowid INTEGER, max_data TEXT, atualizado_em TEXT)
artigos_ia(id INTEGER PRIMARY KEY, edicao_data TEXT NOT NULL, evidence_hash TEXT NOT NULL,
           evento_ids TEXT NOT NULL,  -- JSON
           titulo TEXT, lead TEXT, corpo TEXT,
           pontos_chave TEXT,        -- JSON
           fontes TEXT,              -- JSON [{label,href}]
           numeros_citados TEXT,     -- JSON
           entidades TEXT,           -- JSON
           confianca REAL, modelo TEXT, revisor TEXT,
           verificacao TEXT,         -- JSON
           estado TEXT NOT NULL,     -- 'publicado'|'rejeitado'
           criado_em TEXT, revisao INTEGER DEFAULT 1,
           blocos TEXT,              -- JSON, ver API da edição
           explicacao TEXT,          -- JSON, ver API da edição
           UNIQUE(edicao_data, evidence_hash))
```

`artigos_ia` é escrita pelo agente de IA; este job só a cria.

## API da edição (contrato do cliente)

- `/api/edicao/dia` devolve `ia` (cartões) e `secoes` ou `tudo`. `frescura` continua na resposta apenas para monitorização; a interface nunca a mostra e `avisos` já não existe. Secções vazias da lista completa trazem sempre `motivo: "Sem registos para este dia"`.
- Cada item traz `rota`, resolvida no servidor por `rotaObjeto(evento)`: se `rota` já é uma rota de objeto fica como está; se é uma rota genérica de lista, deriva-se de `fonte_modulo` + `tipo` + `fonte_ref` (e de `entidades` para votações: iniciativa -> `#/votacoes/<bid>`; DRE -> `#/dre/<id>`; contrato -> `#/artigo/contrato/<id>`; relatório do TC -> `#/artigo/relatorio/<id>`; nomeação -> `#/artigo/nomeacao/<id>`; ato do Presidente -> `#/atos-presidente/<id>`). Sem rota de objeto, `rota` vem vazia e a interface mostra o título sem ligação mais uma ligação «Fonte» (`source_url`, novo separador).
- `artigos_ia.blocos` (JSON, nulo): `{lei:{titulo,tipo,numero,legislatura,autor,rota,texto_url}|null, votacao:{data,resultado,por_partido:[{partido,voto:favor|contra|abstencao|ausente,lugares}],totais:{favor,contra,abstencao}}|null, intervencoes:[{id,deputado,partido,data,excerto<=280,rota}]<=6}`. Construído deterministicamente pelo pipeline, não pelo modelo.
- `artigos_ia.explicacao` (JSON, nulo): `{do_que_trata:str, o_que_muda:[str]}`, escrita pela IA e verificada.
- `/api/edicao/artigo?id=` devolve `blocos` e `explicacao` já validados (rotas só `#/...`, votos fora do conjunto descartados, excertos cortados a 280) ou `null`. Os cartões de `ia` em `/api/edicao/dia` trazem `blocos:{lei,votacao}|null` e `tem_explicacao`. Colunas ausentes em bases antigas equivalem a `null`.

## Regras

- A edição de data D é publicada em D e reporta o que aconteceu em D-1. A edição n.º 1 é 2026-11-06; `numero` = dias entre 2026-11-06 e D, mais 1. Datas anteriores não têm edição.
- `edicao_data = max(data_evento + 1 dia, data local (Europe/Lisbon) de ingerido_em)`, nunca anterior a 2026-11-06. Eventos anteriores ao limiar só são inseridos se forem vistos pela primeira vez a partir do limiar; vão então para a edição da data de ingestão com `atrasado = 1` e o resumo indica `ocorreu a <data>`.
- Uma edição fecha (`estado = 'fechada'`, `fechada_em` preenchido) às 06:00 de Europe/Lisbon de D+1. Depois disso nenhum evento lhe é acrescentado nem alterado; linhas tardias vão para a edição aberta seguinte.
- `hash = sha1(fonte_modulo|fonte_ref|tipo|data_evento)`. Duas execuções seguidas não alteram nada. `revisao` só sobe quando `titulo`, `resumo_curto` ou `score` mudam e a edição ainda está aberta. `ingerido_em`, `edicao_data` e `atrasado` nunca mudam depois da inserção.
- Incremental: um cursor por fonte (`max_rowid`) mais uma janela de reanálise de 14 dias. Na primeira execução de uma fonte só entra a janela de 14 dias.
- Sem rede. Fontes em modo só de leitura (`ATTACH ... mode=ro`); fonte, tabela ou coluna em falta é ignorada sem erro.

## Execução

```
python3 ingest/jobs/diario.py [--date D] [--rebuild-edition D] [--shortlist D]
```

- `--date D`: relógio lógico em D às 12:00 de Lisboa (para reconstruções e testes); por omissão, agora.
- `--rebuild-edition D`: reavalia a edição D a partir das fontes; recusada se estiver fechada.
- `--shortlist D`: imprime em JSON os ids dos eventos a entregar ao estágio de IA (`n=25`, `per_section=6`).

Variáveis: `ESTADO_ABERTO_DATA` (onde vive `diario.db`), `ESTADO_ABERTO_SOURCE_DATA` (onde estão as bases de origem; por omissão igual a `ESTADO_ABERTO_DATA`).

## Fontes e eventos

Cada fonte é anexada em modo só de leitura (`ATTACH ... mode=ro`) e desanexada no fim; base, tabela ou coluna em falta é ignorada sem erro (`fontes_ignoradas` no resultado).

| Secção | Fonte | Evento (`tipo`) | Data do evento |
|---|---|---|---|
| parlamento | `votacoes.votos` (Plenário, fase `Votação%`) + `iniciativas` | `votacao_final` (votação final global de lei), `votacao` | `votos.data` |
| parlamento | `votacoes.iniciativas` | `iniciativa_entrada` | `data_entrada` |
| parlamento | `intervencoes` + `iv_ini` | `debate` (um por dia e iniciativa, 2 ou mais intervenções) | `intervencoes.data` |
| parlamento | `posicoes.decl` | `declaracao_voto` | `data_voto` |
| parlamento | `dre.acts` | `lei_publicada`, `resolucao_ar` | `date` |
| governo | `presidencia.vetos`, `atos`, `comunicados` | `veto`, `promulgacao`, `ato_presidente`, `comunicado` | `data` |
| governo | `dre.acts` | `decreto_lei`, `resolucao_cm`, `decreto_regulamentar` | `date` |
| fiscalizacao | `justica.tcontas_docs` | `auditoria_tc`, `acordao_tc`, `relatorio_tc` | `publicado` |
| fiscalizacao | `igf.reports` | `relatorio_igf` | sem data na fonte: dia da primeira observação |
| fiscalizacao | `provedor.reports` | `relatorio_provedor` | `published` |
| fiscalizacao | `reguladores.decisions` | `sancao_regulador`, `decisao_regulador` | `date` |
| nomeacoes | `responsaveis.nomeacoes`, `appointments` | `nomeacao_conselho`, `nomeacao`, `exoneracao`, `nomeacao_gabinete` | `date`, `start` |
| dinheiro | `politica.contracts` | `contrato_grande`, `contrato_ajuste_direto`, `contratos_resumo` | `published` |
| dinheiro | `politica.contract_mods` | `alteracao_contrato`, `alteracoes_resumo` | `published` |
| dinheiro | `anuncios.announcements` | `anuncio_grande` (preço base >= 1 000 000 euros), `anuncios_resumo` | `published` |
| dinheiro | `apoios.apoios` | `apoio` (>= 50 000 euros), `apoios_resumo` | `data_decisao`, só quando é uma data ISO |
| dinheiro | `divida.series` | `divida_serie` | sem data de evento: dia da primeira observação |
| poder-local | `igf.reports` com `kind = 'municipio'` | `relatorio_igf_municipal` | dia da primeira observação |
| indicadores | `ine_series.indicador`, `imigracao.datasets`, `ama_pedidos` | `indicador_ine`, `indicador_imigracao`, `indicador_ama` | `updated`, `published` |

Notas:

- Contratos e alterações: uma linha por contrato com valor >= 50 000 euros ou ajuste direto >= 20 000 euros; o resto vira uma linha de resumo por dia.
- `igf.reports` e `divida.series` não têm data de evento. Só entram linhas novas (rowid acima do cursor) e a data do evento é o dia da primeira observação; uma referência já registada nunca é reinserida. Na primeira execução não entra nada.
- `apoios.data_decisao` é texto livre na maioria das linhas; só datas ISO contam.
- `autarquias` não tem tabela de eventos datados e não é lida; os relatórios municipais da IGF alimentam `poder-local`.
- `atos` de nomeação e exoneração do Presidente não são lidos (as mesmas decisões vêm de `responsaveis.nomeacoes`); condecorações e homologações ficam de fora.
- Linhas novas na fonte (rowid acima do cursor) com data até 90 dias atrás entram como atrasadas; mais antigas são ignoradas.
- Na primeira execução de uma fonte entra só a janela de 14 dias. Eventos com `data_evento + 1` anterior ao limiar só entram se forem linhas novas desde um cursor já existente.
- Rotas (`rota`) usam rotas hash do site (`#/votacoes`, `#/contrato/<id>`, `#/igf`, `#/dre`, `#/poderes/presidente`, ...).
- Os textos usam só campos reais das fontes; o formato de valores e datas segue `server/modules/edicao.mjs`.

## Pontuação

Em `ingest/diario_score.py` (funções puras, testadas). Base por tipo: veto 90; votação final global de lei 80 (+15 se a diferença de lugares entre favor e contra for de 10 ou menos, +10 se rejeitada); promulgação 60; auditoria do Tribunal de Contas 55; sanção de regulador 50 + log10(valor em euros); nomeação para conselho de regulador ou empresa do Estado 40; contrato grande 20 + log10(preço); debate agregado 25; restantes 10.

Bónus: entidade com sinal de risco em `risco.entity_risk` (score >= 6) +10; primeiro do seu género nos últimos 30 dias (veto, sanção, auditoria, relatórios IGF e Provedor, promulgação) +10. Penalização: 5 pontos por dia de atraso para além de 2, em que o atraso é `edicao_data - (data_evento + 1)`. O resultado nunca é negativo.

`shortlist(edicao_data, n=25, per_section=6)` devolve os ids por score decrescente (desempate por id), no máximo `per_section` por secção e `n` no total. `--shortlist DATE` imprime-os em JSON.

## Operação

- Manifesto: passo `diario` em `ingest/jobs.json`, `schedule` `6h`, sem rede, produz `diario.db`.
- `ESTADO_ABERTO_DIARIO_FLOOR` altera a data da edição n.º 1 (só para ensaios sobre dados antigos).
- Testes: `python3 -m unittest discover ingest/tests`.
- `python3 tools/make_sample.py` acrescenta eventos recentes às bases de exemplo e constrói um `diario.db` sintético.
