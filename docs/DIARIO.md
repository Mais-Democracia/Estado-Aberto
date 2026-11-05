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
           UNIQUE(edicao_data, evidence_hash))
```

`artigos_ia` é escrita pelo agente de IA; este job só a cria.

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
