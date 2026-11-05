# Roadmap

Esta página mostra o que está a ser construído agora, o que vem a seguir e o que já foi feito. É atualizada à medida que o trabalho avança.

## Em curso
- **Intervenções: posições por deputado e partido.** Avaliar a posição expressa em cada intervenção, por deputado e partido (próximo passo dos discursos já ligados).
- **Indicadores do INE.** Séries estatísticas em `#/indicadores`, a concluir.
- **Reguladores independentes.** AdC, ANACOM, ERSE, ERC, ERS, AMT, CMVM, ASF, Banco de Portugal, CNPD e outros: missão, administração, orçamento, decisões e coimas, e a sua contratação. Primeira versão no ar (AdC, ERC, CNPD, AMT, administração, contratação); em falta: orçamento e coimas de ANACOM, ASF, BdP, CMVM, ERS.
- **Habitação.** Primeira versão no ar (`#/habitacao` e secção «Habitação» nos municípios): alojamento local do RNAL (111 942 registos ativos, por 100 alojamentos dos Censos 2021), preços de venda e rendas do INE, licenciamento, Censos 2021, PRR C02 (financia o 1.º Direito), contratação pública de habitação e ~350 leis/iniciativas. Falta: dados municipais do 1.º Direito/Porta de Entrada/ELH (IHRU só tem painel Power BI).
- **Quem decide — nomeações.** Já no ar: nomeações do Diário da República e resultados do CReSAP, com lista de nomeações e histórico de administrações. Em falta: despachos da série II (sem acesso utilizável) e os resultados do CReSAP são listas curtas, não nomeações finais.
- **Quem decide — declarações de interesses.** Leitura em lotes das declarações públicas de interesses dos titulares de cargos (só a parte pública; sem património, rendimentos nem familiares).
- **Auditorias de qualidade contínuas.** Cada módulo novo é verificado (números conferidos com os dados, ecrãs revistos, texto de privacidade) e os erros encontrados são corrigidos e registados.
- **Atualização automática dos dados.** Rotina diária leve (agenda, notícias, governo, deputados) e reconstrução semanal completa (contratos, entidades, estatísticas, módulos).

## A seguir
- **Próximos cinco itens do backlog.** (1) Freguesias: ligar ~1 350 freguesias ambíguas ao NIF com contexto de município e códigos INE/DICO, e fundir a freguesia com a respetiva junta. (2) Fracionamento de contratos: ajustes diretos repetidos ao mesmo fornecedor logo abaixo dos limiares. (3) Empresas por trás dos fornecedores: titulares e administradores, e cruzamento com titulares de cargos políticos (só fontes públicas). (4) Lobbying: registo a partir das audiências de grupos parlamentares com organizações nomeadas. (5) Petições, perguntas e requerimentos parlamentares, quando os dados da AR estiverem acessíveis.
- **Eleições:** resultados por concelho antes de 2005 e mapa por concelho.
- **Saúde: listas de espera e desempenho por hospital.** Os dados existem no Portal da Transparência do SNS, mas o seu robots.txt proíbe a recolha automática; depende de autorização do SPMS ou de uma decisão sobre como aceder.
- **Orçamento do Estado:** análises da UTAO.
- **Novas fontes verificadas:** preços de energia da ERSE, orçamentos municipais e finanças locais (DGAL) via dados.gov.pt, comparações Eurostat/INE.
- **Autarquias:** vereadores e pelouros.
- **Empresas do Estado:** contas por empresa, indemnizações compensatórias e administradores.
- **Sinais de risco:** justificações das exceções do art. 113.º e idade real das empresas.
- **Diário da República, série II:** despachos e nomeações; atualização diária incremental.
- **Parlamento:** votos nominais quando a Assembleia os publicar; acordo entre partidos e Governo ao longo do tempo.
- **Contratos:** padrões de repetição de vencedores e ligação aos anúncios de concurso.
- **Educação:** dados mais recentes de alunos e a hierarquia agrupamento → escola.
- **Alertas:** resumo diário do que mudou nas entidades, leis e temas que segue (e-mail ou RSS).
- **Exportações e API para análise com IA:** dicionário de dados completo e exportações regulares.
- **Qualidade e acessibilidade:** testes automáticos, revisão de acessibilidade, melhor experiência em telemóvel.

## Bloqueado
- **Financiamento partidário (ECFP).** Sem fonte legível por máquina: as contas e as subvenções são publicadas pela Entidade das Contas e Financiamentos Políticos em formatos que não permitem recolha fiável. Não está no ar.
- **Contas por empresa do Estado.** As demonstrações financeiras por empresa só existem como agregados em PDF; não há dados estruturados por empresa.

## Feito
- **Dívida pública (IGCP).** Stock mensal da dívida direta do Estado desde 2001, composição e prazo médio, em `#/divida` (f8f0088). O perfil de maturidades só existe como imagem.
- **Educação (DGEEC).** 48 indicadores oficiais em `#/dgeec` (8ad717f); sem ficheiros de alunos posteriores a 2020 e sem docentes municipais nem ensino superior.
- **Imigração.** Residentes estrangeiros por nacionalidade e região em `#/imigracao` (11c0240); a AMA só tem 3 instantâneos.
- **Intervenções parlamentares.** 12 914 discursos em plenário (XVII e XVI), 48,6 % ligados a iniciativas, a partir dos PDFs do DAR porque os dados abertos do parlamento.pt não estão acessíveis (a7f2c84, d965921).
- **Estado Aberto.** O portal passou a chamar-se Estado Aberto, com paleta e identidade visual renovadas.
- **Votações por partido.** Votos por partido e ciclo de vida das leis; em falta: legislaturas anteriores à XV.
- **Apoios públicos — DGARTES e ICA.** Mais PDFs lidos (DGARTES 2010 e 2017, parte dos PDFs do ICA); em falta: DGARTES 2011–2016 e 44 PDFs do ICA sem tabela.
- **Atos do Presidente na página de votações.** Bloco com os atos do Presidente associados às leis.
- **Auditorias do IGF às autarquias.** 282 relatórios de auditoria a autarquias locais (2010–2026), em `#/igf`.
- **Provedor de Justiça.** 45 relatórios anuais (1976–2025), em `#/provedor`. Os totais anuais de queixas estão parciais: nem todos os anos foram extraídos.
- **População das freguesias (Censos 2021 do INE).** 2 960 das 3 092 freguesias; as restantes 132 ficam sem valor por não haver correspondência fiável.
- **Justiça — correções.** Ligações aos documentos do Tribunal de Contas corrigidas e resultados de visto mantidos.
- **Empresas do Estado.** Ligações aos relatórios da ETF; não há contas publicadas por empresa.
- **Reguladores:** administração deduplicada.
- **Apoios públicos:** mais 28 beneficiários ligados por nome (1 817 no total).
- **Auditoria de qualidade n.º 6** concluída.
- **Novidades na página inicial.** Painel com o que mudou.
- **Apoios públicos à cultura, desporto, juventude e ciência.** Página «Apoios públicos»: ~32 mil apoios da DGARTES, ICA, IPDJ e FCT por beneficiário, programa e ano, concentração (quota dos 10 maiores) e secção nas páginas de entidade. Cobertura parcial indicada na página.
- **Atos do Presidente:** 1 184 promulgações, 15 vetos (2022–2026) com desfecho na Assembleia, 89 pedidos do Presidente ao Tribunal Constitucional (1983–2026), nomeações e decretos presidenciais; 97% das leis desde 2022 ligadas à iniciativa. Vetos anteriores a 2022 e a decretos do Governo sem fonte estruturada.
- **Eleições por freguesia.** Resultados por freguesia das legislativas 2024–2025 (3 092 freguesias) e das presidenciais 2026, 1.ª e 2.ª voltas (2 956), com tabela ordenável na página de cada concelho e secção «Como votou» nas páginas das freguesias (96,8 % das freguesias ligadas ao diretório). Em algumas uniões de freguesias o MAI publicou em 2026 os resultados das freguesias originais, que não são mostrados.
- **Justiça:** órgãos e tribunais do registo, estatísticas da DGPJ (via INE, duração média por comarca), 29 mil acórdãos do Tribunal Constitucional com resultado nos de fiscalização abstrata/preventiva, 4 100 documentos do Tribunal de Contas (recusas de visto, auditorias), dos quais cerca de 1 000 já ligados a entidades do registo, e a contratação dos tribunais e do Ministério da Justiça.
- **Segurança e proteção civil:** 26 organismos (PSP, GNR, PJ, AIMA, ANEPC, Forças Armadas…) com contratação, 661 corporações de bombeiros do registo (230 localizadas por concelho), e séries INE de crimes (2011–2025), incêndios rurais (2001–2025), sinistralidade (2014–2024) e bombeiros por concelho. Falta: RASI, ocorrências ANEPC e lista oficial de corporações (fontes inacessíveis).
- **Concursos e anúncios:** 242 mil anúncios de procedimento (2012–2026) ligados aos contratos (95%), prazos de propostas, concursos sem anúncio, anúncios sem contrato, preço base vs adjudicado e vencedores repetidos, por comprador e face a pares.
- **Contratos públicos:** 2,3 milhões de contratos desde 2012, com pesquisa, modificações aos contratos e ficha de cada contrato.
- **Diretório de entidades públicas:** cerca de 14 800 entidades (municípios, freguesias, escolas, hospitais, tribunais, institutos, empresas, terceiro setor…) com perfil, fornecedores, clientes e indicadores.
- **Autarquias:** os 308 municípios com contratação, população (Censos 2021), eleições 2017–2025, quem governa, despesa e dívida.
- **Autarquias — orçamento versus execução.** Orçamento corrigido face ao executado 2015–2019 (despesa e receita, por capítulo; a partir de 2020 a DGAL só publica a execução), prazo médio de pagamento trimestral 2019–2025, comparação por partido no poder (medianas, com n) e as 23 CIM/áreas metropolitanas com transferência do OE 2026 e contas somadas dos municípios membros.
- **Sinais de risco (versão 3):** indicadores explicáveis (fracionamento, preços junto ao teto legal, concorrência fraca, derrapagens, modificações que ultrapassam o teto, prazos de propostas abaixo do habitual, concursos sem anúncio), com os lotes de um concurso contados como um só procedimento, comparação com entidades do mesmo tipo e dimensão, e uma amostra de 100 casos para medir a precisão de cada sinal — sempre com a evidência e o aviso de que não são acusações.
- **Diário da República:** como cada lei nasceu, foi alterada e qual a forma em vigor.
- **Parlamento:** 230 deputados com presenças, comissões, iniciativas e relatorias; calendário; leis em curso; votações por partido e percurso completo das legislaturas XV, XVI e XVII (6 072 iniciativas, 7 628 votações, 322 leis ligadas ao Diário da República).
- **Governo e ministérios:** os 16 ministérios, quem os dirige, organismos tutelados, decisões do Conselho de Ministros e contratação.
- **Orçamento do Estado:** execução mensal versus orçamento desde 2009, receitas, despesa por categoria e ministério, Conta Geral do Estado por ministério (2014–2025) e série longa de saldo e dívida.
- **Fundos europeus e PRR:** 70 mil milhões € aprovados por beneficiário, programa e região.
- **Quem decide:** 12 503 titulares de cargos, gabinetes ministeriais e concursos de dirigentes.
- **O Estado em números:** 768 mil trabalhadores públicos, remunerações e empresas do Estado.
- **Empresas municipais:** 201 empresas locais do registo com município dono (por nome, heurística), contratação entre municípios e empresas, quota no total contratado de cada município e administradores publicados pela ET.
- **Saúde:** rede de ULS e hospitais, atividade hospitalar agregada e contratação do SNS.
- **Educação:** escolas, ensino superior, listas oficiais de docentes e Parque Escolar.
- **Eleições:** 50 eleições nacionais e regionais com resultados por território.
- **Regiões autónomas:** governos, assembleias, eleições e contratação dos Açores e da Madeira.
- **Seguir e pesquisar:** pesquisa global e lista pessoal de entidades, leis e temas com novidades.
