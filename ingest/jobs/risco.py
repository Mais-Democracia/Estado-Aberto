"""Sinais de risco na contratação pública: indicadores explicáveis e reprodutíveis (por contrato, par comprador-fornecedor
e entidade), cada um com explicação em português e as linhas de evidência.

Escreve só em data/risco.db (+ data/exports/risco_contracts.csv.gz).  Lê (só leitura) data/politica.db:
contracts, contract_parties, contract_mods, entities.

Princípios
  * Um indicador é um SINAL ESTATÍSTICO, não uma acusação.  Cada linha guarda a evidência (ids de contratos, valores,
    limiares, linha de base nacional) para que uma pessoa ou um modelo de IA possa verificar.
  * Os limites legais do ajuste direto / consulta prévia NÃO são assumidos: cada regra (fundamento legal -> teto) é
    validada no arranque com o histograma de preços (pico logo abaixo do teto) e o resultado fica em meta('thresholds').
  * Pontuação = soma simples dos pesos das bandeiras (tabela flag_defs).  Nunca é mostrada sem as bandeiras.
"""
import csv
import gzip
import json
import math
import os
import re
import sqlite3
import time
import unicodedata
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime

from common import DATA_DIR, ROOT

NAME = "risco"
DB = DATA_DIR / f"{NAME}.db"
POLITICA = DATA_DIR / "politica.db"
EXPORT = DATA_DIR / "exports" / "risco_contracts.csv.gz"
ANUNCIOS = DATA_DIR / "anuncios.db"
AUTARQUIAS = DATA_DIR / "autarquias.db"
RAW_CONTRACTS = DATA_DIR / "raw" / "contracts"
PROCMAP_CACHE = DATA_DIR / "raw" / NAME / "procmap.tsv.gz"
VERSION = 3

AD = "Ajuste Direto Regime Geral"
CP = "Consulta Prévia"
COMPETITIVE = {"Concurso público", "Concurso limitado por prévia qualificação", "Consulta Prévia",
               "Concurso público simplificado", "Consulta Prévia Simplificada",
               "Concurso limitado por prévia qualificação simplificado"}
OPEN_COMPETITION = {"Concurso público", "Concurso limitado por prévia qualificação", "Concurso público simplificado",
                    "Concurso limitado por prévia qualificação simplificado"}

# Regras "critério do valor": (código, procedimento, regex do fundamento legal, teto €, regime pós-2018?, descrição).
# Tetos confirmados empiricamente (ver validate_thresholds): pico de contratos na faixa [95%, 100%) do teto 5-15x acima
# das faixas vizinhas.  Madeira (DLR 34/2008/M, "artigo 4.º") excluída: o pico não é nítido (19,5 e 28,5 mil €).
RULES = [
    ("AD_BS_20K", AD, r"^Artigo 20\.º, n\.º 1, alínea d\) do Código dos Contratos Públicos$", 20000, True,
     "Ajuste direto pelo valor, bens/serviços (art.º 20.º, n.º 1, al. d) CCP, regime desde 2018)"),
    ("AD_OB_30K", AD, r"^Artigo 19\.º, alínea d\) do Código dos Contratos Públicos$", 30000, True,
     "Ajuste direto pelo valor, empreitadas (art.º 19.º, al. d) CCP, regime desde 2018)"),
    ("AD_OUT_20K", AD, r"^Artigo 21\.º, n\.º 1, alínea c\) do Código dos Contratos Públicos$", 20000, True,
     "Ajuste direto pelo valor, outros contratos (art.º 21.º, n.º 1, al. c) CCP)"),
    ("CP_BS_75K", CP, r"^Artigo 20\.º, n\.º 1, alínea c\) do Código dos Contratos Públicos$", 75000, True,
     "Consulta prévia pelo valor, bens/serviços (art.º 20.º, n.º 1, al. c) CCP)"),
    ("CP_OB_150K", CP, r"^Artigo 19\.º, alínea c\) do Código dos Contratos Públicos$", 150000, True,
     "Consulta prévia pelo valor, empreitadas (art.º 19.º, al. c) CCP)"),
    ("AD_BS_75K_PRE18", AD, r"^Artigo 20\.º, n\.º 1, alínea a\) do Código dos Contratos Públicos$", 75000, False,
     "Ajuste direto pelo valor, bens/serviços (art.º 20.º, n.º 1, al. a) CCP, regime até 2017)"),
    ("AD_OB_150K_PRE18", AD, r"^Artigo 19\.º, alínea a\) do Código dos Contratos Públicos$", 150000, False,
     "Ajuste direto pelo valor, empreitadas (art.º 19.º, al. a) CCP, regime até 2017)"),
    ("AZ_AD_75K", AD, r"^Artigo 2[01]\.º, alínea a\) do Decreto Legislativo Regional n\.º 27/2015/A", 75000, False,
     "Ajuste direto pelo valor, Região Autónoma dos Açores (DLR 27/2015/A, art.º 20.º/21.º al. a))"),
]
RULE_RX = [(r[0], r[1], re.compile(r[2]), r[3], r[4], r[5]) for r in RULES]
RULE_T = {r[0]: r[3] for r in RULES}
# art.º 113.º, n.º 2 CCP (regime 2018): famílias que se somam para o limite dos 3 anos económicos
ART113_FAMILY = {"AD_BS_20K": "BS", "CP_BS_75K": "BS", "AD_OB_30K": "OB", "CP_OB_150K": "OB", "AD_OUT_20K": "OUT"}

BUNCH_LO = 0.95          # faixa "colado ao teto": [95%, 100%) do teto
SPLIT_WINDOW = 30        # dias: janela deslizante do fracionamento
SPLIT_SENSITIVITY = (14, 30, 60)
NEW_SUPPLIER_DAYS = 365
NEW_SUPPLIER_MIN = {"direct": 100000, "any": 500000}   # € (AD/CP vs qualquer procedimento)
CREEP = 0.25             # +25% via modificações
LOCAL_ELECTIONS = {2013: "2013-09-29", 2017: "2017-10-01", 2021: "2021-09-26", 2025: "2025-10-12"}
PRE_ELECTION_DAYS = 90
LOCAL_KINDS = {"municipio", "freguesia", "empresa_municipal", "cim_am"}

# flag -> (nível, peso, rótulo, explicação, limitação)
FLAGS = {
    # ---------------- contrato
    "FRACIONAMENTO": ("contrato", 3.0, "Possível fracionamento",
        "Vários procedimentos distintos (os lotes de um mesmo procedimento contam como um só) de ajuste direto/consulta prévia pelo valor, do mesmo comprador ao mesmo fornecedor, com o mesmo objeto (mesma classe CPV de 4 dígitos e descrição semelhante ou código CPV específico igual), celebrados em {w} dias, cada um abaixo do teto legal mas que somados o ultrapassam. Todos os contratos (lotes) desses procedimentos ficam assinalados.".format(w=SPLIT_WINDOW),
        "Podem ser necessidades distintas e legítimas (ex.: fornecimentos urgentes diferentes). A semelhança do objeto é aproximada (palavras da descrição, Jaccard ≥ 0,5)."),
    "ART113": ("contrato", 2.0, "Acima do limite acumulado de 3 anos (art.º 113.º, n.º 2 CCP)",
        "Antes deste contrato, o mesmo fornecedor já tinha recebido do mesmo comprador, no ano e nos dois anos económicos anteriores, procedimentos de ajuste direto/consulta prévia pelo valor na mesma classe CPV (4 dígitos) cujo total já igualava ou superava o teto legal. O art.º 113.º, n.º 2 do CCP impede, em regra, convidar esse fornecedor.",
        "'Prestações do mesmo tipo' aproximado pela classe CPV; a lei admite exceções fundamentadas; só contratos do regime de 2018."),
    "JUNTO_AO_TETO": ("contrato", 0.5, "Valor colado ao teto legal",
        "Valor do procedimento (soma dos lotes) entre 95% e 100% do teto do procedimento escolhido (ex.: 19 000–19 999 € num ajuste direto com teto de 20 000 €).",
        "Isolado é um sinal fraco: muitos orçamentos legítimos ficam junto ao teto. Ganha significado quando a entidade o faz muito mais do que a média nacional."),
    "ACIMA_DO_TETO": ("contrato", 1.0, "Valor acima do teto do procedimento",
        "Contrato celebrado ao abrigo do critério do valor com preço igual ou superior ao teto legal desse procedimento.",
        "Pode ser erro de registo (ex.: IVA incluído) no Portal BASE."),
    "CONCORRENTE_UNICO": ("contrato", 1.0, "Concorrente único",
        "Procedimento concorrencial (concurso ou consulta prévia) em que só uma proposta foi apresentada em todos os lotes.",
        "Mercados pequenos ou muito técnicos têm legitimamente poucos concorrentes. Peso 0,5 em consultas prévias."),
    "FORNECEDOR_NOVO": ("contrato", 1.5, "Fornecedor recém-surgido com contrato grande",
        "O fornecedor aparece pela primeira vez na contratação pública (como adjudicatário ou concorrente) menos de {d} dias antes deste contrato, que vale ≥ {a:,} € por ajuste direto/consulta prévia ou ≥ {b:,} € noutro procedimento.".format(d=NEW_SUPPLIER_DAYS, a=NEW_SUPPLIER_MIN['direct'], b=NEW_SUPPLIER_MIN['any']).replace(",", " "),
        "A primeira aparição no Portal BASE NÃO é a data de constituição da empresa (pode ser antiga mas sem contratos públicos, ou ter mudado de NIF). Só desde 2013 (os dados começam em 2012)."),
    "LOTES_ACIMA_DO_TETO": ("contrato", 1.0, "Lotes que somados ultrapassam o teto",
        "Procedimento pelo valor dividido em lotes, cada um abaixo do teto, mas cuja soma iguala ou ultrapassa o teto do procedimento escolhido (o art.º 22.º do CCP manda escolher o procedimento pelo valor total).",
        "O art.º 22.º, n.º 2 permite exceções para lotes pequenos; alguns 'lotes' são contratos individuais (ex.: prestadores pessoa singular) agrupados num só procedimento. Somas exatamente iguais ao teto (tetos 'até X €') não são assinaladas."),
    "MODIF_ACIMA_DO_TETO": ("contrato", 2.0, "Modificação leva o contrato acima do teto",
        "Contrato adjudicado por ajuste direto/consulta prévia pelo valor abaixo do teto que, depois de modificado, passa a valer o teto ou mais (o procedimento escolhido já não seria admissível para esse valor).",
        "Algumas modificações estão previstas no contrato ou resultam de circunstâncias imprevisíveis (art.º 312.º CCP)."),
    "SEM_ANUNCIO": ("contrato", 0.25, "Concurso sem anúncio publicado",
        "Concurso público/limitado sem anúncio correspondente no conjunto de anúncios do Portal BASE (sem referência ou referência inexistente).",
        "Concentra-se em 2018–2019 e 2024–2026 (mudanças de plataforma); muitas vezes é lacuna de registo e não falta de publicidade. Sistemas de aquisição dinâmicos excluídos."),
    "PRAZO_CURTO": ("contrato", 0.25, "Prazo de propostas no mínimo habitual",
        "O anúncio do concurso deu um prazo para propostas igual ao percentil 10 do seu tipo e regime (6 dias bens/serviços e 14 dias empreitadas desde 2018; 9 e 15 dias até 2017) — na prática, o mínimo legal.",
        "É legal; 96% dos casos ≤ p10 estão exatamente nesse valor. Só indica que o comprador deu o mínimo de tempo aos concorrentes."),
    "PRAZO_MUITO_CURTO": ("contrato", 1.0, "Prazo de propostas abaixo do habitual mínimo",
        "O anúncio do concurso (não urgente) deu um prazo para propostas inferior ao percentil 10 do seu tipo e regime (ex.: 11 dias numa empreitada quando quase todos os concursos dão pelo menos 14).",
        "A contagem de dias no anúncio pode estar em dias úteis ou mal registada; concursos urgentes estão excluídos. Verificar o anúncio no Diário da República."),
    "DERRAPAGEM": ("contrato", 1.5, "Preço subiu > 25% por modificações",
        "A última modificação registada fixa um preço mais de 25% acima do preço contratual inicial (peso 2,5 acima de +50%). Ignora contratos cujas modificações são só revisões de preços ou cessões de posição.",
        "Ver o fundamento de cada modificação: alterações por interesse público ou circunstâncias imprevistas podem ser legítimas."),
    "SEM_NIF_FORNECEDOR": ("contrato", 0.5, "Empresa adjudicatária sem NIF",
        "O contrato não identifica o NIF do adjudicatário (uma empresa, pelo nome), o que impede ligar o dinheiro a quem o recebe.",
        "Inclui empresas estrangeiras sem NIF português. Pessoas singulares sem NIF não são assinaladas (o NIF é muitas vezes omitido por proteção de dados)."),
    "NIF_INVALIDO": ("contrato", 0.25, "NIF do fornecedor inválido",
        "O NIF português (9 dígitos) do adjudicatário falha o dígito de controlo.", "Erro de registo provável."),
    "SEM_LISTA_CONCORRENTES": ("contrato", 0.25, "Procedimento concorrencial sem lista de concorrentes",
        "Concurso ou consulta prévia publicado sem a lista de concorrentes, o que impede verificar a concorrência.",
        "Lacuna de dados do Portal BASE, frequente em contratos recentes e acordos-quadro."),
    # ---------------- par comprador-fornecedor
    "FORNECEDOR_DOMINANTE": ("par", 2.0, "Fornecedor dominante nos ajustes diretos",
        "Um só fornecedor recebe ≥ 40% do valor (e ≥ 5 contratos) dos ajustes diretos de um comprador com ≥ 20 ajustes diretos.",
        "Em contratos de exclusividade técnica (licenças, manutenção de equipamento) a concentração pode ser inevitável."),
    "VENCEDOR_POUCA_CONCORRENCIA": ("par", 1.5, "Vence repetidamente com pouca concorrência",
        "O fornecedor ganha ≥ 5 procedimentos concorrenciais do comprador com 1–2 concorrentes, ≥ 50% desses procedimentos do comprador.",
        "Pode refletir um mercado local pequeno."),
    "CONCORRENTE_DE_COBERTURA": ("par", 2.0, "Concorrente que perde sempre para o mesmo vencedor",
        "Uma empresa concorreu a ≥ 5 procedimentos do comprador, nunca ganhou nenhum, ganha < 10% das propostas que apresenta no país inteiro, e em ≥ 80% desses procedimentos perdeu para o mesmo vencedor (padrão típico de 'propostas de cobertura').",
        "Também acontece com concorrentes genuinamente menos competitivos; precisa de verificação das propostas."),
    "ROTACAO": ("par", 2.0, "Mesmo grupo de concorrentes com rotação de vencedores",
        "O mesmo conjunto exato de 3–6 concorrentes aparece em ≥ 5 procedimentos distintos do mesmo comprador, todos ganham pelo menos uma vez e nenhum ganha mais de 60%.",
        "Em mercados com poucos fornecedores qualificados o mesmo grupo repete-se naturalmente. Conjuntos de 2 (ex.: dois bancos, duas empresas de refeições) foram excluídos por serem sobretudo duopólios naturais."),
    # ---------------- entidade
    "E_CONCENTRACAO_TETO": ("entidade", 2.0, "Contratos colados ao teto muito acima da média nacional",
        "Proporção de procedimentos pelo valor na faixa 95–100% do teto ≥ 2× a esperada pela média nacional de cada regra (≥ 10 procedimentos, desvio ≥ 3 erros-padrão) e ≥ 1,5× a dos pares do mesmo tipo e dimensão. Peso 3 se ≥ 3×.",
        "Ver os contratos: um preço-tipo legítimo repetido (ex.: uma avença) também produz o padrão."),
    "E_FRACIONAMENTO": ("entidade", 2.0, "Fracionamento possível frequente",
        "≥ 5 procedimentos em grupos de possível fracionamento e taxa ≥ 2× a dos pares (comparada com entidades pares do mesmo tipo e escalão de dimensão (municípios: quartil de população, Censos 2021; restantes: quartil do valor contratado), excluindo a própria; exige desvio ≥ 3 erros-padrão).", "Ver a bandeira FRACIONAMENTO."),
    "E_ART113": ("entidade", 2.0, "Repetição de ajustes diretos acima do limite de 3 anos",
        "≥ 5 procedimentos com a bandeira ART113 e taxa ≥ 2× a dos pares (comparada com entidades pares do mesmo tipo e escalão de dimensão (municípios: quartil de população, Censos 2021; restantes: quartil do valor contratado), excluindo a própria; exige desvio ≥ 3 erros-padrão).", "Ver a bandeira ART113."),
    "E_CONCORRENTE_UNICO": ("entidade", 1.0, "Muitos procedimentos com concorrente único",
        "Taxa de procedimentos concorrenciais com uma só proposta ≥ 2× a dos pares (comparada com entidades pares do mesmo tipo e escalão de dimensão (municípios: quartil de população, Censos 2021; restantes: quartil do valor contratado), excluindo a própria; exige desvio ≥ 3 erros-padrão); ≥ 5 casos.",
        "Já mostrado na página da entidade; aqui comparado ao tipo de entidade."),
    "E_DERRAPAGEM": ("entidade", 1.0, "Modificações com subidas de preço frequentes",
        "≥ 5 contratos com subida > 25% e taxa ≥ 3× a dos pares (comparada com entidades pares do mesmo tipo e escalão de dimensão (municípios: quartil de população, Censos 2021; restantes: quartil do valor contratado), excluindo a própria; exige desvio ≥ 3 erros-padrão).", "Ver o fundamento das modificações."),
    "E_DEZEMBRO": ("entidade", 1.0, "Pico de ajustes diretos em dezembro",
        "Proporção de procedimentos de ajuste direto assinados em dezembro ≥ 2× a dos pares (comparada com entidades pares do mesmo tipo e escalão de dimensão (municípios: quartil de população, Censos 2021; restantes: quartil do valor contratado), excluindo a própria; exige desvio ≥ 3 erros-padrão); ≥ 15 em dezembro.",
        "O fim do ano orçamental concentra despesa em muitas entidades; é um sinal de planeamento, não de ilegalidade."),
    "E_PRE_ELEITORAL": ("entidade", 1.0, "Aumento de ajustes diretos antes das autárquicas",
        "Autarquias: a proporção anual de ajustes diretos nos {d} dias antes das eleições autárquicas (2013, 2017, 2021, 2025) é ≥ 1,5× a do mesmo período nos anos sem eleições e ≥ 1,3× a razão dos pares do mesmo tipo e dimensão (≥ 30 procedimentos nessa janela, desvio ≥ 3 erros-padrão).".format(d=PRE_ELECTION_DAYS),
        "Obras planeadas para o fim do mandato são comuns e não são necessariamente irregulares."),
    "E_DADOS_EM_FALTA": ("entidade", 0.5, "Dados de transparência em falta",
        "Proporção de contratos sem NIF do fornecedor ou concursos sem lista de concorrentes ≥ 2× a dos pares (comparada com entidades pares do mesmo tipo e escalão de dimensão (municípios: quartil de população, Censos 2021; restantes: quartil do valor contratado), excluindo a própria; exige desvio ≥ 3 erros-padrão); ≥ 10 casos.",
        "Pode ser problema do sistema de registo usado pela entidade."),
    "E_PRAZOS_CURTOS": ("entidade", 0.5, "Prazos de propostas curtos frequentes",
        "Proporção dos anúncios de concurso da entidade com prazo ≤ p10 (por tipo e regime) ≥ 2× a dos pares (comparada com entidades pares do mesmo tipo e escalão de dimensão (municípios: quartil de população, Censos 2021; restantes: quartil do valor contratado), excluindo a própria; exige desvio ≥ 3 erros-padrão); ≥ 5 casos.",
        "Ver PRAZO_CURTO."),
    "E_SEM_ANUNCIO": ("entidade", 1.0, "Concursos sem anúncio frequentes",
        "Proporção de concursos públicos/limitados sem anúncio correspondente ≥ 3× a dos pares (comparada com entidades pares do mesmo tipo e escalão de dimensão (municípios: quartil de população, Censos 2021; restantes: quartil do valor contratado), excluindo a própria; exige desvio ≥ 3 erros-padrão); ≥ 3 casos.",
        "Ver SEM_ANUNCIO: frequentemente lacuna de registo."),
    "E_MODIF_ACIMA_TETO": ("entidade", 1.0, "Modificações que ultrapassam o teto frequentes",
        "Proporção de procedimentos pelo valor que passam o teto após modificação ≥ 3× a dos pares (comparada com entidades pares do mesmo tipo e escalão de dimensão (municípios: quartil de população, Censos 2021; restantes: quartil do valor contratado), excluindo a própria; exige desvio ≥ 3 erros-padrão); ≥ 3 casos.",
        "Ver MODIF_ACIMA_DO_TETO."),
    "E_PARES_SUSPEITOS": ("entidade", 1.0, "Padrões de concorrência suspeitos",
        "Tem pares comprador-fornecedor com bandeiras de dominância, cobertura ou rotação (peso 1 por tipo de padrão presente, máx. 3).",
        "Ver os pares listados."),
    # fornecedor
    "F_FORNECEDOR_NOVO": ("entidade", 1.5, "Contratos grandes no primeiro ano de atividade pública",
        "Fornecedor com contratos FORNECEDOR_NOVO.", "Ver a bandeira FORNECEDOR_NOVO."),
    "F_DERRAPAGEM": ("entidade", 1.5, "Fornecedor com subidas de preço repetidas",
        "≥ 3 contratos com subida > 25% e ≥ 30% dos seus contratos modificados com essa subida; mostra a parte de 'trabalhos/serviços complementares'.",
        "Empreiteiros de obras grandes têm naturalmente mais modificações."),
    "F_NUNCA_GANHA": ("entidade", 1.0, "Concorre muito e nunca ganha",
        "Concorreu a ≥ 10 procedimentos e nunca foi adjudicatário de nenhum contrato público.",
        "Pode ser uma empresa simplesmente pouco competitiva."),
    "F_FRACIONAMENTO": ("entidade", 1.0, "Recebe contratos possivelmente fracionados",
        "≥ 3 contratos com bandeira FRACIONAMENTO ou ART113 como fornecedor.", "Ver contratos."),
    "F_DOMINANTE": ("entidade", 1.0, "Fornecedor dominante em vários compradores",
        "Bandeira FORNECEDOR_DOMINANTE em ≥ 1 comprador (peso 1, 2 se ≥ 3 compradores).", "Ver pares."),
}
FLAG_SEE = {"E_FRACIONAMENTO": "FRACIONAMENTO", "E_ART113": "ART113", "E_CONCORRENTE_UNICO": "CONCORRENTE_UNICO", "E_DERRAPAGEM": "DERRAPAGEM",
            "E_PRAZOS_CURTOS": "PRAZO_CURTO", "E_SEM_ANUNCIO": "SEM_ANUNCIO", "E_MODIF_ACIMA_TETO": "MODIF_ACIMA_DO_TETO"}
SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE flag_defs (flag TEXT PRIMARY KEY, level TEXT, weight REAL, label TEXT, description TEXT, caveat TEXT, n_flagged INTEGER, value_flagged REAL);
CREATE TABLE contract_flags (contract_id TEXT, flag TEXT, weight REAL, evidence_json TEXT,
  year INTEGER, signed TEXT, price REAL, buyer_nif TEXT, seller_nif TEXT, procedure_id TEXT, buyer_kind TEXT, seller_kind TEXT);
CREATE TABLE contract_score (contract_id TEXT PRIMARY KEY, score REAL, flags TEXT, year INTEGER, signed TEXT, price REAL,
  procedure TEXT, buyer_nif TEXT, seller_nif TEXT, buyer_kind TEXT, procedure_id TEXT, seller_kind TEXT);
CREATE TABLE pair_flags (buyer_nif TEXT, seller_nif TEXT, flag TEXT, weight REAL, n_contracts INTEGER, value REAL, evidence_json TEXT,
  buyer_kind TEXT, seller_kind TEXT);
CREATE TABLE entity_risk (nif TEXT, role TEXT, name TEXT, kind TEXT, score REAL, flags_json TEXT, n_contracts INTEGER, value REAL,
  n_flagged_contracts INTEGER, peer_group TEXT, n_peers INTEGER, context_json TEXT, PRIMARY KEY (nif, role));
CREATE TABLE entity_context (nif TEXT PRIMARY KEY, kind TEXT, peer_group TEXT, n_peers INTEGER, context_json TEXT);
"""
INDEXES = """
CREATE INDEX cf_contract ON contract_flags(contract_id);
CREATE INDEX cf_flag ON contract_flags(flag, price DESC);
CREATE INDEX cf_flag_kind ON contract_flags(flag, buyer_kind, year, price DESC);
CREATE INDEX cf_flag_year ON contract_flags(flag, year, price DESC);
CREATE INDEX cs_kind ON contract_score(buyer_kind, year, score DESC);
CREATE INDEX cf_buyer ON contract_flags(buyer_nif, flag);
CREATE INDEX cf_seller ON contract_flags(seller_nif, flag);
CREATE INDEX cs_score ON contract_score(score DESC, price DESC);
CREATE INDEX cs_year ON contract_score(year, score DESC);
CREATE INDEX cs_buyer ON contract_score(buyer_nif, year);
CREATE INDEX cs_seller ON contract_score(seller_nif);
CREATE INDEX pf_buyer ON pair_flags(buyer_nif);
CREATE INDEX pf_seller ON pair_flags(seller_nif);
CREATE INDEX pf_flag ON pair_flags(flag, value DESC);
CREATE INDEX er_score ON entity_risk(score DESC);
CREATE INDEX er_kind ON entity_risk(kind, score DESC);
CREATE INDEX cf_proc ON contract_flags(procedure_id);
"""


COMPANY_RX = re.compile(r"\b(lda|l\.da|limitada|s\.\s?a\.?|sa|unipessoal|crl|sgps|ltd|limited|gmbh|inc|llc|s\.l\.?|sl|bv|ag|sas|srl|spa|"
                        r"sociedade|companhia|cia|grupo|empresa|comercial|ind[uú]stria|construç|engenharia)\b", re.I)
NONPROFIT_RX = re.compile(r"associa|bombeir|funda[çc][ãa]o|miseric[óo]rdia|santa casa|cooperativa|\bcrl\b|clube|instituto|universidade|"
                          r"centro social|ipss|federa[çc][ãa]o|sindicato|par[óo]quia|igreja|cruz vermelha|junta de freguesia|munic[ií]pio", re.I)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def dnum(s):
    try:
        return date(int(s[:4]), int(s[5:7]), int(s[8:10])).toordinal()
    except Exception:
        return None


def nif_ok(n):
    if not n or len(n) != 9 or not n.isdigit():
        return None   # não é NIF português de 9 dígitos -> não se avalia
    s = sum(int(n[i]) * (9 - i) for i in range(8))
    c = 11 - s % 11
    return (0 if c >= 10 else c) == int(n[8])


def cpv4(code):
    return (code or "")[:4]


STOP = set("""aquisicao aquisicoes fornecimento fornecimentos prestacao prestacoes servico servicos empreitada empreitadas obra obras
contrato contratos para pela pelo pelos pelas das dos com sem uma uns umas sua seu nas nos por the and""".split())


def toks(s):
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return {t for t in re.findall(r"[a-z]{3,}", s) if t not in STOP}


def similar(a, b):
    """Mesmo objeto?  CPV completo igual e específico (não termina em 0000) ou Jaccard das palavras do objeto >= 0,5."""
    ca, cb = a[0], b[0]
    if ca and ca == cb and not ca[:8].endswith("0000"):
        return True
    ta, tb = a[1], b[1]
    return bool(ta and tb) and len(ta & tb) / len(ta | tb) >= 0.5


def ev(**k):
    return json.dumps(k, ensure_ascii=False, separators=(",", ":"))


def rule_of(proc, lb):
    if not lb or "artigo 4.º" in lb:
        return None
    for code, p, rx, t, post, _ in RULE_RX:
        if proc == p and rx.match(lb):
            return code
    return None


PROC_RX = re.compile(r'"idcontrato":"(\d+)"[^{}]*?"idprocedimento":"?(\d*)')


def load_procmap():
    """idcontrato -> idprocedimento (lotes do mesmo procedimento partilham o id), lido dos JSON anuais em bruto do
    Portal BASE (data/raw/contracts/*.zip, o campo não está em politica.db).  Cache em data/raw/risco/procmap.tsv.gz."""
    zips = sorted(RAW_CONTRACTS.glob("*.zip"))
    if PROCMAP_CACHE.exists() and all(z.stat().st_mtime <= PROCMAP_CACHE.stat().st_mtime for z in zips):
        with gzip.open(PROCMAP_CACHE, "rt") as fh:
            return dict(line.rstrip("\n").split("\t") for line in fh)
    m = {}
    for zf in zips:
        with zipfile.ZipFile(zf) as z:
            for name in z.namelist():
                fh, buf = z.open(name), ""
                while True:
                    b = fh.read(1 << 25)
                    if not b:
                        break
                    buf += b.decode("utf-8", "replace")
                    cut = buf.rfind('"idcontrato"')
                    part, buf = (buf[:cut], buf[cut:]) if cut > 0 else ("", buf)
                    for a, p in PROC_RX.findall(part):
                        if p:
                            m[a] = p
                for a, p in PROC_RX.findall(buf):
                    if p:
                        m[a] = p
    PROCMAP_CACHE.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(PROCMAP_CACHE, "wt") as fh:
        for a, p in m.items():
            fh.write(f"{a}\t{p}\n")
    return m


class Job:
    def __init__(self):
        self.src = sqlite3.connect(f"file:{POLITICA}?mode=ro", uri=True)
        self.src.execute("PRAGMA query_only=1")
        self.cflags = []          # (cid, flag, weight, evidence)
        self.cinfo = {}           # cid -> (year, signed, price, buyer, seller, procedure)
        self.pairs = []           # (buyer, seller, flag, weight, n, value, evidence)
        self.buyer = defaultdict(Counter)   # métricas por comprador
        self.seller = defaultdict(Counter)
        self.nat = Counter()      # linhas de base nacionais
        self.diag = {}

    # ------------------------------------------------------------------ referência
    def load_reference(self):
        log("entities")
        self.ent = {}
        for nif, eid, name, kind, pub, pop, dico in self.src.execute("SELECT nif, id, name, kind, is_public, population, dico FROM entities WHERE nif IS NOT NULL"):
            self.ent[nif] = (eid, name, kind, pub, pop, dico)
        self.bvalue = dict(self.src.execute("SELECT nif, value FROM buyer_stats"))
        self.modstats = {r[0]: r[1:] for r in self.src.execute("SELECT nif, modified_n, big_increase_n, increase_value FROM buyer_mod_stats")}
        log("procedure ids (lots of one tender = one procedure)")
        self.procmap = load_procmap()
        self.load_anuncios()
        self.load_autarquias()
        log("first appearance of every supplier/bidder NIF")
        self.first = {}
        for nif, d in self.src.execute("""SELECT p.nif, MIN(c.signed) FROM contract_parties p JOIN contracts c ON c.id=p.contract_id
                                          WHERE p.role IN ('seller','bidder') AND p.nif IS NOT NULL AND c.signed IS NOT NULL GROUP BY p.nif"""):
            self.first[nif] = d
        log("modifications")
        self.mods = {}
        for cid, d, basis, price in self.src.execute("SELECT contract_id, date, basis, new_price FROM contract_mods ORDER BY contract_id, date, rowid"):
            m = self.mods.setdefault(cid, {"n": 0, "last": None, "compl": 0, "basis": []})
            m["n"] += 1
            if price and price > 0:
                m["last"] = price
            if basis and "omplementares" in basis:
                m["compl"] += 1
            if not basis or not re.search(r"Revis[ãa]o|Cess[ãa]o da posi", basis):
                m["substantive"] = True
            if basis and len(m["basis"]) < 4:
                m["basis"].append([d, (basis or "")[:90], price])
        log("bidders")
        self.bid = defaultdict(list)
        self.bid_n, self.bid_won = Counter(), Counter()   # taxa nacional de vitória de cada concorrente
        for cid, nif, seller in self.src.execute("""SELECT p.contract_id, p.nif, c.seller_nif FROM contract_parties p JOIN contracts c ON c.id=p.contract_id
                                                     WHERE p.role='bidder' AND p.nif IS NOT NULL AND p.nif != ''"""):
            self.bid[cid].append(nif)
            self.bid_n[nif] += 1
            self.bid_won[nif] += nif == seller
        self.ever_won = set(r[0] for r in self.src.execute("SELECT DISTINCT nif FROM contract_parties WHERE role='seller' AND nif IS NOT NULL"))

    def load_anuncios(self):
        """data/anuncios.db (só leitura): concursos sem anúncio e anúncios com prazo curto (<= p10 por tipo e regime)."""
        self.noann, self.short, self.ann_buyer = {}, {}, {}
        if not ANUNCIOS.exists():
            log("  anuncios.db não existe: sinais de anúncio desativados")
            self.diag["anuncios"] = "indisponível"
            return
        a = sqlite3.connect(f"file:{ANUNCIOS}?mode=ro", uri=True)
        for cid, reason, ref in a.execute("SELECT contract_id, reason, announcement_ref FROM contracts_no_ann WHERE reason IN ('sem_referencia','nao_encontrada')"):
            self.noann[cid] = (reason, ref)
        thr = {}
        try:
            ov = json.loads(a.execute("SELECT value FROM meta WHERE key='overview'").fetchone()[0])
            thr = {tuple(int(x) for x in k.split("_")): v for k, v in ov.get("deadline_thresholds", {}).items()}
        except Exception:
            pass
        lbl = lambda ob, p18: f"{'empreitadas' if ob else 'bens/serviços'} {'desde 2018' if p18 else 'até 2017'}"
        for cid, aid, n_an, pub, dias, ob, p18 in a.execute("""SELECT l.contract_id, a.id, a.n_anuncio, a.published, a.prazo_dias, a.obras, a.post2018
                                                               FROM contract_links l JOIN announcements a ON a.id = l.announcement_id WHERE a.short = 1"""):
            self.short[cid] = (n_an, pub, dias, thr.get((ob, p18)), lbl(ob, p18))
        for nif, n, k in a.execute("""SELECT buyer_nif, COUNT(*), SUM(short) FROM announcements WHERE is_primary=1 AND is_tender=1 AND ok_deadline=1 AND prazo_dias>0
                                      GROUP BY buyer_nif"""):
            self.ann_buyer[nif] = (n, k or 0)
        self.diag["anuncios"] = {"limiares_prazo_curto_p10": {lbl(*k): v for k, v in thr.items()}, "contratos_sem_anuncio": len(self.noann),
                                 "contratos_com_anuncio_de_prazo_curto": len(self.short)}
        a.close()

    def load_autarquias(self):
        """data/autarquias.db (só leitura): prazo médio de pagamento (pmp) e execução orçamental — apenas CONTEXTO, não bandeiras."""
        self.muni = {}
        if not AUTARQUIAS.exists():
            return
        a = sqlite3.connect(f"file:{AUTARQUIAS}?mode=ro", uri=True)
        for dico, date_, days in a.execute("SELECT dico, date, days FROM pmp p WHERE date = (SELECT MAX(date) FROM pmp q WHERE q.dico = p.dico)"):
            self.muni.setdefault(dico, {})["prazo_medio_pagamento"] = {"dias": days, "data": date_}
        for dico, year, orc, exe in a.execute("""SELECT dico, year, SUM(CASE WHEN stage='orcamento' THEN value END), SUM(CASE WHEN stage='executado' THEN value END)
                                                 FROM budget WHERE kind='despesa' GROUP BY dico, year ORDER BY year"""):
            if orc and exe:
                self.muni.setdefault(dico, {})["execucao_despesa"] = {"ano": year, "orcamento_eur": round(orc, 2), "executado_eur": round(exe, 2),
                                                                      "taxa_execucao_pct": round(100 * exe / orc, 1)}
        # chave final: NIF do município (entities.dico está vazio para municípios; a ligação vem de autarquias.municipios)
        bydico, self.muni = self.muni, {}
        for dico, nif, enif in a.execute("SELECT dico, nif, entity_nif FROM municipios"):
            for n in {nif, enif} - {None, ""}:
                if dico in bydico:
                    self.muni[n] = dict(bydico[dico], dico=dico)
        a.close()

    # ------------------------------------------------------------------ validação empírica dos tetos
    def validate_thresholds(self):
        """Histograma por PROCEDIMENTO (lotes somados: o teto aplica-se ao valor do procedimento, art.º 22.º CCP)."""
        log("validating ceilings from the price histogram (per procedure)")
        tot, rul = defaultdict(float), {}
        ncon = Counter()
        for cid, buyer, proc, lb, price in self.src.execute(
                "SELECT id, buyer_nif, procedure, legal_basis, price FROM contracts WHERE procedure IN (?,?) AND price > 0", (AD, CP)):
            r = rule_of(proc, lb)
            if r:
                k = self.pkey(cid, buyer)
                tot[k] += price
                rul.setdefault(k, r)
                ncon[r] += 1
        h = defaultdict(Counter)
        for k, v in tot.items():
            h[rul[k]][int(v // 500)] += 1
        out = []
        for code, p, rx, t, post, desc in RULE_RX:
            c = h[code]
            n = sum(c.values())
            at = sum(c[b] for b in range(int(t * BUNCH_LO // 500), int(t // 500)))
            below = sum(c[b] for b in range(int(t * 0.85 // 500), int(t * 0.90 // 500)))
            above = sum(c[b] for b in range(int(t // 500), int(t * 1.05 // 500)))
            over = sum(v for b, v in c.items() if b * 500 >= t)
            share = at / n if n else 0
            out.append({"rule": code, "procedure": p, "ceiling": t, "regime_2018": post, "description": desc, "n_procedures": n, "n_contracts": ncon[code],
                        "n_95_100": at, "n_85_90": below, "n_100_105": above, "n_over_ceiling": over,
                        "share_95_100": round(share, 4), "spike_ratio": round(at / max(1, below), 1),
                        "confirmed": at > 2.5 * max(1, below) and at > 2.5 * max(1, above)})
            self.nat[("bunch_p", code)] = share
        self.diag["thresholds"] = out
        for o in out:
            log(f"  {o['rule']:<17} teto {o['ceiling']:>7} procs={o['n_procedures']:>7} 95-100%={o['n_95_100']:>6} 85-90%={o['n_85_90']:>5} 100-105%={o['n_100_105']:>4} ratio={o['spike_ratio']} confirmed={o['confirmed']}")

    def pkey(self, cid, buyer):
        """Chave do procedimento: comprador + idprocedimento do Portal BASE (todos os lotes de um concurso = 1 procedimento)."""
        return f"{buyer}|{self.procmap.get(cid) or 'c' + cid}"

    # ------------------------------------------------------------------ passagem principal (por comprador)
    def scan(self):
        log("scanning contracts by buyer")
        q = """SELECT id, year, signed, published, procedure, types, price, legal_basis, cpv_code, buyer_nif, seller_nif, n_bidders, announcement, seller_name, object
               FROM contracts WHERE buyer_nif IS NOT NULL ORDER BY buyer_nif"""
        cur, rows, nb = None, [], 0
        for r in self.src.execute(q):
            if r[9] != cur:
                if rows:
                    self.do_buyer(cur, rows)
                    nb += 1
                cur, rows = r[9], []
            rows.append(r)
        if rows:
            self.do_buyer(cur, rows)
        log(f"  {nb} buyers, {len(self.cflags)} contract flags, {len(self.pairs)} pair flags")

    def add(self, row, flag, weight, evidence):
        cid = row[0]
        self.cflags.append((cid, flag, weight, evidence))
        if cid not in self.cinfo:
            self.cinfo[cid] = (row[1], row[2] or row[3], row[6], row[9], row[10], row[4], self.procmap.get(cid))

    def do_buyer(self, buyer, rows):
        B = self.buyer[buyer]
        kind = (self.ent.get(buyer) or (None, None, None, None))[2] or "?"
        B["kind"] = kind
        groups = defaultdict(list)
        for row in rows:
            groups[self.pkey(row[0], buyer)].append(row)
        by_rule = defaultdict(list)   # (rule, seller, cpv4) -> [(d, total, row0, rows)]
        a113 = defaultdict(list)      # (family, seller, cpv4) -> [(d, year, total, rule, row0, rows)]
        elec = Counter()
        comp_by_seller = Counter()
        comp_low_by_seller = Counter()
        ad_by_seller = defaultdict(lambda: [0, 0.0])
        procs = {}                    # procedure key -> (winner, set(bidders), cid, date)
        # ================= nível do contrato
        for row in rows:
            cid, year, signed, published, proc, types, price, lb, cpv, _, seller, nbid, ann, sname, obj = row
            price = price or 0
            d = dnum(signed or published or "")
            B["n"] += 1
            self.nat["n"] += 1
            if not seller and COMPANY_RX.search(sname or ""):
                self.add(row, "SEM_NIF_FORNECEDOR", FLAGS["SEM_NIF_FORNECEDOR"][1], ev(motivo="seller_nif vazio no Portal BASE"))
                B["missing"] += 1
                self.nat["missing"] += 1
            elif nif_ok(seller) is False:
                self.add(row, "NIF_INVALIDO", FLAGS["NIF_INVALIDO"][1], ev(nif=seller, motivo="dígito de controlo inválido"))
            if proc in COMPETITIVE and nbid is None:
                self.add(row, "SEM_LISTA_CONCORRENTES", FLAGS["SEM_LISTA_CONCORRENTES"][1], ev(procedimento=proc))
                B["missing"] += 1
                self.nat["missing"] += 1
            # --- anúncios (data/anuncios.db)
            na = self.noann.get(cid)
            if na and not re.search(r"aquisi[çc][ãa]o din[âa]mic|\bSAD\b", obj or "", re.I):
                self.add(row, "SEM_ANUNCIO", FLAGS["SEM_ANUNCIO"][1], ev(procedimento=proc, motivo=na[0], referencia_anuncio=na[1],
                                                                          nota="sem anúncio correspondente no conjunto de anúncios do Portal BASE"))
            sh = self.short.get(cid)
            if sh:
                fl_ = "PRAZO_MUITO_CURTO" if sh[3] and sh[2] < sh[3] else "PRAZO_CURTO"
                self.add(row, fl_, FLAGS[fl_][1], ev(anuncio=sh[0], publicado=sh[1], prazo_dias=sh[2], limiar_p10_dias=sh[3], regime=sh[4]))
            # --- derrapagem
            m = self.mods.get(cid)
            if m:
                B["mod_n"] += 1
                if seller:
                    self.seller[seller]["mod_n"] += 1
                    self.seller[seller]["mod_compl"] += m["compl"] > 0
                if price >= 5000 and m["last"] and m["last"] > price * (1 + CREEP) and m.get("substantive"):
                    inc = m["last"] / price - 1
                    self.add(row, "DERRAPAGEM", 2.5 if inc > 0.5 else FLAGS["DERRAPAGEM"][1],
                             ev(preco_inicial=price, preco_final=m["last"], aumento_pct=round(100 * inc, 1), n_modificacoes=m["n"],
                                trabalhos_complementares=m["compl"], modificacoes=m["basis"]))
                    B["creep_n"] += 1
                    self.nat["creep_n"] += 1
                    if seller:
                        self.seller[seller]["creep_n"] += 1
                        self.seller[seller]["creep_compl"] += m["compl"] > 0
                        self.seller[seller]["creep_value"] += m["last"] - price
            # --- fornecedor novo
            if seller and d and price > 0:
                f = self.first.get(seller)
                ent = self.ent.get(seller)
                direct = proc in (AD, CP)
                if f and f >= "2013-01-01" and len(seller) == 9 and seller[0] not in "6" and not (ent and ent[3]) \
                        and not NONPROFIT_RX.search(sname or "") \
                        and price >= NEW_SUPPLIER_MIN["direct" if direct else "any"]:
                    fd = dnum(f)
                    if fd is not None and 0 <= d - fd <= NEW_SUPPLIER_DAYS:
                        self.add(row, "FORNECEDOR_NOVO", FLAGS["FORNECEDOR_NOVO"][1],
                                 ev(primeira_aparicao=f, dias_desde_primeira=d - fd, preco=price, procedimento=proc,
                                    nota="primeira aparição no Portal BASE, não data de constituição"))
                        self.seller[seller]["new_n"] += 1
                        self.seller[seller]["new_value"] += price
        # ================= nível do procedimento (lotes juntos)
        for pk, g in groups.items():
            g.sort(key=lambda r: (r[2] or r[3] or "", r[0]))
            r0 = g[0]
            proc, lb, signed, published = r0[4], r0[7], r0[2], r0[3]
            d = dnum(signed or published or "")
            total = sum(max(r[6] or 0, 0) for r in g)
            nl = len(g)
            sellers = Counter(r[10] for r in g if r[10])
            seller = sellers.most_common(1)[0][0] if sellers else None
            B["procs"] += 1
            # --- concorrência
            nbids = [r[11] for r in g if r[11] is not None]
            if proc in COMPETITIVE and nbids:
                B["comp_n"] += 1
                single = max(nbids) == 1
                if single:
                    w = 0.5 if proc.startswith("Consulta") else 1.0
                    for r in g:
                        self.add(r, "CONCORRENTE_UNICO", w, ev(procedimento=proc, concorrentes=1, preco=r[6], lotes=nl, valor_procedimento=round(total, 2)))
                    B["single_n"] += 1
                for s in sellers:
                    comp_by_seller[s] += 1
                    if max(nbids) <= 2:
                        comp_low_by_seller[s] += 1
                B["comp_low_n"] += max(nbids) <= 2
                bl = set()
                for r in g:
                    bl.update(self.bid.get(r[0], ()))
                if bl and seller:
                    procs[pk] = (seller, frozenset(bl), r0[0], signed, frozenset(sellers))
            if proc in ("Concurso público", "Concurso limitado por prévia qualificação"):
                B["open_n"] += 1
                B["noann_n"] += any(r[0] in self.noann for r in g)
            # --- ajustes diretos: dezembro, eleições, dominância (contados por procedimento)
            if proc == AD and d:
                mo = int((signed or published)[5:7])
                B["ad_n"] += 1
                B["ad_value"] += total
                B["ad_dec"] += mo == 12
                for r in g:
                    if r[10]:
                        a = ad_by_seller[r[10]]
                        a[0] += 1
                        a[1] += max(r[6] or 0, 0)
                yy = int((signed or published)[:4])
                if 2013 <= yy <= 2025:
                    ref = LOCAL_ELECTIONS.get(yy) or f"{yy}-{LOCAL_ELECTIONS[min(LOCAL_ELECTIONS, key=lambda e: abs(e - yy))][5:]}"
                    inwin = 0 < dnum(ref) - d <= PRE_ELECTION_DAYS
                    tag = "E" if yy in LOCAL_ELECTIONS else "N"
                    elec[tag + "tot"] += 1
                    elec[tag + "win"] += inwin
            # --- regras pelo valor (valor do procedimento = soma dos lotes)
            rule = rule_of(proc, lb) if total > 0 else None
            if not rule:
                continue
            T = RULE_T[rule]
            B["val_n"] += 1
            self.nat["val_n"] += 1
            B["bunch_exp"] += self.nat[("bunch_p", rule)]
            lots = [[r[0], r[6]] for r in g[:20]]
            if total >= T:
                if nl > 1 and all((r[6] or 0) < T for r in g) and total > T * 1.001:
                    for r in g:
                        self.add(r, "LOTES_ACIMA_DO_TETO", FLAGS["LOTES_ACIMA_DO_TETO"][1],
                                 ev(regra=rule, teto=T, valor_procedimento=round(total, 2), lotes=nl, contratos=lots, fundamento=lb))
                    B["lots_over"] += 1
                else:
                    for r in g:
                        if (r[6] or 0) >= T:
                            self.add(r, "ACIMA_DO_TETO", FLAGS["ACIMA_DO_TETO"][1], ev(regra=rule, teto=T, preco=r[6], fundamento=lb))
                continue
            if total >= BUNCH_LO * T:
                for r in g:
                    self.add(r, "JUNTO_AO_TETO", FLAGS["JUNTO_AO_TETO"][1],
                             ev(regra=rule, teto=T, valor_procedimento=round(total, 2), lotes=nl, pct_do_teto=round(100 * total / T, 1),
                                base_nacional_pct=round(100 * self.nat[("bunch_p", rule)], 2)))
                B["bunch_obs"] += 1
            # --- modificação que leva o procedimento acima do teto
            for r in g:
                m = self.mods.get(r[0])
                if m and m["last"] and m.get("substantive") and total - (r[6] or 0) + m["last"] >= T:
                    self.add(r, "MODIF_ACIMA_DO_TETO", FLAGS["MODIF_ACIMA_DO_TETO"][1],
                             ev(regra=rule, teto=T, valor_inicial_procedimento=round(total, 2), preco_inicial=r[6], preco_final=m["last"],
                                valor_final_procedimento=round(total - (r[6] or 0) + m["last"], 2), modificacoes=m["basis"]))
                    B["modceil_n"] += 1
                    break
            if d and seller:
                by_rule[(rule, seller, cpv4(r0[8]))].append((d, total, r0, g))
                fam = ART113_FAMILY.get(rule)
                if fam and (signed or "") >= "2018-01-01":
                    a113[(fam, seller, cpv4(r0[8]))].append((d, int((signed or published)[:4]), total, rule, r0, g))
        # ---------- fracionamento (unidades = procedimentos distintos)
        for (rule, seller, cg), lst in by_rule.items():
            if len(lst) < 2:
                continue
            lst.sort(key=lambda x: x[0])
            T = RULE_T[rule]
            for W in SPLIT_SENSITIVITY:
                groups_ = [g for comp in similar_components(lst, W) for g in split_groups(comp, W, T)]
                self.nat[("split_groups", W)] += len(groups_)
                self.nat[("split_procs", W)] += sum(len(g["idx"]) for g in groups_)
                if W != SPLIT_WINDOW:
                    continue
                for g in groups_:
                    members = g["members"]
                    e = ev(regra=rule, teto=T, janela_dias=W, grupo_cpv=cg, n_procedimentos=len(members),
                           soma=round(sum(x[1] for x in members), 2), soma_max_janela=round(g["best"], 2),
                           contratos=[[x[2][0], x[2][2] or x[2][3], round(x[1], 2), len(x[3])] for x in members[:25]])
                    for x in members:
                        for r in x[3]:
                            self.add(r, "FRACIONAMENTO", FLAGS["FRACIONAMENTO"][1], e)
                    B["split_n"] += len(members)
                    self.nat["split_n"] += len(members)
                    self.seller[seller]["split_n"] += len(members)
        # ---------- art.º 113.º, n.º 2
        for (fam, seller, cg), lst in a113.items():
            if len(lst) < 2:
                continue
            lst.sort(key=lambda x: x[0])
            for i, (d, y, total, rule, r0, g) in enumerate(lst):
                prior = [x for x in lst[:i] if y - 2 <= x[1] <= y and x[0] < d]
                tot = sum(x[2] for x in prior)
                T = RULE_T[rule]
                if prior and tot >= T:
                    e = ev(regra=rule, teto=T, anos=[y - 2, y], grupo_cpv=cg, soma_anterior=round(tot, 2), n_anteriores=len(prior),
                           anteriores=[[x[4][0], x[4][2], round(x[2], 2)] for x in prior[-15:]])
                    for r in g:
                        self.add(r, "ART113", FLAGS["ART113"][1], e)
                    B["a113_n"] += 1
                    self.nat["a113_n"] += 1
                    self.seller[seller]["a113_n"] += 1
        for k, v in elec.items():
            B["el_" + k] += v
        # ---------- pares: dominância nos ajustes diretos
        if B["ad_n"] >= 20 and B["ad_value"] > 0:
            for s, (n, v) in ad_by_seller.items():
                share = v / B["ad_value"]
                if n >= 5 and share >= 0.40:
                    self.pairs.append((buyer, s, "FORNECEDOR_DOMINANTE", FLAGS["FORNECEDOR_DOMINANTE"][1], n, v,
                                       ev(n_ajustes_diretos=n, valor=round(v, 2), quota_valor_pct=round(100 * share, 1),
                                          procedimentos_ad_comprador=B["ad_n"], valor_ajustes_comprador=round(B["ad_value"], 2))))
                    self.seller[s]["dominant_buyers"] += 1
        # ---------- pares: vence com pouca concorrência (procedimentos)
        low_tot = B["comp_low_n"]
        for s, n in comp_low_by_seller.items():
            if n >= 5 and n >= 0.5 * low_tot:
                self.pairs.append((buyer, s, "VENCEDOR_POUCA_CONCORRENCIA", FLAGS["VENCEDOR_POUCA_CONCORRENCIA"][1], n, None,
                                   ev(procedimentos_ganhos_com_1_2_concorrentes=n, procedimentos_comprador_com_1_2=low_tot,
                                      procedimentos_concorrenciais_ganhos=comp_by_seller[s])))
        # ---------- pares: cobertura e rotação (procedimentos distintos com lista de concorrentes)
        if len(procs) >= 5:
            lose = defaultdict(Counter)
            won_here = Counter()
            for p in procs.values():
                for s in p[4]:
                    won_here[s] += 1
            lose_ids = defaultdict(list)
            for key, (w, bs, cid, sg, ws) in procs.items():
                for b in bs:
                    if b not in ws and b != buyer:
                        lose[b][w] += 1
                        if len(lose_ids[b]) < 15:
                            lose_ids[b].append([cid, sg, w])
            for b, cn in lose.items():
                tot = sum(cn.values())
                wr = self.bid_won[b] / max(1, self.bid_n[b])
                if tot >= 5 and won_here[b] == 0 and wr < 0.10:
                    w, k = cn.most_common(1)[0]
                    if k >= 0.8 * tot:
                        self.pairs.append((buyer, w, "CONCORRENTE_DE_COBERTURA", FLAGS["CONCORRENTE_DE_COBERTURA"][1], k, None,
                                           ev(concorrente_perdedor=b, nome_perdedor=(self.ent.get(b) or (0, ""))[1], derrotas=tot,
                                              derrotas_para_este_vencedor=k, vitorias_do_perdedor_neste_comprador=0,
                                              perdedor_alguma_vez_ganhou=b in self.ever_won,
                                              taxa_vitoria_nacional_pct=round(100 * wr, 1), propostas_nacionais=self.bid_n[b], procedimentos=lose_ids[b])))
            sets = defaultdict(list)
            for key, (w, bs, cid, sg, ws) in procs.items():
                if 3 <= len(bs) <= 6 and len(ws) == 1 and w in bs:
                    sets[bs].append((w, cid, sg))
            for bs, lst in sets.items():
                dates = {x[2] for x in lst}
                winners = Counter(x[0] for x in lst)
                if len(dates) >= 5 and len(winners) == len(bs) and max(winners.values()) <= 0.6 * len(lst):
                    top = winners.most_common(1)[0][0]
                    self.pairs.append((buyer, top, "ROTACAO", FLAGS["ROTACAO"][1], len(lst), None,
                                       ev(concorrentes=sorted(bs), procedimentos=len(lst), datas_distintas=len(dates),
                                          vitorias=dict(winners), exemplos=[[x[1], x[2], x[0]] for x in lst[:15]])))

    # ------------------------------------------------------------------ pares (tipo + escalão de dimensão)
    def peer_groups(self):
        """Escalão: municípios -> quartil de população (entities.population, Censos 2021); restantes -> quartil do valor total
        contratado dentro do mesmo tipo.  Grupos com < 10 entidades caem para o tipo inteiro."""
        bykind = defaultdict(list)
        for nif, B in self.buyer.items():
            e = self.ent.get(nif)
            size = (e[4] if e and B["kind"] == "municipio" else None) or (self.bvalue.get(nif, 0) if B["kind"] != "municipio" else None)
            if size is not None:
                bykind[B["kind"]].append((size, nif))
        self.band = {}
        for k, lst in bykind.items():
            lst.sort()
            n = len(lst)
            for i, (size, nif) in enumerate(lst):
                self.band[nif] = 1 + min(3, 4 * i // max(1, n))
        members = defaultdict(list)
        for nif, B in self.buyer.items():
            members[(B["kind"], self.band.get(nif))].append(nif)
        self.peer = {}
        for nif, B in self.buyer.items():
            key = (B["kind"], self.band.get(nif))
            if len(members[key]) < 10:
                key = (B["kind"], None)
                members.setdefault(key, [n for n, b in self.buyer.items() if b["kind"] == B["kind"]])
            self.peer[nif] = key
        self.members = members

    def band_label(self, key):
        kind, b = key
        if b is None:
            return f"{kind} (todos)"
        return f"{kind} · {'população' if kind == 'municipio' else 'valor contratado'} {['', '1.º quartil (menores)', '2.º quartil', '3.º quartil', '4.º quartil (maiores)'][b]}"

    def peer_rate(self, nif, num, den):
        """Taxa dos pares (exclui a própria entidade)."""
        key = self.peer[nif]
        S, B = self.peer_sum[key], self.buyer[nif]
        n, d = S[num] - B[num], S[den] - B[den]
        return (n / d if d > 0 else 0), len(self.members[key]) - 1

    # ------------------------------------------------------------------ bandeiras de entidade
    def entity_flags(self):
        log("entity-level flags (peer groups: kind + size band)")
        nat = self.nat
        rate = lambda a, b: a / b if b else 0
        self.peer_groups()
        for nif, (n_dl, n_short) in self.ann_buyer.items():
            if nif in self.buyer:
                self.buyer[nif]["dl_n"] += n_dl
                self.buyer[nif]["dl_short"] += n_short
        self.peer_sum = defaultdict(Counter)
        for key, nifs in self.members.items():
            for n in nifs:
                self.peer_sum[key].update({k: v for k, v in self.buyer[n].items() if isinstance(v, (int, float))})
        tot = Counter()
        for B in self.buyer.values():
            tot.update({k: v for k, v in B.items() if isinstance(v, (int, float))})
        pairs_by_buyer = defaultdict(lambda: defaultdict(list))
        for p in self.pairs:
            pairs_by_buyer[p[0]][p[2]].append(p[1])
        loc = Counter()
        for nif, B in self.buyer.items():
            if B["kind"] in LOCAL_KINDS:
                loc.update({k: B[k] for k in ("el_Ewin", "el_Etot", "el_Nwin", "el_Ntot")})
        el_nat = rate(loc["el_Ewin"], loc["el_Etot"]) / max(1e-9, rate(loc["el_Nwin"], loc["el_Ntot"]))
        self.diag["national"] = {
            "contratos": nat["n"], "procedimentos": tot["procs"], "procedimentos_pelo_valor": nat["val_n"],
            "taxa_fracionamento": round(rate(nat["split_n"], nat["val_n"]), 5), "taxa_art113": round(rate(nat["a113_n"], nat["val_n"]), 5),
            "taxa_derrapagem": round(rate(nat["creep_n"], nat["n"]), 5), "taxa_dados_em_falta": round(rate(nat["missing"], nat["n"]), 5),
            "taxa_concorrente_unico_procedimentos": round(rate(tot["single_n"], tot["comp_n"]), 4),
            "taxa_prazo_curto_anuncios": round(rate(tot["dl_short"], tot["dl_n"]), 4),
            "taxa_sem_anuncio_concursos": round(rate(tot["noann_n"], tot["open_n"]), 4),
            "autarquias_pre_eleitoral": {"janela_dias": PRE_ELECTION_DAYS, "quota_janela_anos_eleicao": round(rate(loc["el_Ewin"], loc["el_Etot"]), 4),
                                         "quota_janela_outros_anos": round(rate(loc["el_Nwin"], loc["el_Ntot"]), 4), "razao": round(el_nat, 3)},
            "fracionamento_sensibilidade": {str(W): {"grupos": nat[("split_groups", W)], "procedimentos": nat[("split_procs", W)]} for W in SPLIT_SENSITIVITY},
            "grupos_de_pares": {self.band_label(k): len(v) for k, v in sorted(self.members.items(), key=lambda x: (str(x[0][0]), x[0][1] or 0)) if len(v) >= 10},
        }
        self.erisk = []
        self.ectx = {}

        def cmp(nif, num, den, min_k, mult, label_num, label_den, **extra):
            """Compara a taxa da entidade com a dos pares; devolve evidência se taxa >= mult × pares."""
            B = self.buyer[nif]
            if B[num] < min_k or B[den] <= 0:
                return None
            pr, npeers = self.peer_rate(nif, num, den)
            own = B[num] / B[den]
            if pr <= 0 or own < mult * pr:
                return None
            exp = B[den] * pr
            z = (B[num] - exp) / math.sqrt(exp) if exp > 0 else 0
            if z < 3:
                return None
            return dict({label_num: B[num], label_den: B[den], "taxa_pct": round(100 * own, 2), "taxa_pares_pct": round(100 * pr, 2),
                         "razao": round(own / pr, 2), "z": round(z, 1), "n_pares": npeers, "grupo_pares": self.band_label(self.peer[nif])}, **extra)

        for nif, B in self.buyer.items():
            kind = B["kind"]
            fl = []
            if B["bunch_obs"] >= 10 and B["bunch_exp"] > 0:
                ratio = B["bunch_obs"] / B["bunch_exp"]
                z = (B["bunch_obs"] - B["bunch_exp"]) / math.sqrt(B["bunch_exp"])
                pr, npeers = self.peer_rate(nif, "bunch_obs", "val_n")
                own = B["bunch_obs"] / B["val_n"]
                if ratio >= 2 and z >= 3 and own >= 1.5 * pr:
                    fl.append(("E_CONCENTRACAO_TETO", 3.0 if ratio >= 3 else 2.0,
                               dict(procedimentos_junto_ao_teto=B["bunch_obs"], esperados_media_nacional=round(B["bunch_exp"], 1), razao=round(ratio, 2), z=round(z, 1),
                                    procedimentos_pelo_valor=B["val_n"], taxa_pct=round(100 * own, 2), taxa_pares_pct=round(100 * pr, 2), n_pares=npeers,
                                    grupo_pares=self.band_label(self.peer[nif]), ver="JUNTO_AO_TETO")))
            for flag, w, args in (
                    ("E_FRACIONAMENTO", 2.0, ("split_n", "val_n", 5, 2, "procedimentos_em_fracionamento", "procedimentos_pelo_valor")),
                    ("E_ART113", 2.0, ("a113_n", "val_n", 5, 2, "procedimentos_art113", "procedimentos_pelo_valor")),
                    ("E_CONCORRENTE_UNICO", 1.0, ("single_n", "comp_n", 5, 2, "procedimentos_concorrente_unico", "procedimentos_concorrenciais")),
                    ("E_DERRAPAGEM", 1.0, ("creep_n", "n", 5, 3, "contratos_subida_25", "contratos")),
                    ("E_DEZEMBRO", 1.0, ("ad_dec", "ad_n", 15, 2, "ajustes_em_dezembro", "procedimentos_ajuste_direto")),
                    ("E_DADOS_EM_FALTA", 0.5, ("missing", "n", 10, 2, "casos", "contratos")),
                    ("E_PRAZOS_CURTOS", 0.5, ("dl_short", "dl_n", 5, 2, "anuncios_prazo_curto", "anuncios_com_prazo")),
                    ("E_SEM_ANUNCIO", 1.0, ("noann_n", "open_n", 3, 3, "concursos_sem_anuncio", "concursos")),
                    ("E_MODIF_ACIMA_TETO", 1.0, ("modceil_n", "val_n", 3, 3, "procedimentos_modificados_acima_do_teto", "procedimentos_pelo_valor"))):
                e = cmp(nif, *args, ver=FLAG_SEE.get(flag))
                if e:
                    fl.append((flag, w, e))
            if kind in LOCAL_KINDS and B["el_Ewin"] >= 30 and B["el_Ntot"] >= 50 and B["el_Nwin"] > 0:
                base = rate(B["el_Nwin"], B["el_Ntot"])
                exp = B["el_Etot"] * base
                r = rate(B["el_Ewin"], B["el_Etot"]) / base
                z = (B["el_Ewin"] - exp) / math.sqrt(exp) if exp > 0 else 0
                S, key = self.peer_sum[self.peer[nif]], self.peer[nif]
                pr = rate(S["el_Ewin"] - B["el_Ewin"], S["el_Etot"] - B["el_Etot"]) / max(1e-9, rate(S["el_Nwin"] - B["el_Nwin"], S["el_Ntot"] - B["el_Ntot"]))
                if r >= 1.5 and z >= 3 and r >= 1.3 * pr:
                    fl.append(("E_PRE_ELEITORAL", 1.0, dict(janela_dias=PRE_ELECTION_DAYS, ajustes_na_janela_anos_eleicao=B["el_Ewin"], ajustes_anos_eleicao=B["el_Etot"],
                                                             quota_anos_eleicao_pct=round(100 * rate(B["el_Ewin"], B["el_Etot"]), 1),
                                                             quota_outros_anos_pct=round(100 * base, 1), razao=round(r, 2), razao_pares=round(pr, 2),
                                                             razao_nacional_autarquias=round(el_nat, 2), z=round(z, 1), n_pares=len(self.members[key]) - 1,
                                                             grupo_pares=self.band_label(key))))
            pb = pairs_by_buyer.get(nif)
            if pb:
                fl.append(("E_PARES_SUSPEITOS", float(min(3, len(pb))), {k: v[:10] for k, v in pb.items()}))
            self.ectx[nif] = self.context(nif)
            if fl:
                self.erisk.append((nif, "comprador", fl, B["n"]))
        for nif, S in self.seller.items():
            fl = []
            if S["new_n"]:
                fl.append(("F_FORNECEDOR_NOVO", 1.5, dict(contratos=S["new_n"], valor=round(S["new_value"], 2), primeira_aparicao=self.first.get(nif), ver="FORNECEDOR_NOVO")))
            if S["creep_n"] >= 3 and rate(S["creep_n"], S["mod_n"]) >= 0.3:
                fl.append(("F_DERRAPAGEM", 1.5, dict(contratos_subida_25=S["creep_n"], contratos_modificados=S["mod_n"], aumento_total=round(S["creep_value"], 2),
                                                      com_trabalhos_complementares=S["creep_compl"], quota_complementares_pct=round(100 * rate(S["creep_compl"], S["creep_n"]), 1), ver="DERRAPAGEM")))
            if S["split_n"] + S["a113_n"] >= 3:
                fl.append(("F_FRACIONAMENTO", 1.0, dict(procedimentos_fracionamento=S["split_n"], procedimentos_art113=S["a113_n"], ver="FRACIONAMENTO,ART113")))
            if S["dominant_buyers"]:
                fl.append(("F_DOMINANTE", 2.0 if S["dominant_buyers"] >= 3 else 1.0, dict(compradores=S["dominant_buyers"], ver="FORNECEDOR_DOMINANTE")))
            if fl:
                self.erisk.append((nif, "fornecedor", fl, None))
        # concorre muito e nunca ganha
        bids = Counter()
        for cid, lst in self.bid.items():
            for b in set(lst):
                bids[b] += 1
        self.never = [(n, k) for n, k in bids.items() if k >= 10 and n not in self.ever_won]
        sel_idx = {(e[0], e[1]): e for e in self.erisk}
        for n, k in self.never:
            f = ("F_NUNCA_GANHA", 1.0, dict(propostas=k, vitorias=0))
            if (n, "fornecedor") in sel_idx:
                sel_idx[(n, "fornecedor")][2].append(f)
            else:
                self.erisk.append((n, "fornecedor", [f], 0))

    def context(self, nif):
        """Colunas de contexto (NÃO são bandeiras): pares, modificações (buyer_mod_stats), e para municípios PMP e execução orçamental."""
        B = self.buyer[nif]
        key = self.peer[nif]
        c = {"grupo_pares": self.band_label(key), "n_pares": len(self.members[key]) - 1, "procedimentos": B["procs"], "contratos": B["n"]}
        ms = self.modstats.get(nif)
        if ms:
            c["modificacoes"] = {"contratos_modificados": ms[0], "subidas_acima_25pct": ms[1], "aumento_total_eur": round(ms[2] or 0, 2)}
        e = self.ent.get(nif)
        if e and e[2] == "municipio":
            c["populacao_censos2021"] = e[4]
            m = self.muni.get(nif)
            if m:
                c.update(m)
        return c

    # ------------------------------------------------------------------ escrita
    def write(self):
        tmp = DB.with_suffix(".db.tmp")
        if tmp.exists():
            tmp.unlink()
        out = sqlite3.connect(tmp)
        out.executescript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;" + SCHEMA)
        log("writing contract_flags")
        kinds = {n: v[2] for n, v in self.ent.items()}
        out.executemany("INSERT INTO contract_flags VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        ((cid, f, w, e, *self.cinfo[cid][:3], self.cinfo[cid][3], self.cinfo[cid][4], self.cinfo[cid][6],
                          kinds.get(self.cinfo[cid][3]), kinds.get(self.cinfo[cid][4])) for cid, f, w, e in self.cflags if w > 0))
        score = defaultdict(float)
        names = defaultdict(set)
        for cid, f, w, e in self.cflags:
            if w > 0 and f not in names[cid]:
                score[cid] += w
                names[cid].add(f)
        out.executemany("INSERT INTO contract_score VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        ((cid, round(s, 2), ",".join(sorted(names[cid])), self.cinfo[cid][0], self.cinfo[cid][1], self.cinfo[cid][2],
                          self.cinfo[cid][5], self.cinfo[cid][3], self.cinfo[cid][4], kinds.get(self.cinfo[cid][3]), self.cinfo[cid][6], kinds.get(self.cinfo[cid][4])) for cid, s in score.items()))
        out.executemany("INSERT INTO pair_flags VALUES (?,?,?,?,?,?,?,?,?)", (p + (kinds.get(p[0]), kinds.get(p[1])) for p in self.pairs))
        # contagem de contratos com bandeiras por entidade
        fb, fs = Counter(), Counter()
        for cid in score:
            fb[self.cinfo[cid][3]] += 1
            fs[self.cinfo[cid][4]] += 1
        sstats = {r[0]: (r[1], r[2]) for r in self.src.execute("SELECT nif, n, value FROM seller_stats")}
        bstats = {r[0]: (r[1], r[2]) for r in self.src.execute("SELECT nif, n, value FROM buyer_stats")}
        rows = []
        for nif, role, fl, n in self.erisk:
            e = self.ent.get(nif)
            st = (bstats if role == "comprador" else sstats).get(nif, (n or 0, 0))
            fj = [dict(flag=f, weight=w, label=FLAGS[f][2], evidence=d) for f, w, d in fl]
            ctx = self.ectx.get(nif) if role == "comprador" else None
            rows.append((nif, role, e[1] if e else None, e[2] if e else None, round(sum(w for _, w, _ in fl), 2),
                         json.dumps(fj, ensure_ascii=False), st[0], st[1], (fb if role == "comprador" else fs).get(nif, 0),
                         ctx and ctx["grupo_pares"], ctx and ctx["n_pares"], ctx and json.dumps(ctx, ensure_ascii=False)))
        out.executemany("INSERT INTO entity_risk VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        out.executemany("INSERT INTO entity_context VALUES (?,?,?,?,?)",
                        ((nif, self.buyer[nif]["kind"], c["grupo_pares"], c["n_pares"], json.dumps(c, ensure_ascii=False)) for nif, c in self.ectx.items()))
        # definições + contagens
        cnt, val = Counter(), Counter()
        for cid, f, w, e in self.cflags:
            if w <= 0:
                continue
            cnt[f] += 1
            val[f] += max(self.cinfo[cid][2] or 0, 0)
        for p in self.pairs:
            cnt[p[2]] += 1
            val[p[2]] += p[5] or 0
        for nif, role, fl, n in self.erisk:
            for f, w, d in fl:
                cnt[f] += 1
        out.executemany("INSERT INTO flag_defs VALUES (?,?,?,?,?,?,?,?)",
                        ((f, *v, cnt[f], val[f]) for f, v in FLAGS.items()))
        self.diag["counts"] = {"contract_flags": len(self.cflags), "contracts_flagged": len(score), "pair_flags": len(self.pairs),
                               "entities_flagged": len(rows), "by_flag": dict(cnt),
                               "contracts_score_ge_3": sum(1 for s in score.values() if s >= 3)}
        meta = {"built": datetime.now().isoformat(timespec="seconds"), "version": VERSION, "params": {
            "bunch_lo": BUNCH_LO, "split_window_days": SPLIT_WINDOW, "new_supplier_days": NEW_SUPPLIER_DAYS, "new_supplier_min": NEW_SUPPLIER_MIN,
            "creep": CREEP, "local_elections": LOCAL_ELECTIONS, "pre_election_days": PRE_ELECTION_DAYS}, **self.diag}
        out.executemany("INSERT INTO meta VALUES (?,?)", ((k, json.dumps(v, ensure_ascii=False)) for k, v in meta.items()))
        log("indexes")
        out.executescript(INDEXES)
        out.commit()
        out.close()
        os.replace(tmp, DB)
        log("counts", json.dumps(self.diag["counts"], ensure_ascii=False))

    def export(self):
        log("export csv.gz")
        EXPORT.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        con.execute(f"ATTACH 'file:{POLITICA}?mode=ro' AS p")
        q = """SELECT s.contract_id, s.procedure_id, s.signed, s.year, s.procedure, s.price, s.score, s.flags, s.buyer_nif, c.buyer_name, s.buyer_kind,
                      s.seller_nif, c.seller_name, c.cpv_code, c.legal_basis, c.n_bidders, replace(replace(c.object, char(10), ' '), char(13), ' '),
                      (SELECT group_concat(flag || '=' || evidence_json, ' | ') FROM contract_flags f WHERE f.contract_id = s.contract_id)
               FROM contract_score s LEFT JOIN p.contracts c ON c.id = s.contract_id ORDER BY s.score DESC, s.price DESC"""
        with gzip.open(EXPORT, "wt", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["contract_id", "procedure_id", "signed", "year", "procedure", "price", "score", "flags", "buyer_nif", "buyer_name", "buyer_kind",
                        "seller_nif", "seller_name", "cpv_code", "legal_basis", "n_bidders", "object", "evidence"])
            for r in con.execute(q):
                w.writerow(r)
        con.close()


def similar_components(lst, W):
    """Parte a lista (mesmo comprador, fornecedor, regra e classe CPV de 4 dígitos) em componentes de contratos com objeto
    semelhante (ver similar) a menos de W dias uns dos outros."""
    n = len(lst)
    par = list(range(n))

    def find(i):
        while par[i] != i:
            par[i] = par[par[i]]
            i = par[i]
        return i
    sig = [((x[2][8] or ""), toks(x[2][14])) for x in lst]
    for i in range(n):
        for j in range(i + 1, n):
            if lst[j][0] - lst[i][0] > W:
                break
            if find(i) != find(j) and similar(sig[i], sig[j]):
                par[find(i)] = find(j)
    comps = defaultdict(list)
    for i in range(n):
        comps[find(i)].append(lst[i])
    return [c for c in comps.values() if len(c) >= 2]


def split_groups(lst, W, T):
    """lst ordenada por data: [(d, price, row)].  Janela deslizante de W dias; uma janela qualifica se tem >= 2 contratos e
    soma >= T.  Janelas qualificadas sobrepostas fundem-se num grupo.  Devolve [{idx:set, best:float}]."""
    groups, j, s = [], 0, 0.0
    cur = None
    for i, (d, p, *_) in enumerate(lst):
        s += p
        while d - lst[j][0] > W:
            s -= lst[j][1]
            j += 1
        if i - j + 1 >= 2 and s >= T:
            if cur and j <= cur["end"]:
                cur["idx"].update(range(j, i + 1))
                cur["end"] = i
                cur["best"] = max(cur["best"], s)
            else:
                cur = {"idx": set(range(j, i + 1)), "end": i, "best": s}
                groups.append(cur)
    for g in groups:
        g["members"] = [lst[i] for i in sorted(g["idx"])]
    return groups


def main():
    t = time.time()
    job = Job()
    job.load_reference()
    job.validate_thresholds()
    job.scan()
    job.entity_flags()
    job.write()
    job.export()
    log(f"done in {time.time() - t:.0f}s")


if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(ROOT / "ingest"))
    main()
