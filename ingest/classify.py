"""Heuristic classification of Portuguese public-sector entities from their legal names."""
import re
import unicodedata


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", s)).strip()


# (kind, level, regex on the *normalised* name) — first match wins
RULES = [
    ("municipio", "local", r"^(municipio|camara municipal) "),
    ("freguesia", "local", r"\bfreguesias?\b|^junta de "),
    ("cim_am", "local", r"comunidade intermunicipal|area metropolitana|associacao (transfronteirica )?de municipios|associacao intermunicipal|associacao de freguesias"),
    ("empresa_municipal", "local", r"\b(e m|e i m|e e m|e m s a|eim|eem)\b|empresa municipal|empresa intermunicipal|, ?sru\b|\bsru\b"),
    ("saude", "central", r"unidade local de saude|hospital|centro hospitalar|centro de saude|administracao regional de saude|\bars\b|instituto nacional de emergencia medica|servico nacional de saude"),
    ("universidade", "central", r"universidade|instituto politecnico|politecnico|instituto superior|escola superior|faculdade"),
    ("escola", "central", r"agrupamento|escola basica|escola secundaria|escola profissional|escola artistica|conservatorio"),
    ("tribunal_justica", "central", r"tribunal|^juizo |^juizos |^secretaria judicial|estabelecimento prisional|ministerio publico|procuradoria|conselho superior da magistratura|instituto dos registos|policia judiciaria|^direcao.geral de reinsercao"),
    ("seguranca_defesa", "central", r"guarda nacional republicana|policia de seguranca|\bpsp\b|\bgnr\b|exercito|marinha|forca aerea|forcas armadas|estado maior|autoridade nacional de emergencia|bombeiros|protecao civil|servico de informacoes"),
    ("regional", "regional", r"regiao autonoma|governo regional|assembleia legislativa regional|comissao de coordenacao e desenvolvimento regional|\bccdr\b|^(direcao|direccao) regional|^secretaria regional|^vice.presidencia do governo"),
    ("instituto_publico", "central", r"^instituto |^instituto$|^agencia |^autoridade |^entidade |^comissao |^conselho |^inspecao|^direcao.geral|^direccao.geral|^secretaria.geral|^gabinete |^fundo |^fundacao |^servico|^servicos |^banco de portugal|^caixa geral de depositos|^estrutura de missao|^laboratorio|^museu |^teatro nacional"),
    ("diplomacia", "central", r"^embaixada |^consulado |^missao permanente|^republica portuguesa|^arquivo distrital|^governo civil"),
    ("terceiro_setor", "terceiro_setor", r"centro social|centro paroquial|centro comunitario|casa do povo|^lar |\blar de\b|misericordia|montepio|\bipss\b|instituicao particular de solidariedade|associacao|cooperativa|^fundacao|sindicato|^clube |grupo desportivo|fabrica da igreja|paroquia|confraria|bombeiros voluntarios|santa casa|obra kolping|\bapacdm\b|\bappacdm\b|federacao|liga dos|ordem dos"),
    ("empresa_publica", "empresa_publica", r"\bepe\b|\be p e\b|\bs a\b.*(estado|publica|nacional)|infraestruturas de portugal|\bcp comboios|\bmetropolitano|\bcarris\b|\brtp\b|\bctt\b"),
    ("sociedade_adjudicante", "privado", r"\blda\b|\bl da\b|unipessoal|\bs a$|\bsa$|\bs a\b|\bace$|\bace\b|\bcrl\b|\bc r l\b"),
]
COMPILED = [(k, lvl, re.compile(rx)) for k, lvl, rx in RULES]


def classify(name):
    n = norm(name)
    for kind, level, rx in COMPILED:
        if rx.search(n):
            return kind, level
    return "outra_entidade", "outro"
