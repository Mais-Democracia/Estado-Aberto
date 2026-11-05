"""Curated directory of Portuguese public institutions. URLs are checked for reachability on every run."""
import concurrent.futures as cf
import urllib.request

from common import UA, db

# (id, name, category, branch, description, url)
I = [
 # Órgãos de soberania (CRP art. 110.º)
 ("pr", "Presidência da República", "Órgãos de soberania", "Presidente", "Chefe de Estado. Promulga ou veta leis, nomeia o Primeiro-Ministro, pode dissolver a Assembleia e é Comandante Supremo das Forças Armadas.", "https://www.presidencia.pt"),
 ("ce", "Conselho de Estado", "Órgãos de soberania", "Presidente", "Órgão político de consulta do Presidente da República (ex-Presidentes eleitos, Presidente da AR, PM, conselheiros designados e eleitos).", "https://www.presidencia.pt"),
 ("ar", "Assembleia da República", "Órgãos de soberania", "Parlamento", "Parlamento unicameral com 230 deputados. Aprova leis, o Orçamento do Estado e fiscaliza o Governo.", "https://www.parlamento.pt"),
 ("gov", "Governo da República", "Órgãos de soberania", "Governo", "Conduz a política geral do país e é o órgão superior da administração pública. Liderado pelo Primeiro-Ministro.", "https://www.portugal.gov.pt"),
 ("tc", "Tribunal Constitucional", "Tribunais", "Justiça", "13 juízes. Fiscaliza a constitucionalidade das leis, julga recursos eleitorais e a legalidade de partidos.", "https://www.tribunalconstitucional.pt"),
 ("stj", "Supremo Tribunal de Justiça", "Tribunais", "Justiça", "Topo da hierarquia dos tribunais judiciais (civil, penal, laboral).", "https://www.stj.pt"),
 ("sta", "Supremo Tribunal Administrativo", "Tribunais", "Justiça", "Topo dos tribunais administrativos e fiscais.", "https://www.stadministrativo.pt"),
 ("tcontas", "Tribunal de Contas", "Tribunais", "Justiça", "Fiscaliza a legalidade das despesas públicas e julga as contas do Estado.", "https://www.tcontas.pt"),
 ("csm", "Conselho Superior da Magistratura", "Tribunais", "Justiça", "Órgão de gestão e disciplina dos juízes dos tribunais judiciais.", "https://www.csm.org.pt"),
 ("cstaf", "Conselho Superior dos Tribunais Administrativos e Fiscais", "Tribunais", "Justiça", "Gestão e disciplina dos juízes dos tribunais administrativos e fiscais.", "https://www.cstaf.org.pt"),
 ("pgr", "Procuradoria-Geral da República / Ministério Público", "Tribunais", "Justiça", "Representa o Estado, exerce a ação penal e defende a legalidade democrática.", "https://www.ministeriopublico.pt"),
 ("csmp", "Conselho Superior do Ministério Público", "Tribunais", "Justiça", "Gestão e disciplina dos magistrados do Ministério Público.", "https://www.ministeriopublico.pt"),
 # Entidades independentes e reguladores
 ("provedor", "Provedor de Justiça", "Entidades independentes", "Fiscalização", "Defende os direitos dos cidadãos perante a administração pública. Eleito pela AR.", "https://www.provedor-jus.pt"),
 ("cne", "Comissão Nacional de Eleições", "Entidades independentes", "Fiscalização", "Garante a regularidade dos atos eleitorais e a igualdade entre candidaturas.", "https://www.cne.pt"),
 ("cnpd", "Comissão Nacional de Proteção de Dados", "Entidades independentes", "Fiscalização", "Autoridade nacional de proteção de dados pessoais (RGPD).", "https://www.cnpd.pt"),
 ("erc", "Entidade Reguladora para a Comunicação Social", "Entidades independentes", "Reguladores", "Regula os meios de comunicação social e garante o pluralismo.", "https://www.erc.pt"),
 ("edt", "Entidade para a Transparência", "Entidades independentes", "Fiscalização", "Fiscaliza declarações de rendimentos e interesses de titulares de cargos políticos.", "https://www.tribunalconstitucional.pt"),
 ("menac", "Mecanismo Nacional Anticorrupção", "Entidades independentes", "Fiscalização", "Promove a transparência e a integridade na ação pública e previne a corrupção.", "https://www.mec-anticorrupcao.pt"),
 ("bdp", "Banco de Portugal", "Entidades independentes", "Reguladores", "Banco central nacional (integrado no Eurosistema); supervisiona a banca.", "https://www.bportugal.pt"),
 ("cmvm", "Comissão do Mercado de Valores Mobiliários", "Entidades independentes", "Reguladores", "Supervisiona mercados de capitais e valores mobiliários.", "https://www.cmvm.pt"),
 ("asf", "Autoridade de Supervisão de Seguros e Fundos de Pensões", "Entidades independentes", "Reguladores", "Regula e supervisiona seguros e fundos de pensões.", "https://www.asf.com.pt"),
 ("adc", "Autoridade da Concorrência", "Entidades independentes", "Reguladores", "Promove e defende a concorrência em Portugal.", "https://www.concorrencia.pt"),
 ("anacom", "ANACOM", "Entidades independentes", "Reguladores", "Regulador das comunicações (telecomunicações, correios).", "https://www.anacom.pt"),
 ("erse", "ERSE", "Entidades independentes", "Reguladores", "Regulador dos setores da eletricidade e do gás.", "https://www.erse.pt"),
 ("ers", "Entidade Reguladora da Saúde", "Entidades independentes", "Reguladores", "Regula prestadores de cuidados de saúde públicos e privados.", "https://www.ers.pt"),
 ("amt", "Autoridade da Mobilidade e dos Transportes", "Entidades independentes", "Reguladores", "Regula transportes e infraestruturas de mobilidade.", "https://www.amt-autoridade.pt"),
 ("ces", "Conselho Económico e Social", "Entidades independentes", "Consulta", "Concertação social entre Governo, sindicatos e patronato.", "https://www.ces.pt"),
 # Estado / administração
 ("ine", "Instituto Nacional de Estatística", "Administração do Estado", "Governo", "Produz as estatísticas oficiais.", "https://www.ine.pt"),
 ("dre", "Diário da República", "Administração do Estado", "Governo", "Jornal oficial: publicação obrigatória de leis, decretos e outros atos.", "https://diariodarepublica.pt"),
 ("at", "Autoridade Tributária e Aduaneira", "Administração do Estado", "Governo", "Administração fiscal e aduaneira (Portal das Finanças).", "https://www.portaldasfinancas.gov.pt"),
 ("ss", "Segurança Social", "Administração do Estado", "Governo", "Sistema público de pensões e prestações sociais.", "https://www.seg-social.pt"),
 ("sns", "Serviço Nacional de Saúde", "Administração do Estado", "Governo", "Sistema público de saúde universal.", "https://www.sns.gov.pt"),
 ("aima", "AIMA – Agência para a Integração, Migrações e Asilo", "Administração do Estado", "Governo", "Gestão de imigração, autorizações de residência e asilo.", "https://aima.gov.pt"),
 ("emgfa", "Estado-Maior-General das Forças Armadas", "Segurança e defesa", "Governo", "Comando operacional das Forças Armadas (Exército, Marinha, Força Aérea).", "https://www.emgfa.pt"),
 ("psp", "Polícia de Segurança Pública", "Segurança e defesa", "Governo", "Força de segurança urbana.", "https://www.psp.pt"),
 ("gnr", "Guarda Nacional Republicana", "Segurança e defesa", "Governo", "Força de segurança de natureza militar (zonas rurais e trânsito).", "https://www.gnr.pt"),
 ("pj", "Polícia Judiciária", "Segurança e defesa", "Governo", "Polícia de investigação criminal, sob direção do Ministério Público.", "https://www.pj.pt"),
 # Regiões autónomas e poder local
 ("alram", "Assembleia Legislativa da Região Autónoma da Madeira", "Regiões autónomas", "Regiões", "Parlamento regional da Madeira.", "https://www.alram.pt"),
 ("grm", "Governo Regional da Madeira", "Regiões autónomas", "Regiões", "Executivo da Região Autónoma da Madeira.", "https://www.madeira.gov.pt"),
 ("alra", "Assembleia Legislativa da Região Autónoma dos Açores", "Regiões autónomas", "Regiões", "Parlamento regional dos Açores.", "https://www.alra.pt"),
 ("gra", "Governo Regional dos Açores", "Regiões autónomas", "Regiões", "Executivo da Região Autónoma dos Açores.", "https://portal.azores.gov.pt"),
 ("anmp", "Associação Nacional de Municípios Portugueses", "Poder local", "Autarquias", "Representa os 308 municípios.", "https://www.anmp.pt"),
 ("anafre", "Associação Nacional de Freguesias", "Poder local", "Autarquias", "Representa as freguesias.", "https://www.anafre.pt"),
]


def reachable(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Firefox/130.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return 1 if r.status < 400 else 0
    except Exception:
        return 0


def main():
    con = db()
    with cf.ThreadPoolExecutor(12) as ex:
        ok = list(ex.map(lambda r: reachable(r[5]), I))
    con.execute("DELETE FROM institutions")
    for row, r in zip(I, ok):
        con.execute("INSERT INTO institutions VALUES (?,?,?,?,?,?,?)", (*row, r))
    con.commit()
    print(f"institutions: {len(I)} ({sum(ok)} reachable)")
    for row, r in zip(I, ok):
        if not r:
            print("  unreachable:", row[1], row[5])


if __name__ == "__main__":
    main()
