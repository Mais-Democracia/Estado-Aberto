#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import math
import os
import random
import re
import sqlite3
import sys

SCHEMAS = json.loads(r'''{"politica":{"events":"id INTEGER PRIMARY KEY, title TEXT, start TEXT, end TEXT, section TEXT, theme TEXT, subtitle TEXT, local TEXT, text TEXT, source TEXT","initiatives":"key TEXT PRIMARY KEY, kind TEXT, number INTEGER, legislature TEXT, session INTEGER, origin TEXT, title TEXT, source TEXT","initiative_steps":"initiative_key TEXT, event_id INTEGER, date TEXT, phase TEXT, body TEXT, detail TEXT, relator TEXT, source TEXT, UNIQUE (initiative_key, event_id, phase)","laws":"id TEXT PRIMARY KEY, number TEXT, title TEXT, kind TEXT, published TEXT, url TEXT, summary TEXT","law_versions":"law_id TEXT, version_date TEXT, amended_by TEXT, description TEXT, url TEXT","votes":"initiative_key TEXT, date TEXT, result TEXT, favor TEXT, against TEXT, abstention TEXT, detail_json TEXT","parties":"code TEXT PRIMARY KEY, name TEXT, seats INTEGER, bloc TEXT, color TEXT, ideology TEXT, website TEXT","people":"id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, role TEXT, body TEXT, party TEXT, since TEXT, source TEXT","institutions":"id TEXT PRIMARY KEY, name TEXT, category TEXT, branch TEXT, description TEXT, url TEXT, reachable INTEGER","news":"url TEXT PRIMARY KEY, body TEXT, title TEXT, date TEXT, source TEXT","entities":"id INTEGER PRIMARY KEY AUTOINCREMENT, nif TEXT UNIQUE, name TEXT NOT NULL, kind TEXT, level TEXT, is_public INTEGER DEFAULT 0, parent_id INTEGER, ministry TEXT, wikidata TEXT, website TEXT, description TEXT, region TEXT, district TEXT, municipality TEXT, dico TEXT, population INTEGER, lat REAL, lon REAL, buyer_contracts INTEGER DEFAULT 0, buyer_value REAL DEFAULT 0, seller_contracts INTEGER DEFAULT 0, seller_value REAL DEFAULT 0, sources TEXT","contracts":"id TEXT PRIMARY KEY, year INTEGER, signed TEXT, published TEXT, decision TEXT, object TEXT, types TEXT, procedure TEXT, price REAL, base_price REAL, effective_price REAL, cpv TEXT, cpv_code TEXT, location TEXT, duration_days INTEGER, n_bidders INTEGER, framework TEXT, centralised TEXT, direct_basis TEXT, legal_basis TEXT, criterion TEXT, announcement TEXT, link TEXT, buyer_nif TEXT, buyer_name TEXT, seller_nif TEXT, seller_name TEXT, n_sellers INTEGER","contract_parties":"contract_id TEXT, nif TEXT, name TEXT, role TEXT","meta":"key TEXT PRIMARY KEY, value TEXT"},"anuncios":{"announcements":"id INTEGER PRIMARY KEY, n_anuncio TEXT, id_incm TEXT, year INTEGER, published TEXT, buyer_nif TEXT, buyer_name TEXT, buyer_kind TEXT, buyer_entity_id INTEGER, location TEXT, tipo_acto TEXT, procedure TEXT, contract_types TEXT, base_price REAL, prazo_dias INTEGER, deadline TEXT, cpv_code TEXT, cpv_desc TEXT, description TEXT, n_lotes INTEGER, url TEXT, source_url TEXT, is_primary INTEGER, is_tender INTEGER, n_amend INTEGER DEFAULT 0, n_contracts INTEGER DEFAULT 0, contract_value REAL, first_contract_id TEXT, unfollowed INTEGER DEFAULT 0, ok_deadline INTEGER DEFAULT 0, obras INTEGER DEFAULT 0, post2018 INTEGER DEFAULT 0, short INTEGER DEFAULT 0","contract_links":"contract_id TEXT PRIMARY KEY, announcement_id INTEGER, buyer_nif TEXT, procedure TEXT, signed TEXT, price REAL, base_price REAL, n_bidders INTEGER, seller_nif TEXT, seller_name TEXT, at_base INTEGER, discount REAL","contracts_no_ann":"contract_id TEXT PRIMARY KEY, buyer_nif TEXT, buyer_name TEXT, buyer_kind TEXT, procedure TEXT, signed TEXT, price REAL, n_bidders INTEGER, announcement_ref TEXT, reason TEXT, seller_nif TEXT, seller_name TEXT, object TEXT","buyer_stats":"nif TEXT PRIMARY KEY, name TEXT, entity_id INTEGER, kind TEXT, n_ann INTEGER, n_tender INTEGER, n_followed INTEGER, n_unfollowed INTEGER, n_eligible_unf INTEGER, base_total REAL, n_dl INTEGER, dl_median REAL, dl_short INTEGER, n_comp INTEGER, n_noann INTEGER, n_at_base INTEGER, n_base_cmp INTEGER, first_pub TEXT, last_pub TEXT","flags":"kind TEXT, nif TEXT, name TEXT, ekind TEXT, n INTEGER, k INTEGER, rate REAL, peer_rate REAL, peer_p90 REAL, nat_rate REAL, z REAL, rank INTEGER, evidence TEXT","meta":"key TEXT PRIMARY KEY, value TEXT","source_files":"year INTEGER, title TEXT, url TEXT, filesize INTEGER, n_records INTEGER"},"apoios":{"apoios":"id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT, orgao TEXT, programa TEXT, familia TEXT, detalhe TEXT, year INTEGER, nif TEXT, nome TEXT, nome_norm TEXT, pessoa_singular INTEGER DEFAULT 0, amount REAL, status TEXT, data_decisao TEXT, regiao TEXT, source_url TEXT NOT NULL, src_key TEXT, ent_nif TEXT, match TEXT, bkey TEXT","ben":"bkey TEXT PRIMARY KEY, nif TEXT, ent_nif TEXT, nome TEXT, match TEXT, pessoa_singular INTEGER, n INTEGER, total REAL, areas TEXT, orgaos TEXT, primeiro INTEGER, ultimo INTEGER, fundos_overlap REAL","sources":"orgao TEXT, name TEXT, url TEXT, year INTEGER, rows INTEGER, total REAL, status TEXT, note TEXT","meta":"key TEXT PRIMARY KEY, value TEXT","partial":"area TEXT, orgao TEXT, year INTEGER, kind TEXT, note TEXT, short TEXT"},"autarquias":{"municipios":"dico TEXT PRIMARY KEY, name TEXT, district TEXT, nif TEXT, entity_nif TEXT, wikidata TEXT, population INTEGER, population_year TEXT, population_source TEXT, population_est_2023 INTEGER, mai25_id INTEGER, match_method TEXT, source_url TEXT, nuts3 TEXT","freguesias":"mai25_id INTEGER PRIMARY KEY, dico TEXT, name TEXT, entity_nif TEXT, match_method TEXT, source_url TEXT, name_key TEXT","election_summary":"level TEXT, code TEXT, year INTEGER, organ TEXT, registered INTEGER, voters INTEGER, turnout REAL, blank INTEGER, null_votes INTEGER, total_mandates INTEGER, source_url TEXT, PRIMARY KEY (level, code, year, organ)","election_results":"level TEXT, code TEXT, year INTEGER, organ TEXT, party TEXT, party_type TEXT, list_name TEXT, votes INTEGER, pct REAL, mandates INTEGER, president INTEGER, source_url TEXT","mandates":"dico TEXT, year INTEGER, organ TEXT, role TEXT, name TEXT, party TEXT, list_name TEXT, party_type TEXT, list_mandates INTEGER, elected INTEGER, source_url TEXT","finance":"dico TEXT, nif TEXT, year INTEGER, kind TEXT, code TEXT, label TEXT, value REAL, source_url TEXT, PRIMARY KEY (dico, year, kind, code)","debt":"dico TEXT, year INTEGER, debt_limit REAL, debt_total REAL, debt_excluded REAL, fam REAL, debt_for_limit REAL, source_url TEXT, PRIMARY KEY (dico, year)","metrics":"dico TEXT PRIMARY KEY, name TEXT, district TEXT, nif TEXT, entity_nif TEXT, wikidata TEXT, population INTEGER, population_year TEXT, population_source TEXT, mayor TEXT, party TEXT, party_family TEXT, party_type TEXT, list_name TEXT, party_2021 TEXT, party_2017 TEXT, changed_2025 INTEGER, winner_pct REAL, majority INTEGER, cm_mandates INTEGER, turnout_2025 REAL, fin_year INTEGER, expense REAL, revenue REAL, personnel REAL, goods_services REAL, capital_invest REAL, transfers_out REAL, interest REAL, taxes REAL, transfers_in REAL, balance REAL, expense_pc REAL, personnel_pct REAL, invest_pct REAL, own_revenue_pct REAL, debt_year INTEGER, debt REAL, debt_limit REAL, debt_pct_limit REAL, debt_pc REAL, rank_expense_pc INTEGER, rank_debt_pc INTEGER, rank_personnel_pct INTEGER, rank_invest_pct INTEGER, n_ranked INTEGER, pmp_date TEXT, pmp_days INTEGER, budget_year INTEGER, budget_exec_pct REAL, nuts3 TEXT","budget":"dico TEXT, year INTEGER, kind TEXT, stage TEXT, code TEXT, label TEXT, value REAL, source_url TEXT, PRIMARY KEY (dico, year, kind, stage, code)","pmp":"dico TEXT, date TEXT, days INTEGER, partial INTEGER, source_url TEXT, PRIMARY KEY (dico, date)","cim":"nuts3 TEXT PRIMARY KEY, name TEXT, entity_nif TEXT, transfer_oe2026 REAL, n_municipios INTEGER, population INTEGER, expense REAL, debt REAL, fin_year INTEGER, debt_year INTEGER, source_url TEXT, nuts_source_url TEXT","meta":"key TEXT PRIMARY KEY, value TEXT"},"deputados":{"deputados":"bid INTEGER PRIMARY KEY, name TEXT, full_name TEXT, party TEXT, circle TEXT, birth_date TEXT, profession TEXT, qualifications TEXT, positions TEXT, legislature TEXT, in_office INTEGER DEFAULT 1, source_url TEXT, fetched_at TEXT","committees":"bid INTEGER, committee TEXT, role TEXT, source_url TEXT","authored":"bid INTEGER, tipo TEXT, numero TEXT, sessao TEXT, titulo TEXT, truncated INTEGER DEFAULT 0, source_url TEXT, UNIQUE (bid, tipo, numero)","attendance":"bid INTEGER, date TEXT, meeting_no INTEGER, session INTEGER, kind TEXT, status TEXT, code TEXT, source_url TEXT, UNIQUE (bid, date, meeting_no, session)","mandate_changes":"date TEXT, leaves TEXT, enters TEXT, circle TEXT, party TEXT, reason TEXT, raw TEXT, source_url TEXT, UNIQUE (date, leaves, enters, reason)","votes":"bid INTEGER, initiative TEXT, date TEXT, vote TEXT, source_url TEXT","meta":"key TEXT PRIMARY KEY, value TEXT","ar_deputado":"cad_id INTEGER PRIMARY KEY, nome_completo TEXT, nome_parlamentar TEXT, gp_sigla TEXT, circulo TEXT, partido TEXT, legislatura TEXT, mandatos_json TEXT, source_url TEXT","ar_iniciativa":"ini_id INTEGER PRIMARY KEY, nr TEXT, leg TEXT, tipo TEXT, titulo TEXT, autores_json TEXT, eventos_json TEXT, source_url TEXT","ar_votacao":"ini_id INTEGER, fase TEXT, data TEXT, resultado TEXT, detalhe TEXT, source_url TEXT","ar_orgao":"cad_id INTEGER, orgao TEXT, cargo TEXT, legislatura TEXT, source_url TEXT"},"dgeec":{"meta":"key TEXT PRIMARY KEY, value TEXT","indicators":"indicator TEXT, title TEXT, grp TEXT, series TEXT, year TEXT, value REAL, source_url TEXT","mun_students":"dico TEXT, municipality TEXT, level TEXT, year TEXT, students INTEGER, schools INTEGER, source_url TEXT","national_check":"level TEXT, year TEXT, students INTEGER, source_url TEXT","unmatched":"municipality TEXT, level TEXT, students INTEGER"},"divida":{"meta":"key TEXT PRIMARY KEY, value TEXT","series":"code TEXT, label TEXT, date TEXT, value REAL, PRIMARY KEY (code, date)","series_meta":"code TEXT PRIMARY KEY, label TEXT, unit TEXT, grp TEXT"},"dre":{"acts":"id TEXT PRIMARY KEY, kind TEXT, number TEXT, year INTEGER, date TEXT, title TEXT, issuer TEXT, proponent TEXT, summary TEXT, summary_html TEXT, vigencia TEXT, eli TEXT, pdf_url TEXT, dr_title TEXT, dr_url TEXT, url TEXT, in_window INTEGER DEFAULT 1, detail_at TEXT, text TEXT, approved TEXT, promulgated TEXT, signatories TEXT, government TEXT, legislature TEXT, frag_id TEXT, has_consolidated INTEGER, has_parliament INTEGER, menu_at TEXT, cons_eli TEXT, cons_title TEXT, cons_url TEXT, cons_at TEXT, n_amendments INTEGER, republishes INTEGER DEFAULT 0, source_url TEXT","days":"date TEXT PRIMARY KEY, n INTEGER, diarios TEXT, fetched_at TEXT, source_url TEXT","links":"src_id TEXT, dst_id TEXT, relation TEXT, dst_label TEXT, origin TEXT, source_url TEXT, UNIQUE(src_id, dst_id, relation, origin)","amendments":"target_id TEXT, amending_id TEXT, amending_kind TEXT, amending_number TEXT, amending_title TEXT, date TEXT, summary TEXT, n_changes INTEGER, changes_json TEXT, url TEXT, source_url TEXT, UNIQUE(target_id, amending_id)","rectifications":"act_id TEXT, rect_id TEXT, label TEXT, url TEXT, source_url TEXT, UNIQUE(act_id, rect_id)","act_initiatives":"act_id TEXT, initiative_key TEXT, method TEXT, score REAL, evidence TEXT, UNIQUE(act_id, initiative_key)","meta":"key TEXT PRIMARY KEY, value TEXT"},"educacao":{"units":"code TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, nature TEXT, subsystem TEXT, municipality TEXT, district TEXT, website TEXT, wikidata TEXT, students INTEGER, students_year TEXT, students_json TEXT, vagas_2026 INTEGER, n_courses INTEGER, nif TEXT, entity_id INTEGER, match_how TEXT, norm TEXT, sources TEXT, source_url TEXT","schools":"code TEXT PRIMARY KEY, name TEXT, municipality TEXT, levels TEXT, students INTEGER, students_year TEXT, students_json TEXT, unit_code TEXT, source_url TEXT, norm TEXT","teacher_lists":"id INTEGER PRIMARY KEY AUTOINCREMENT, page_url TEXT, page_title TEXT, pub_date TEXT, family TEXT, school_year TEXT, group_code TEXT, group_name TEXT, pdf_url TEXT UNIQUE, pdf_label TEXT, kind TEXT, n_rows INTEGER, parsed INTEGER DEFAULT 0","teacher_entries":"id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER, sublist TEXT, ordem INTEGER, name TEXT, name_norm TEXT, tipo TEXT, graduacao REAL, situacao TEXT, provimento TEXT, placed_code TEXT, placed_name TEXT","teacher_stats":"indicator TEXT, title TEXT, grp TEXT, series TEXT, year TEXT, value REAL, source_url TEXT","pe_schools":"id TEXT PRIMARY KEY, name TEXT, phase TEXT, district TEXT, architect TEXT, address TEXT, postcode TEXT, lat REAL, lon REAL, summary TEXT, completed TEXT, indicators_json TEXT, unit_code TEXT, source_url TEXT","pe_docs":"title TEXT, category TEXT, year TEXT, url TEXT UNIQUE","pe_totals":"label TEXT, value INTEGER, source_url TEXT","meta":"key TEXT PRIMARY KEY, value TEXT"},"eleicoes":{"elections":"id TEXT PRIMARY KEY, type TEXT, year INTEGER, round INTEGER, date TEXT, name TEXT, scope TEXT, levels TEXT, note TEXT, source_url TEXT","territories":"election_id TEXT, level TEXT, code TEXT, name TEXT, parent TEXT, PRIMARY KEY (election_id, level, code)","summary":"election_id TEXT, level TEXT, code TEXT, registered INTEGER, voters INTEGER, turnout REAL, abstention_pct REAL, blank INTEGER, blank_pct REAL, null_votes INTEGER, null_pct REAL, mandates INTEGER, source_url TEXT, PRIMARY KEY (election_id, level, code)","results":"election_id TEXT, level TEXT, code TEXT, party TEXT, family TEXT, votes INTEGER, pct REAL, valid_pct REAL, mandates INTEGER, source_url TEXT","freguesias":"code TEXT PRIMARY KEY, dico TEXT, name TEXT, name_key TEXT, entity_id INTEGER, match_method TEXT","municipios":"dico TEXT PRIMARY KEY, name TEXT, district TEXT, nif TEXT, entity_id INTEGER","meta":"key TEXT PRIMARY KEY, value TEXT"},"empresas_locais":{"meta":"key TEXT PRIMARY KEY, value TEXT","company":"id INTEGER PRIMARY KEY, nif TEXT UNIQUE, name TEXT, entity_id INTEGER, registry_kind TEXT, legal_form TEXT, scope TEXT, sector TEXT, status TEXT, status_note TEXT, buyer_contracts INTEGER, buyer_value REAL, seller_contracts INTEGER, seller_value REAL, first_signed TEXT, last_signed TEXT, seller_to_owner_contracts INTEGER, seller_to_owner_value REAL, excluded_to_owner_contracts INTEGER, excluded_to_owner_value REAL, n_admins INTEGER, owner_method TEXT, source_url TEXT","owner":"company_id INTEGER, dico TEXT, municipality TEXT, pct REAL, method TEXT, confidence TEXT, evidence TEXT, PRIMARY KEY (company_id, dico)","admin":"company_id INTEGER, holder TEXT, role TEXT, board TEXT, begin_date TEXT, end_date TEXT, match_method TEXT, source_url TEXT","company_year":"company_id INTEGER, year INTEGER, role TEXT, n INTEGER, value REAL, PRIMARY KEY (company_id, year, role)","muni":"dico TEXT PRIMARY KEY, name TEXT, nif TEXT, n_companies INTEGER, n_companies_certain INTEGER, companies_seller_value REAL, companies_seller_contracts INTEGER, muni_buyer_contracts INTEGER, muni_buyer_value REAL, muni_to_companies_contracts INTEGER, muni_to_companies_value REAL, share_pct REAL, excluded_contracts INTEGER, excluded_value REAL","sel_muni":"dico TEXT, year INTEGER, n_entities INTEGER, employees INTEGER, financial_result REAL, total_debt REAL, source_url TEXT, PRIMARY KEY (dico, year)"},"estado_empresas":{"meta":"key TEXT PRIMARY KEY, value TEXT","wf_total":"ref_date TEXT, year INTEGER, employed_total INTEGER, public_workers INTEGER, note TEXT, unit TEXT, source_url TEXT","wf_pay":"ref_date TEXT, year INTEGER, base_monthly REAL, gain_monthly REAL, unit TEXT, source_url TEXT","wf_pay_career":"ref_date TEXT, year INTEGER, area TEXT, career_code TEXT, career TEXT, detail_code TEXT, detail TEXT, base_monthly REAL, gain_monthly REAL, unit TEXT, source_url TEXT","wf_contract":"ref_date TEXT, year INTEGER, code TEXT, label TEXT, workers INTEGER, unit TEXT, source_url TEXT","wf_subsector":"ref_date TEXT, year INTEGER, subsector_code TEXT, subsector TEXT, area TEXT, workers INTEGER, unit TEXT, source_url TEXT","wf_activity":"ref_date TEXT, year INTEGER, cae TEXT, label TEXT, grp TEXT, subgroup TEXT, workers INTEGER, unit TEXT, source_url TEXT","wf_career":"ref_date TEXT, year INTEGER, area TEXT, career_code TEXT, career TEXT, detail_code TEXT, detail TEXT, age_code TEXT, age TEXT, sex TEXT, workers INTEGER, unit TEXT, source_url TEXT","wf_education":"ref_date TEXT, year INTEGER, grp TEXT, level_code TEXT, level TEXT, sex TEXT, workers INTEGER, unit TEXT, source_url TEXT","wf_disability":"ref_date TEXT, year INTEGER, sex TEXT, workers INTEGER, unit TEXT, source_url TEXT","wf_flows":"ref_date TEXT, year INTEGER, subsector_code TEXT, subsector TEXT, area TEXT, flow TEXT, motive TEXT, workers INTEGER, unit TEXT, source_url TEXT","wf_entities":"ref_date TEXT, year INTEGER, subsector_code TEXT, subsector TEXT, n_entities INTEGER, unit TEXT, source_url TEXT","sector_emp":"ref_date TEXT, year INTEGER, holder TEXT, sub TEXT, sex TEXT, workers INTEGER, unit TEXT, source_url TEXT","see_docs":"kind TEXT, year INTEGER, quarter INTEGER, title TEXT, url TEXT, per_company INTEGER DEFAULT 0","see_agg":"year INTEGER, quarter INTEGER, grp TEXT, indicator TEXT, value REAL, restated REAL, unit TEXT, n_companies INTEGER, source_url TEXT","misc_series":"indicator TEXT, year INTEGER, value REAL, unit TEXT, source_url TEXT","companies":"id INTEGER PRIMARY KEY, key TEXT, name TEXT, nif TEXT, entity_id INTEGER, entity_name TEXT, match_method TEXT, match_score REAL, grp TEXT, section TEXT, epr INTEGER, portfolio TEXT, pct REAL, nominal REAL, capital REAL, ref_date TEXT, year INTEGER, in_siee INTEGER DEFAULT 0, status TEXT, unit TEXT, source_url TEXT","company_hist":"company_id INTEGER, ref_date TEXT, year INTEGER, pct REAL, nominal REAL, capital REAL, unit TEXT, source_url TEXT"},"fundos":{"awards":"id INTEGER PRIMARY KEY, fw TEXT, code TEXT, role TEXT, counts INTEGER, nif TEXT, name TEXT, entity_id INTEGER, match TEXT, tipo TEXT, programa TEXT, fundo TEXT, ano INTEGER, titulo TEXT, estado TEXT, concelho TEXT, regiao TEXT, aprovado REAL, pago REAL, custo REAL, source_url TEXT","locs":"fw TEXT, code TEXT, regiao TEXT, distrito TEXT, concelho TEXT, pct REAL, aprovado REAL, pago REAL","prr_contracts":"code TEXT, title TEXT, signed TEXT, contratado REAL, subvencao REAL, emprestimo REAL, transferido REAL, pago REAL, investimento TEXT, nif TEXT, name TEXT, entity_id INTEGER, estado TEXT, source_url TEXT","prr_interm":"nif TEXT, name TEXT, entity_id INTEGER, n INTEGER, contratado REAL, pago REAL","agg":"dim TEXT, key TEXT, key2 TEXT, n INTEGER, aprovado REAL, pago REAL","ent_totals":"nif TEXT PRIMARY KEY, entity_id INTEGER, name TEXT, tipo TEXT, n INTEGER, aprovado REAL, pago REAL","conc_totals":"concelho TEXT, tipo TEXT, n INTEGER, aprovado REAL, pago REAL","meta":"key TEXT PRIMARY KEY, value TEXT"},"habitacao":{"meta":"key TEXT PRIMARY KEY, value TEXT","ine_series":"indicator TEXT, label TEXT, family TEXT, unit TEXT, geo_code TEXT, geo_name TEXT, level TEXT, dico TEXT, dim TEXT, period TEXT, year INTEGER, q INTEGER, value REAL, flag TEXT, source_url TEXT","al_conc":"dico TEXT PRIMARY KEY, concelho TEXT, n INTEGER, utentes INTEGER, first_reg TEXT, last_reg TEXT, snapshot TEXT, period TEXT, unit TEXT, source_url TEXT","al_freg":"dicofre TEXT PRIMARY KEY, dico TEXT, freguesia TEXT, n INTEGER, utentes INTEGER, snapshot TEXT, source_url TEXT","al_ano":"dico TEXT, year INTEGER, n INTEGER, utentes INTEGER, cum_n INTEGER, cum_utentes INTEGER, period TEXT, unit TEXT, source_url TEXT, PRIMARY KEY (dico, year)","al_mes":"month TEXT PRIMARY KEY, n INTEGER, source_url TEXT","al_modal":"dico TEXT, modalidade TEXT, n INTEGER, utentes INTEGER, source_url TEXT, PRIMARY KEY (dico, modalidade)","al_dens":"dico TEXT PRIMARY KEY, name TEXT, n INTEGER, utentes INTEGER, alojamentos INTEGER, residencia_habitual INTEGER, per100_alojamentos REAL, per100_residencia_habitual REAL, population INTEGER, utentes_per100_hab REAL, period TEXT, source_url TEXT","prr_hab":"dico TEXT, code TEXT, label TEXT, n INTEGER, fogos INTEGER, fogos_titles INTEGER, aprovado REAL, pago REAL, period TEXT, unit TEXT, source_url TEXT, PRIMARY KEY (dico, code)","prr_hab_nat":"code TEXT PRIMARY KEY, label TEXT, n INTEGER, fogos INTEGER, aprovado REAL, pago REAL, n_sem_concelho INTEGER, aprovado_sem_concelho REAL, source_url TEXT","hab_empresas":"nif TEXT PRIMARY KEY, name TEXT, dico TEXT, method TEXT, entity_id INTEGER, n INTEGER, value REAL, source_url TEXT","contr_agg":"dico TEXT, lens TEXT, buyer_type TEXT, grp TEXT, year INTEGER, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL, unit TEXT, source_url TEXT","contr_top":"dico TEXT, lens TEXT, id TEXT, signed TEXT, object TEXT, price REAL, buyer_type TEXT, buyer_nif TEXT, buyer_name TEXT, seller_nif TEXT, seller_name TEXT, grp TEXT, procedure TEXT, source_url TEXT","ihru_year":"year INTEGER PRIMARY KEY, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL, source_url TEXT","ihru_top":"seller_nif TEXT, seller_name TEXT, entity_id INTEGER, n INTEGER, value REAL, source_url TEXT","leis":"ref TEXT PRIMARY KEY, src TEXT, kind TEXT, number TEXT, title TEXT, date TEXT, leg TEXT, autoria TEXT, estado TEXT, resultado TEXT, lei_ref TEXT, dre_id TEXT, tema TEXT, source_url TEXT","leis_votos":"ref TEXT, data TEXT, fase TEXT, orgao TEXT, resultado TEXT, favor TEXT, contra TEXT, abstencao TEXT, source_url TEXT","fontes":"id TEXT PRIMARY KEY, name TEXT, url TEXT, licence TEXT, period TEXT, status TEXT, note TEXT"},"igf":{"meta":"key TEXT PRIMARY KEY, value TEXT","reports":"code TEXT PRIMARY KEY, year INTEGER, num INTEGER, title TEXT, subject TEXT, kind TEXT, report_url TEXT, n_docs INTEGER, match_kind TEXT, entity_nif TEXT, entity_name TEXT, source_url TEXT","docs":"code TEXT, label TEXT, filename TEXT, url TEXT, PRIMARY KEY (code, url)"},"imigracao":{"meta":"key TEXT PRIMARY KEY, value TEXT","series":"ds TEXT, year INTEGER, level TEXT, geo_code TEXT, geo_name TEXT, dico TEXT, nat_code TEXT, nat_name TEXT, sex TEXT, value INTEGER, indicator TEXT, source_url TEXT","datasets":"ds TEXT PRIMARY KEY, indicator TEXT, label TEXT, title TEXT, first_year INTEGER, last_year INTEGER, updated TEXT, rows INTEGER, source_url TEXT, api_url TEXT","ama_pedidos":"resource TEXT PRIMARY KEY, period TEXT, scope TEXT, value INTEGER, published TEXT, source_url TEXT"},"ine_series":{"meta":"key TEXT PRIMARY KEY, value TEXT","indicador":"key TEXT PRIMARY KEY, theme TEXT, label TEXT, unit TEXT, ids TEXT, description TEXT, first_year INTEGER, last_year INTEGER, n_municipios INTEGER, source_url TEXT, updated TEXT","obs":"ind TEXT, dico TEXT, year INTEGER, value REAL, varcd TEXT, source_url TEXT, PRIMARY KEY (ind, dico, year)","nacional":"ind TEXT, year INTEGER, median REAL, mean REAL, n INTEGER, ine_pt REAL, PRIMARY KEY (ind, year)"},"intervencoes":{"reunioes":"key TEXT PRIMARY KEY, leg TEXT, sessao INTEGER, numero INTEGER, data TEXT, pdf_url TEXT, page_url TEXT, n_speeches INTEGER, parsed_at TEXT","intervencoes":"id INTEGER PRIMARY KEY, reuniao TEXT, leg TEXT, sessao INTEGER, numero INTEGER, data TEXT, pagina INTEGER, orador TEXT, partido TEXT, dep_bid INTEGER, kind TEXT, cargo TEXT, palavras INTEGER, texto TEXT, agenda TEXT, source_url TEXT","iv_ini":"iv_id INTEGER, bid INTEGER, key TEXT, tipo TEXT, numero INTEGER, leg TEXT, ref TEXT","meta":"key TEXT PRIMARY KEY, value TEXT"},"justica":{"meta":"key TEXT PRIMARY KEY, value TEXT","orgaos":"id TEXT PRIMARY KEY, name TEXT, category TEXT, jurisdicao TEXT, description TEXT, website TEXT, nif TEXT, reachable INTEGER, source_url TEXT, entity_id INTEGER","tribunais":"entity_id INTEGER PRIMARY KEY, nif TEXT, name TEXT, category TEXT, comarca TEXT, buyer_contracts INTEGER, buyer_value REAL, source_url TEXT","mj_bodies":"nif TEXT PRIMARY KEY, entity_id INTEGER, name TEXT, source_url TEXT","stats_series":"indicator TEXT, ind_name TEXT, unit TEXT, period TEXT, geo TEXT, dim1 TEXT, dim2 TEXT, value REAL, source_url TEXT","stats_meta":"indicator TEXT PRIMARY KEY, name TEXT, updated TEXT, source_url TEXT","tc_acordaos":"id TEXT PRIMARY KEY, year INTEGER, num INTEGER, processo TEXT, formacao TEXT, especie TEXT, tipo TEXT, data TEXT, relator TEXT, norma TEXT, resultado TEXT, sumario TEXT, dre_act_id TEXT, url TEXT, source_url TEXT","tcontas_docs":"id TEXT PRIMARY KEY, categoria TEXT, grupo TEXT, year INTEGER, titulo_ref TEXT, numero TEXT, data TEXT, publicado TEXT, descricao TEXT, tipo TEXT, resultado TEXT, entity_name TEXT, entity_id INTEGER, entity_nif TEXT, match_method TEXT, pdf_url TEXT, source_url TEXT","blocked":"source TEXT, reason TEXT"},"ministerios":{"meta":"key TEXT PRIMARY KEY, value TEXT","ministries":"slug TEXT PRIMARY KEY, name TEXT, short TEXT, ord INTEGER, url TEXT, minister TEXT, minister_since TEXT, minister_role TEXT, address TEXT, keywords TEXT, source_url TEXT, alt_name TEXT, alt_since TEXT, alt_source TEXT, divergence TEXT","people":"id INTEGER PRIMARY KEY AUTOINCREMENT, ministry TEXT, kind TEXT, name TEXT, role TEXT, portfolio TEXT, start TEXT, email TEXT, gross TEXT, despacho TEXT, unit TEXT, source_url TEXT","bodies":"id INTEGER PRIMARY KEY AUTOINCREMENT, ministry TEXT, entity_id INTEGER, nif TEXT, name TEXT, ekind TEXT, method TEXT, basis TEXT, wikidata TEXT, source_url TEXT, UNIQUE(ministry, name)","decisions":"id INTEGER PRIMARY KEY AUTOINCREMENT, ministry TEXT, cm_date TEXT, cm_title TEXT, n INTEGER, text TEXT, matched TEXT, source_url TEXT","news":"url TEXT, ministry TEXT, title TEXT, date TEXT, source TEXT","spend_year":"ministry TEXT, year INTEGER, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL","spend_proc":"ministry TEXT, procedure TEXT, n INTEGER, value REAL","spend_sup":"ministry TEXT, seller_nif TEXT, seller_name TEXT, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL","spend_body":"ministry TEXT, nif TEXT, name TEXT, n INTEGER, value REAL, direct_value REAL","blocked":"source TEXT, reason TEXT"},"orcamento":{"meta":"key TEXT PRIMARY KEY, value TEXT","blocked":"source TEXT, url TEXT, reason TEXT","seo_editions":"year INTEGER, month INTEGER, pub TEXT, url TEXT, PRIMARY KEY (year, month)","exec_cum":"year INTEGER, month INTEGER, tbl TEXT, lkey TEXT, line TEXT, ord INTEGER, measure TEXT, value REAL, edition TEXT, source_url TEXT, PRIMARY KEY (year, month, tbl, lkey, measure)","annual":"year INTEGER, tbl TEXT, lkey TEXT, line TEXT, ord INTEGER, kind TEXT, value REAL, unit TEXT, source TEXT, source_url TEXT, PRIMARY KEY (year, tbl, lkey, kind, source)","oe_cells":"oe INTEGER, tbl TEXT, sheet TEXT, title TEXT, unit TEXT, line TEXT, ord INTEGER, col TEXT, colord INTEGER, value REAL, source_url TEXT","edition_vals":"year INTEGER, month INTEGER, lkey TEXT, edition TEXT, fmt TEXT, value REAL, PRIMARY KEY (year, month, lkey, edition)","checks":"kind TEXT, what TEXT, year INTEGER, month INTEGER, value REAL, expected REAL, diff_pct REAL","programs":"name TEXT PRIMARY KEY, code TEXT, ministry TEXT","mbo_entities":"oe INTEGER, mbo TEXT, ministry TEXT, name TEXT, nif TEXT, source_url TEXT","eurostat":"dataset TEXT, code TEXT, label TEXT, year INTEGER, unit TEXT, value REAL, source_url TEXT, PRIMARY KEY (dataset, code, year, unit)"},"posicoes":{"meta":"key TEXT PRIMARY KEY, value TEXT","ini_tema":"bid INTEGER, tema TEXT, PRIMARY KEY (bid, tema)","iv_tema":"iv_id INTEGER, tema TEXT, PRIMARY KEY (iv_id, tema)","decl":"id INTEGER PRIMARY KEY, iv_id INTEGER, dep_bid INTEGER, orador TEXT, partido TEXT, bid INTEGER, ref TEXT, titulo TEXT, data_discurso TEXT, declarado TEXT, citacao TEXT, voto_id INTEGER, fase TEXT, data_voto TEXT, voto TEXT, voto_origem TEXT, estado TEXT, coincide INTEGER, n_inic_discurso INTEGER, source_url TEXT, voto_url TEXT","fala":"id INTEGER PRIMARY KEY, leg TEXT, data TEXT, partido TEXT, dep_bid INTEGER, orador TEXT, kind TEXT, palavras INTEGER, ligada INTEGER","ini_partido":"partido TEXT, bid INTEGER, ref TEXT, titulo TEXT, n_falas INTEGER, palavras INTEGER, primeira_fala TEXT, voto TEXT, data_voto TEXT, fase TEXT, voto_id INTEGER, voto_url TEXT, decl_id INTEGER","excl":"motivo TEXT PRIMARY KEY, n INTEGER"},"presidencia":{"atos":"id TEXT PRIMARY KEY, data TEXT, ano INTEGER, presidente TEXT, tipo TEXT, subtipo TEXT, diploma_tipo TEXT, diploma_ref TEXT, decreto_ref TEXT, iniciativa_key TEXT, dre_act_id TEXT, link_metodo TEXT, titulo TEXT, texto TEXT, mensagem_url TEXT, acordao_tc TEXT, data_aprovacao TEXT, dias_aprovacao INTEGER, data_envio TEXT, dias_envio INTEGER, canon INTEGER DEFAULT 1, fonte TEXT, source_url TEXT, extra TEXT","vetos":"id TEXT PRIMARY KEY, data TEXT, data_ato TEXT, presidente TEXT, origem TEXT, motivo TEXT, decreto_ref TEXT, iniciativas TEXT, titulo TEXT, acordao_tc TEXT, desfecho TEXT, desfecho_data TEXT, desfecho_detalhe TEXT, promulgacao_data TEXT, dre_act_id TEXT, mensagem_url TEXT, mensagem_texto TEXT, fonte TEXT, source_url TEXT","tc_pedidos":"acordao_id TEXT PRIMARY KEY, data TEXT, tipo TEXT, requerente TEXT, presidente TEXT, decreto_ref TEXT, processo TEXT, resultado TEXT, iniciativa_key TEXT, link_metodo TEXT, veto_id TEXT, source_url TEXT","comunicados":"url TEXT PRIMARY KEY, data TEXT, titulo TEXT, tipo TEXT, n_diplomas INTEGER, texto TEXT, ato_id TEXT, link_metodo TEXT, fetched_at TEXT","cobertura":"chave TEXT PRIMARY KEY, valor TEXT","meta":"key TEXT PRIMARY KEY, value TEXT"},"provedor":{"meta":"key TEXT PRIMARY KEY, value TEXT","reports":"year INTEGER PRIMARY KEY, title TEXT, published TEXT, page_url TEXT, pdf_url TEXT, pages INTEGER, text_ok INTEGER, n_stats INTEGER","stats":"year INTEGER, metric TEXT, scope TEXT, label TEXT, value REAL, unit TEXT, quote TEXT, page INTEGER, source_url TEXT"},"regioes":{"meta":"key TEXT PRIMARY KEY, value TEXT","blocked":"region TEXT, topic TEXT, source TEXT, reason TEXT","regions":"id TEXT PRIMARY KEY, name TEXT, short TEXT, gov_label TEXT, gov_since TEXT, gov_url TEXT, assembly_name TEXT, assembly_url TEXT, legislature TEXT","members":"id INTEGER PRIMARY KEY AUTOINCREMENT, region TEXT, ord INTEGER, role TEXT, secretaria_key TEXT, name TEXT, party TEXT, since TEXT, until TEXT, current INTEGER, source TEXT, source_url TEXT","crosscheck":"region TEXT, portfolio TEXT, name_a TEXT, source_a TEXT, name_b TEXT, source_b TEXT, status TEXT, note TEXT","secretarias":"region TEXT, key TEXT, ord INTEGER, name TEXT, holder TEXT, url TEXT, PRIMARY KEY(region,key)","bodies":"id INTEGER PRIMARY KEY AUTOINCREMENT, region TEXT, secretaria_key TEXT, name TEXT, kind TEXT, holder TEXT, holder_role TEXT, since TEXT, source TEXT, source_url TEXT, current INTEGER DEFAULT 1","budget":"region TEXT, year INTEGER, scope TEXT, code TEXT, name TEXT, amount REAL, secretaria_key TEXT, source_url TEXT, note TEXT","budget_acts":"region TEXT, year INTEGER, number TEXT, date TEXT, title TEXT, url TEXT, kind TEXT","deputies":"id INTEGER PRIMARY KEY AUTOINCREMENT, region TEXT, legislature TEXT, name TEXT, full_name TEXT, party TEXT, circle TEXT, role TEXT, status TEXT, email TEXT, source_url TEXT","groups":"region TEXT, legislature TEXT, abbr TEXT, name TEXT, seats INTEGER, color TEXT, source_url TEXT","committees":"region TEXT, abbr TEXT, name TEXT, url TEXT, n_pending INTEGER, source_url TEXT","agenda":"region TEXT, committee TEXT, when_txt TEXT, title TEXT, source_url TEXT","initiatives":"region TEXT, id TEXT, legislature TEXT, kind TEXT, number TEXT, title TEXT, author TEXT, date TEXT, state TEXT, phase TEXT, result TEXT, plenary TEXT, url TEXT, session TEXT","ini_stats":"region TEXT, legislature TEXT, kind TEXT, n INTEGER","acts":"region TEXT, id TEXT, kind TEXT, number TEXT, date TEXT, title TEXT, summary TEXT, url TEXT","elections":"region TEXT, year INTEGER, party TEXT, abbr TEXT, votes INTEGER, pct REAL, pct_voters REAL, seats INTEGER, total_seats INTEGER, source_url TEXT, source TEXT","elections_wp":"region TEXT, year INTEGER, party TEXT, abbr TEXT, votes INTEGER, pct REAL, seats INTEGER, total_seats INTEGER, source_url TEXT","elections_meta":"region TEXT, year INTEGER, date TEXT, turnout REAL, source_url TEXT, registered INTEGER, voters INTEGER, blank INTEGER, null_votes INTEGER","election_check":"region TEXT, year INTEGER, party TEXT, votes_wp INTEGER, votes_mai INTEGER, pct_wp REAL, pct_valid_mai REAL, pct_voters_mai REAL, dpp REAL, dvotes INTEGER, note TEXT","c_year":"region TEXT, year INTEGER, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL","c_group":"region TEXT, grp TEXT, n_buyers INTEGER, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL","c_buyer":"region TEXT, nif TEXT, name TEXT, grp TEXT, secretaria_key TEXT, share REAL, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL, first_year INTEGER, last_year INTEGER","c_secretaria":"region TEXT, secretaria_key TEXT, n_buyers INTEGER, n INTEGER, value REAL, direct_n INTEGER, direct_value REAL","c_supplier":"region TEXT, nif TEXT, name TEXT, n INTEGER, value REAL, direct_value REAL","c_proc":"region TEXT, procedure TEXT, n INTEGER, value REAL"},"reguladores":{"bodies":"slug TEXT PRIMARY KEY, short TEXT, name TEXT, grp TEXT, site TEXT, law TEXT, mission TEXT, nif TEXT, entity_name TEXT, match_method TEXT, robots TEXT, ord INTEGER, source_url TEXT","board":"id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, holder TEXT, role TEXT, begin_date TEXT, end_date TEXT, active INTEGER, origin TEXT, source_url TEXT, UNIQUE(body, holder, role, begin_date)","dre_acts":"id TEXT, body TEXT, date TEXT, kind TEXT, number TEXT, title TEXT, source_url TEXT, UNIQUE(id, body)","decisions":"id TEXT PRIMARY KEY, body TEXT, kind TEXT, ref TEXT, date TEXT, year INTEGER, title TEXT, subject TEXT, amount REAL, amount_note TEXT, url TEXT, source_url TEXT","blocked":"body TEXT, what TEXT, url TEXT, reason TEXT","meta":"key TEXT PRIMARY KEY, value TEXT"},"responsaveis":{"meta":"key TEXT PRIMARY KEY, value TEXT","mandates":"id INTEGER PRIMARY KEY, entity_id INTEGER, entity TEXT, role_id INTEGER, role TEXT, holder_id INTEGER, holder TEXT, begin_date TEXT, end_date TEXT, board TEXT, entity_nif TEXT, match_method TEXT, source_url TEXT","holders":"holder_id INTEGER PRIMARY KEY, name TEXT, checked_at TEXT, n_decl INTEGER","declarations":"id INTEGER PRIMARY KEY, holder_id INTEGER, entity TEXT, board TEXT, role TEXT, nature TEXT, state TEXT, state_id INTEGER, year INTEGER, start_date TEXT, end_date TEXT, delivery_date TEXT, detail_at TEXT, n_interests INTEGER, source_url TEXT","interests":"id INTEGER PRIMARY KEY AUTOINCREMENT, declaration_id INTEGER, holder_id INTEGER, section TEXT, role TEXT, company TEXT, company_nif TEXT, nature TEXT, start_date TEXT, end_date TEXT, percent REAL, amount REAL, held_by TEXT, source_url TEXT","cresap":"code TEXT, status TEXT, entity TEXT, role TEXT, entity_nif TEXT, proposal_url TEXT, despacho_url TEXT, item_url TEXT, source_url TEXT, seen_at TEXT, UNIQUE (code, status, entity, role)","appointments":"id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, person TEXT, role TEXT, organ TEXT, ministry TEXT, start TEXT, act TEXT, source_url TEXT","links":"interest_id INTEGER PRIMARY KEY, holder_id INTEGER, company_nif TEXT, n_contracts INTEGER, total REAL, first_signed TEXT, last_signed TEXT, n_in_period INTEGER, total_in_period REAL, n_with_own_entity INTEGER, total_with_own_entity REAL, is_public INTEGER DEFAULT 0","blocked":"source TEXT, reason TEXT","nomeacoes":"id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, action TEXT, person TEXT, role TEXT, entity TEXT, entity_nif TEXT, date TEXT, act TEXT, act_id TEXT, source_url TEXT, match_method TEXT, UNIQUE (act_id, action, person, role)","cresap_results":"code TEXT, role TEXT, entity TEXT, entity_nif TEXT, outcome TEXT, candidate TEXT, date TEXT, pdf_url TEXT, UNIQUE (code, candidate, outcome)"},"risco":{"meta":"key TEXT PRIMARY KEY, value TEXT","flag_defs":"flag TEXT PRIMARY KEY, level TEXT, weight REAL, label TEXT, description TEXT, caveat TEXT, n_flagged INTEGER, value_flagged REAL","contract_flags":"contract_id TEXT, flag TEXT, weight REAL, evidence_json TEXT, year INTEGER, signed TEXT, price REAL, buyer_nif TEXT, seller_nif TEXT, procedure_id TEXT, buyer_kind TEXT, seller_kind TEXT","contract_score":"contract_id TEXT PRIMARY KEY, score REAL, flags TEXT, year INTEGER, signed TEXT, price REAL, procedure TEXT, buyer_nif TEXT, seller_nif TEXT, buyer_kind TEXT, procedure_id TEXT, seller_kind TEXT","pair_flags":"buyer_nif TEXT, seller_nif TEXT, flag TEXT, weight REAL, n_contracts INTEGER, value REAL, evidence_json TEXT, buyer_kind TEXT, seller_kind TEXT","entity_risk":"nif TEXT, role TEXT, name TEXT, kind TEXT, score REAL, flags_json TEXT, n_contracts INTEGER, value REAL, n_flagged_contracts INTEGER, peer_group TEXT, n_peers INTEGER, context_json TEXT, PRIMARY KEY (nif, role)","entity_context":"nif TEXT PRIMARY KEY, kind TEXT, peer_group TEXT, n_peers INTEGER, context_json TEXT"},"saude":{"meta":"key TEXT PRIMARY KEY, value TEXT","institutions":"id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, region TEXT, region_how TEXT, address TEXT, postal TEXT, locality TEXT, phone TEXT, email TEXT, website TEXT, president TEXT, president_role TEXT, description TEXT, n_units INTEGER DEFAULT 0, n_hospitals INTEGER DEFAULT 0, n_aces INTEGER DEFAULT 0, n_cs INTEGER DEFAULT 0, nif TEXT, entity_id INTEGER, match_how TEXT, norm TEXT, source_url TEXT, period TEXT","units":"inst_id TEXT, kind TEXT, name TEXT, parent TEXT, source_url TEXT","ine_series":"indicator TEXT, indicator_name TEXT, family TEXT, unit TEXT, geo_code TEXT, geo_name TEXT, level TEXT, dim TEXT, period TEXT, value REAL, flag TEXT, source_url TEXT","catalog":"dataset_id TEXT PRIMARY KEY, title TEXT, publisher TEXT, topic TEXT, frequency TEXT, license TEXT, last_update TEXT, dados_url TEXT, portal_url TEXT, formats TEXT, status TEXT, note TEXT"},"seguranca":{"meta":"key TEXT PRIMARY KEY, value TEXT","ine_series":"indicator TEXT, label TEXT, family TEXT, unit TEXT, geo_code TEXT, geo_name TEXT, level TEXT, dico TEXT, dim TEXT, year INTEGER, value REAL, flag TEXT, upstream TEXT, source_url TEXT","orgaos":"sigla TEXT PRIMARY KEY, name TEXT, grp TEXT, tutela TEXT, website TEXT, description TEXT, entity_id INTEGER, nif TEXT, match_method TEXT, source_url TEXT","bombeiros":"entity_id INTEGER PRIMARY KEY, nif TEXT, name TEXT, tipo TEXT, dico TEXT, concelho TEXT, match_method TEXT, source_url TEXT"},"votacoes":{"iniciativas":"bid INTEGER PRIMARY KEY, key TEXT, tipo TEXT, numero INTEGER, leg TEXT, sessao INTEGER, titulo TEXT, autoria TEXT, origem TEXT, autores_json TEXT, n_fases INTEGER, n_votos INTEGER, data_entrada TEXT, data_ultima TEXT, ultima_fase TEXT, estado TEXT, resultado_generalidade TEXT, resultado_final TEXT, data_votacao_final TEXT, lei_ref TEXT, dr_ref TEXT, dr_date TEXT, dre_act_id TEXT, final INTEGER DEFAULT 0, fetched_at TEXT, source_url TEXT","fases":"bid INTEGER, ord INTEGER, data TEXT, fase TEXT, comissao TEXT, competente INTEGER, obs TEXT, publicacoes TEXT, texto_titulo TEXT, texto_tipo TEXT, source_url TEXT, diploma_bid INTEGER, PRIMARY KEY (bid, ord)","votos":"id INTEGER PRIMARY KEY, bid INTEGER, ord INTEGER, data TEXT, fase TEXT, orgao TEXT, reuniao TEXT, resultado TEXT, unanime INTEGER, favor TEXT, contra TEXT, abstencao TEXT, ausencia TEXT, detalhe TEXT, source_url TEXT","voto_partido":"voto_id INTEGER, partido TEXT, sentido TEXT, kind TEXT, nome TEXT, n INTEGER","relatores":"bid INTEGER, ord INTEGER, comissao TEXT, dep_bid INTEGER, nome TEXT, partido TEXT, motivo TEXT","autores":"bid INTEGER, dep_bid INTEGER, nome TEXT, partido TEXT","conjuntas":"bid INTEGER, ord INTEGER, outro_bid INTEGER, numero TEXT, autor TEXT, titulo TEXT","listagem":"leg TEXT, tipo_code TEXT, bid INTEGER, tipo TEXT, numero TEXT, sessao INTEGER, autoria TEXT, titulo TEXT, PRIMARY KEY (leg, tipo_code, bid)","meta":"key TEXT PRIMARY KEY, value TEXT"}}''')

EXTRA_COLUMNS = {
    ("politica", "entities"): ["population_source TEXT"],
    ("votacoes", "fases"): ["diploma_bid INTEGER"],
    ("votacoes", "votos"): ["inconsistente INTEGER"],
    ("votacoes", "iniciativas"): ["leg_fim TEXT", "transitou INTEGER DEFAULT 0"],
    ("responsaveis", "links"): [],
}

FIRST = ["Ana", "Rui", "Marta", "Tiago", "Inês", "Paulo", "Sofia", "Nuno", "Carla", "Hugo", "Rita", "Bruno", "Lara", "Davi", "Eva", "Luís"]
LAST = ["Exemplo", "Modelo", "Teste", "Amostra", "Fictício", "Sintético"]
PARTIES = [("PEA", "Partido Exemplo A", 84, "#c0392b"), ("PEB", "Partido Exemplo B", 78, "#e67e22"), ("PEC", "Partido Exemplo C", 30, "#2980b9"),
           ("PED", "Partido Exemplo D", 18, "#27ae60"), ("PEE", "Partido Exemplo E", 12, "#8e44ad"), ("PEF", "Partido Exemplo F", 8, "#7f8c8d")]
PCODES = [p[0] for p in PARTIES]
DISTRICTS = ["Distrito Exemplo A", "Distrito Exemplo B", "Distrito Exemplo C"]
PROCS = ["Ajuste Direto Regime Geral", "Consulta Prévia", "Concurso público", "Ao abrigo de acordo-quadro (art.º 258.º/259.º)", "Ajuste direto simplificado", "Concurso limitado por prévia qualificação"]
CPVS = ["79421200-3", "45233120-6", "33100000-1", "80000000-4", "72000000-5", "90500000-2"]
SENSES = ["favor", "contra", "abstencao"]
RESULTS = ["Aprovado", "Rejeitado"]
KINDS_E = ["instituto_publico", "saude", "escola", "universidade", "ministerio", "empresa_publica", "seguranca_defesa", "tribunal_justica", "terceiro_setor", "cim_am"]
NMUNI, NFREG, NSUP = 14, 28, 60

DICOS = [f"99{i + 1:02d}" for i in range(NMUNI)]
FREGS = [f"{DICOS[i % NMUNI]}{i // NMUNI + 1:02d}" for i in range(NFREG)]
MUNI_NAMES = [f"Município de Exemplo {i + 1:02d}" for i in range(NMUNI)]
MIN_SLUGS = [f"ministerio-exemplo-{i + 1}" for i in range(6)]
MIN_NAMES = [f"Ministério de Exemplo {i + 1}" for i in range(6)]
NIF_MUNI = [f"599{i + 1:06d}" for i in range(NMUNI)]
NIF_FREG = [f"598{i + 1:06d}" for i in range(NFREG)]
NIF_BODY = [f"597{i + 1:06d}" for i in range(40)]
NIF_SUP = [f"596{i + 1:06d}" for i in range(NSUP)]
NIF_ALL = NIF_MUNI + NIF_FREG + NIF_BODY + NIF_SUP

BOOLS = {"reachable", "current", "active", "in_office", "counts", "final", "in_window", "parsed", "truncated", "pessoa_singular", "epr", "in_siee", "majority",
         "changed_2025", "partial", "unanime", "elected", "president", "republishes", "unfollowed", "ok_deadline", "obras", "post2018", "short", "at_base",
         "is_primary", "is_tender", "per_company", "inconsistente", "transitou", "text_ok", "is_public", "has_consolidated", "has_parliament", "ligada", "coincide"}
DATE_EXACT = {"date", "data", "day", "signed", "published", "decision", "start", "end", "deadline", "first_signed", "last_signed", "since", "until", "ref_date",
              "birth_date", "created", "updated", "publicado", "first_reg", "last_reg", "snapshot", "month_date", "data_decisao", "data_entrada", "data_ultima",
              "data_votacao_final", "dr_date", "data_discurso", "data_voto", "data_aprovacao", "data_envio", "data_ato", "desfecho_data", "promulgacao_data",
              "primeira_fala", "pub_date", "fetched_at", "minister_since", "alt_since", "gov_since", "cm_date", "begin_date", "end_date", "delivery_date",
              "version_date", "pmp_date", "when_txt", "start_date"}
PERSON_TABLES = {("politica", "people"), ("deputados", "deputados"), ("regioes", "members"), ("regioes", "deputies"), ("responsaveis", "holders"),
                 ("reguladores", "board"), ("ministerios", "people"), ("autarquias", "mandates"), ("educacao", "teacher_entries"), ("empresas_locais", "admin")}
PERSON_COLS = {"nome", "orador", "holder", "person", "mayor", "president", "relator", "minister", "full_name", "nome_parlamentar", "nome_completo", "candidate",
               "autor", "author", "alt_name", "name_a", "name_b", "presidente", "requerente", "president_role_x", "architect"}
ORG_NAME = {"name", "nome", "title", "titulo", "label", "entity", "entity_name", "buyer_name", "seller_name", "descricao", "description", "subject", "sumario",
            "object", "texto_titulo", "titulo_ref", "dst_label", "amending_title", "page_title", "pdf_label", "group_name", "programa", "detalhe", "agenda", "short"}
ENUM = {
    "procedure": PROCS, "kind": KINDS_E, "role": ["Presidente", "Vogal", "Diretor", "Relator"], "sex": ["H", "M"], "level": ["municipio", "freguesia", "nacional"],
    "party": PCODES, "partido": PCODES, "partido_x": PCODES, "gp_sigla": PCODES, "grp": ["A", "B", "C"], "status": ["ativo", "concluído"],
    "estado": ["Em curso", "Concluído"], "resultado": RESULTS, "result": RESULTS, "fase": ["Votação final global", "Votação na generalidade"],
    "orgao": ["Plenário"], "organ": ["CM", "AM"], "unit": ["EUR", "n"], "nature": ["Publica"], "currency": ["EUR"], "tipo": ["Projeto de Lei", "Proposta de Lei", "Projeto de Resolução"],
    "leg": ["XVII"], "legislature": ["XVII"], "legislatura": ["XVII"], "language": ["pt"], "cpv_code": CPVS, "cpv": CPVS, "types": ["Aquisição de serviços", "Empreitadas de obras públicas", "Aquisição de bens móveis"],
    "district": DISTRICTS, "distrito": DISTRICTS, "ministry": MIN_SLUGS, "ministerio": MIN_SLUGS, "region": ["Região Exemplo Norte", "Região Exemplo Sul"],
    "regiao": ["Região Exemplo Norte", "Região Exemplo Sul"], "municipality": MUNI_NAMES, "concelho": MUNI_NAMES, "municipio": MUNI_NAMES,
    "bloc": ["esquerda", "direita", "centro"], "side": ["favor", "contra"], "sentido": SENSES, "vote": ["Favor", "Contra", "Abstenção"], "family": ["Família A", "Família B"],
    "section": ["Plenário", "Comissões"], "fw": ["PRR", "PT2030", "PT2020"], "area": ["cultura", "desporto"], "orgao_x": ["DGARTES"],
}
ENUM_DB = {"regioes": {"region": ["acores", "madeira"]}, "risco": {"role": ["comprador", "fornecedor"]}}
TEXT_BANK = ["aquisição de serviços de limpeza", "obras de requalificação urbana", "fornecimento de equipamento informático", "manutenção de edifícios públicos",
             "prestação de serviços de consultadoria", "aquisição de medicamentos", "transporte escolar", "iluminação pública eficiente"]


def build_schema_sql(db, table, body):
    return f"CREATE TABLE IF NOT EXISTS {table} ({body})"


def parse_cols(body):
    parts, depth, cur = [], 0, ""
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur.strip())
            cur = ""
        else:
            cur += ch
    parts.append(cur.strip())
    cols = []
    for p in parts:
        w = p.split()
        if not w or re.match(r"(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b", w[0].upper()):
            continue
        ty = w[1].upper() if len(w) > 1 else "TEXT"
        cols.append((w[0], ty, "AUTOINCREMENT" in p.upper() or ("PRIMARY KEY" in p.upper() and ty == "INTEGER")))
    return cols


class Gen:
    def __init__(self, seed, today):
        self.R = random.Random(seed)
        self.today = today

    def date(self, back=1200, recent=0.6):
        R = self.R
        d = R.randint(0, 20) if R.random() < recent else R.randint(0, back)
        return (self.today - dt.timedelta(days=d)).isoformat()

    def person(self, i=None):
        R = self.R
        return f"{R.choice(FIRST)} {R.choice(LAST)} {R.choice(FIRST)}"

    def money(self, lo=2e3, hi=5e6):
        return round(math.exp(self.R.uniform(math.log(lo), math.log(hi))), 2)

    def value(self, db, table, col, ty, i):
        R = self.R
        c = col.lower()
        if c in ENUM_DB.get(db, {}):
            return R.choice(ENUM_DB[db][c])
        if c in ENUM:
            return R.choice(ENUM[c])
        if c == "nif" or c.endswith("_nif"):
            return R.choice(NIF_ALL)
        if c in ("dico",) or c.endswith("_dico"):
            return R.choice(DICOS)
        if c == "dicofre":
            return R.choice(FREGS)
        if c in ("entity_id", "eid", "buyer_entity_id") or c.endswith("_entity_id"):
            return R.randint(1, NMUNI + NFREG + 40)
        if c in ("bid", "dep_bid", "cad_id", "diploma_bid", "outro_bid"):
            return R.randint(1, 60)
        if c.startswith("nuts3"):
            return f"N3-{R.randint(1, 4):02d}"
        if c in ("source_url", "url", "link", "pdf_url", "website", "page_url", "report_url", "api_url", "dados_url", "portal_url", "mensagem_url", "proposal_url", "despacho_url", "item_url", "eli", "dr_url", "cons_url", "gov_url", "assembly_url", "site"):
            return f"https://exemplo.invalid/{table}/{i}"
        if c == "email":
            return f"contacto{i}@exemplo.invalid"
        if c in ("year", "ano", "fin_year", "debt_year", "budget_year", "first_year", "last_year", "primeiro", "ultimo", "school_year_x") or c.endswith("_year"):
            return R.randint(2018, self.today.year)
        if c == "month":
            return R.randint(1, 12)
        if c in ("quarter", "q"):
            return R.randint(1, 4)
        if c in DATE_EXACT or c.endswith("_date") or c.startswith("data_") or c.endswith("_at"):
            return self.date()
        if c.endswith("_json") or c in ("evidence", "extra", "changes_json"):
            return R.choice(["{}", "[]"]) if c != "mandatos_json" else "[]"
        if c in BOOLS:
            return R.choice([1, 1, 0])
        if (db, table) in PERSON_TABLES and c == "name" or c in PERSON_COLS:
            return self.person()
        if c in ORG_NAME:
            return f"{R.choice(['Entidade', 'Serviço', 'Instituto', 'Programa'])} de Exemplo {i}" if c != "object" else R.choice(TEXT_BANK) + f" ({i})"
        if ty in ("INTEGER", "REAL", "NUMERIC", "INT"):
            if "pct" in c or "rate" in c or "share" in c or "turnout" in c or c in ("score", "z", "weight", "discount"):
                return round(R.uniform(0, 100), 2)
            if ty == "INTEGER" and (c.startswith("n_") or c.startswith("n") and len(c) <= 4 or c in ("students", "workers", "seats", "mandates", "votes", "palavras", "pages", "rank", "ord")):
                return R.randint(1, 400)
            if ty == "REAL" or any(k in c for k in ("value", "price", "amount", "total", "aprovado", "pago", "budget", "revenue", "expense", "debt", "capital", "nominal", "custo", "contratado", "gross")):
                return self.money()
            return R.randint(1, 400)
        return f"{col.replace('_', ' ')} {i}"


def create_all(con, db):
    for t, body in SCHEMAS[db].items():
        con.execute(build_schema_sql(db, t, body))
        have = {r[1] for r in con.execute(f"PRAGMA table_info({t})")}
        for col in EXTRA_COLUMNS.get((db, t), []):
            if col.split()[0] not in have:
                con.execute(f"ALTER TABLE {t} ADD COLUMN {col}")


def fill_generic(con, g, db, skip=(), rows=None, counts=None):
    counts = counts or {}
    for t, body in SCHEMAS[db].items():
        if t in skip or t == "meta":
            continue
        cols = parse_cols(body)
        n = counts.get(t, rows)
        names = [c[0] for c in cols if not c[2]]
        sql = f"INSERT OR IGNORE INTO {t} ({','.join(names)}) VALUES ({','.join('?' * len(names))})"
        batch = []
        for i in range(1, n + 1):
            batch.append([g.value(db, t, c[0], c[1], i) for c in cols if not c[2]])
        con.executemany(sql, batch)


def set_meta(con, **kv):
    con.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    for k, v in kv.items():
        con.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (k, str(v)))


def open_db(out, name):
    path = os.path.join(out, name + ".db")
    for suf in ("", "-wal", "-shm"):
        if os.path.exists(path + suf):
            os.remove(path + suf)
    return sqlite3.connect(path)


BUILDERS = {}


def builder(name):
    def deco(fn):
        BUILDERS[name] = fn
        return fn
    return deco


def now_iso(g):
    return dt.datetime.combine(g.today, dt.time(6, 0)).isoformat(timespec="seconds")


@builder("politica")
def build_politica(con, g):
    R = g.R
    create_all(con, "politica")
    ent = []
    for i in range(NMUNI):
        ent.append((NIF_MUNI[i], MUNI_NAMES[i], "municipio", "local", 1, None, None, None, f"Câmara municipal sintética {i + 1}", "Região Exemplo Norte", DISTRICTS[i % 3], MUNI_NAMES[i], DICOS[i], R.randint(8000, 400000)))
    for i in range(NFREG):
        ent.append((NIF_FREG[i], f"Freguesia de Exemplo {i + 1:02d}", "freguesia", "local", 1, i % NMUNI + 1, None, None, "Freguesia sintética", "Região Exemplo Norte", DISTRICTS[i % 3], MUNI_NAMES[i % NMUNI], FREGS[i], R.randint(500, 20000)))
    for i in range(40):
        k = KINDS_E[i % len(KINDS_E)]
        ent.append((NIF_BODY[i], f"Entidade Pública de Exemplo {i + 1:02d}", k, "central", 1, None, MIN_SLUGS[i % 6], None, "Organismo sintético", None, None, None, None, None))
    for i in range(NSUP):
        ent.append((NIF_SUP[i], f"Fornecedor de Exemplo {i + 1:02d}, Lda.", "empresa_ou_particular", "privado", 0, None, None, None, "Empresa sintética", None, None, None, None, None))
    for i in range(6):
        ent.append((f"595{i + 1:06d}", MIN_NAMES[i], "ministerio", "central", 1, None, MIN_SLUGS[i], None, "Ministério sintético", None, None, None, None, None))
    con.executemany("INSERT INTO entities (nif,name,kind,level,is_public,parent_id,ministry,wikidata,description,region,district,municipality,dico,population) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9], e[10], e[11], e[12], e[13]) for e in ent])
    buyers = NIF_MUNI + NIF_FREG + NIF_BODY
    rows, parties = [], []
    for i in range(1, 561):
        buyer = R.choice(buyers[:NMUNI] * 4 + buyers)
        seller = R.choice(NIF_SUP[:15] * 3 + NIF_SUP)
        procedure = R.choices(PROCS, weights=[40, 10, 20, 15, 10, 5])[0]
        pub = dt.date.fromisoformat(g.date(back=1500, recent=0.4))
        signed = pub - dt.timedelta(days=R.randint(1, 20))
        price = g.money(500, 3e6) if i % 25 else g.money(2e6, 2.5e7)
        bidders = None if procedure.startswith("Ajuste") else R.choice([1, 2, 3, 5])
        eff = round(price * R.choice([1, 1, 1, 1.3]), 2)
        cid = f"{9000000 + i}"
        rows.append((cid, pub.year, signed.isoformat(), pub.isoformat(), signed.isoformat(), R.choice(TEXT_BANK) + f" n.º {i}", R.choice(["Aquisição de serviços", "Empreitadas de obras públicas", "Aquisição de bens móveis"]),
                     procedure, price, price * 1.1, eff, CPVS[i % 6] + " - Descrição", CPVS[i % 6], "Portugal, Distrito Exemplo A", R.randint(30, 700), bidders, None, "Não", None,
                     "Artigo 20.º, n.º 1, alínea d) do CCP", "Preço mais baixo", f"ANN{i}", f"https://exemplo.invalid/contrato/{cid}", buyer, f"Comprador {buyer}", seller, f"Fornecedor {seller}", 1))
        parties.append((cid, buyer, f"Comprador {buyer}", "buyer"))
        parties.append((cid, seller, f"Fornecedor {seller}", "seller"))
        for _ in range(bidders or 0):
            parties.append((cid, R.choice(NIF_SUP), "Concorrente Exemplo", "bidder"))
    con.executemany("INSERT INTO contracts VALUES (" + ",".join("?" * 28) + ")", rows)
    con.executemany("INSERT INTO contract_parties VALUES (?,?,?,?)", parties)
    con.execute("UPDATE contracts SET buyer_name = (SELECT name FROM entities e WHERE e.nif = contracts.buyer_nif), seller_name = (SELECT name FROM entities e WHERE e.nif = contracts.seller_nif)")
    con.execute("CREATE TABLE contract_mods (contract_id TEXT, date TEXT, published TEXT, basis TEXT, act_type TEXT, new_price REAL, new_duration INTEGER, year INTEGER)")
    mods = []
    for i in range(1, 561, 6):
        c = rows[i - 1]
        d = dt.date.fromisoformat(c[3]) + dt.timedelta(days=30)
        mods.append((c[0], d.isoformat(), d.isoformat(), "Trabalhos Complementares (art. 370.º)", "Acordo entre as partes", round(c[8] * R.choice([1.1, 1.4]), 2), 120, d.year))
    con.executemany("INSERT INTO contract_mods VALUES (?,?,?,?,?,?,?,?)", mods)
    con.executescript("""
CREATE TABLE buyer_stats AS SELECT buyer_nif AS nif, COUNT(*) AS n, COALESCE(SUM(CASE WHEN price > 0 THEN price END),0) AS value,
 SUM(CASE WHEN procedure LIKE 'Ajuste Direto%' THEN 1 ELSE 0 END) AS direct_n, COALESCE(SUM(CASE WHEN procedure LIKE 'Ajuste Direto%' AND price > 0 THEN price END),0) AS direct_value,
 SUM(CASE WHEN n_bidders = 1 AND procedure NOT LIKE 'Ajuste Direto%' THEN 1 ELSE 0 END) AS single_bidder_n,
 SUM(CASE WHEN n_bidders IS NOT NULL AND procedure NOT LIKE 'Ajuste Direto%' THEN 1 ELSE 0 END) AS competitive_n,
 SUM(CASE WHEN effective_price > price * 1.2 AND price > 0 THEN 1 ELSE 0 END) AS overrun_n, MIN(signed) AS first_signed, MAX(signed) AS last_signed
 FROM contracts WHERE buyer_nif IS NOT NULL GROUP BY buyer_nif;
CREATE UNIQUE INDEX buyer_stats_nif ON buyer_stats(nif);
CREATE TABLE seller_stats AS SELECT nif, COUNT(DISTINCT contract_id) AS n, COALESCE(SUM(CASE WHEN c.price > 0 THEN c.price * 1.0 / MAX(c.n_sellers, 1) END),0) AS value,
 COUNT(DISTINCT c.buyer_nif) AS n_buyers, SUM(CASE WHEN c.procedure LIKE 'Ajuste Direto%' THEN 1 ELSE 0 END) AS direct_n, MIN(c.signed) AS first_signed, MAX(c.signed) AS last_signed
 FROM contract_parties p JOIN contracts c ON c.id = p.contract_id WHERE p.role='seller' AND nif IS NOT NULL GROUP BY nif;
CREATE UNIQUE INDEX seller_stats_nif ON seller_stats(nif);
CREATE TABLE pair_stats AS SELECT buyer_nif, seller_nif, COUNT(*) AS n, COALESCE(SUM(CASE WHEN price > 0 THEN price * 1.0 / MAX(n_sellers, 1) END),0) AS value,
 SUM(CASE WHEN procedure LIKE 'Ajuste Direto%' THEN 1 ELSE 0 END) AS direct_n FROM contracts WHERE buyer_nif IS NOT NULL AND seller_nif IS NOT NULL GROUP BY buyer_nif, seller_nif;
CREATE INDEX pair_buyer ON pair_stats(buyer_nif, value DESC);
CREATE INDEX pair_seller ON pair_stats(seller_nif, value DESC);
CREATE TABLE year_stats AS SELECT buyer_nif AS nif, year, COUNT(*) AS n, COALESCE(SUM(CASE WHEN price > 0 THEN price END),0) AS value,
 SUM(CASE WHEN procedure LIKE 'Ajuste Direto%' THEN 1 ELSE 0 END) AS direct_n, COALESCE(SUM(CASE WHEN procedure LIKE 'Ajuste Direto%' AND price > 0 THEN price END),0) AS direct_value
 FROM contracts WHERE buyer_nif IS NOT NULL GROUP BY buyer_nif, year;
CREATE INDEX year_nif ON year_stats(nif, year);
CREATE TABLE buyer_mod_stats AS WITH last AS (SELECT contract_id, new_price, mods FROM (SELECT contract_id, new_price, COUNT(*) OVER (PARTITION BY contract_id) AS mods,
 ROW_NUMBER() OVER (PARTITION BY contract_id ORDER BY date DESC, rowid DESC) AS rn FROM contract_mods WHERE new_price > 0) WHERE rn = 1)
 SELECT c.buyer_nif AS nif, COUNT(*) AS modified_n, SUM(l.mods) AS mods_n, SUM(CASE WHEN l.new_price > c.price AND c.price > 0 THEN l.new_price - c.price ELSE 0 END) AS increase_value,
 SUM(CASE WHEN l.new_price > c.price * 1.25 AND c.price > 0 THEN 1 ELSE 0 END) AS big_increase_n FROM last l JOIN contracts c ON c.id = l.contract_id WHERE c.buyer_nif IS NOT NULL GROUP BY c.buyer_nif;
CREATE UNIQUE INDEX bms_nif ON buyer_mod_stats(nif);
CREATE VIRTUAL TABLE contracts_fts USING fts5(object, content='contracts', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
INSERT INTO contracts_fts(rowid, object) SELECT rowid, object FROM contracts;
UPDATE entities SET buyer_contracts = COALESCE((SELECT n FROM buyer_stats b WHERE b.nif = entities.nif), 0), buyer_value = COALESCE((SELECT value FROM buyer_stats b WHERE b.nif = entities.nif), 0),
 seller_contracts = COALESCE((SELECT n FROM seller_stats s WHERE s.nif = entities.nif), 0), seller_value = COALESCE((SELECT value FROM seller_stats s WHERE s.nif = entities.nif), 0) WHERE nif IS NOT NULL;
""")
    con.executemany("INSERT INTO parties VALUES (?,?,?,?,?,?,?)", [(c, n, s, "bloco", col, "ideologia sintética", "https://exemplo.invalid/partido") for c, n, s, col in PARTIES])
    people = []
    for i in range(1, 231):
        people.append((g.person(), "Deputado", "Assembleia da República", R.choices(PCODES, weights=[p[2] for p in PARTIES])[0], g.date(1200, 0), "https://exemplo.invalid/deputado"))
    for i in range(1, 17):
        people.append((g.person(), "Ministro" if i > 1 else "Primeiro-Ministro", "Governo", PCODES[0], g.date(900, 0), "https://exemplo.invalid/governo"))
    people.append((g.person(), "Presidente da República", "Presidência da República", None, g.date(900, 0), "https://exemplo.invalid/pr"))
    con.executemany("INSERT INTO people (name,role,body,party,since,source) VALUES (?,?,?,?,?,?)", people)
    evs = []
    for i in range(1, 81):
        d = g.today + dt.timedelta(days=R.randint(-14, 21))
        evs.append((i, f"Reunião sintética n.º {i}", f"{d.isoformat()}T10:00:00", f"{d.isoformat()}T12:00:00", R.choice(["Plenário", "Comissões"]), "Tema exemplo", None, "Sala Exemplo", "Ordem de trabalhos sintética sobre habitação e saúde.", "https://exemplo.invalid/agenda"))
    con.executemany("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)", evs)
    ini, steps, votes = [], [], []
    for i in range(1, 61):
        k = f"XVII/PL/{i}"
        ini.append((k, R.choice(["Projeto de Lei", "Proposta de Lei"]), i, "XVII", 1, R.choice(PCODES), f"Altera o regime sintético n.º {i}", "https://exemplo.invalid/ini"))
        for j, ph in enumerate(["Entrada", "Discussão", "Votação"]):
            steps.append((k, (i % 80) + 1, g.date(300, 0.3), ph, "Plenário", "detalhe", None, "https://exemplo.invalid/step"))
        favor = ",".join(R.sample(PCODES, 3)); contra = ",".join(R.sample(PCODES, 2))
        votes.append((k, g.date(300, 0.5), R.choice(RESULTS), favor, contra, "", "{}"))
    con.executemany("INSERT OR IGNORE INTO initiatives VALUES (?,?,?,?,?,?,?,?)", ini)
    con.executemany("INSERT OR IGNORE INTO initiative_steps VALUES (?,?,?,?,?,?,?,?)", steps)
    con.executemany("INSERT INTO votes VALUES (?,?,?,?,?,?,?)", votes)
    con.executemany("INSERT INTO laws VALUES (?,?,?,?,?,?,?)", [(f"L{i}", f"{i}/2025", f"Lei sintética {i}", "Lei", g.date(900), "https://exemplo.invalid/lei", "Resumo sintético") for i in range(1, 21)])
    con.executemany("INSERT INTO law_versions VALUES (?,?,?,?,?)", [(f"L{i}", g.date(500), f"Lei {i + 1}/2025", "Alteração", "https://exemplo.invalid/v") for i in range(1, 11)])
    con.executemany("INSERT INTO institutions VALUES (?,?,?,?,?,?,?)", [(f"inst{i}", f"Instituição de Exemplo {i}", R.choice(["órgão", "regulador", "tribunal"]), R.choice(["legislativo", "executivo", "judicial"]), "Descrição sintética", "https://exemplo.invalid/inst", 1) for i in range(1, 16)])
    con.executemany("INSERT INTO news VALUES (?,?,?,?,?)", [(f"https://exemplo.invalid/news/{i}", "Presidência da República", f"Comunicado sintético {i}", g.date(60, 0.5), "https://exemplo.invalid") for i in range(1, 9)])
    set_meta(con, contracts_updated=now_iso(g), agenda_updated=now_iso(g), built=now_iso(g), sample="dados sintéticos")


@builder("votacoes")
def build_votacoes(con, g):
    R = g.R
    create_all(con, "votacoes")
    vid = 0
    for i in range(1, 61):
        d = g.date(400, 0.4)
        con.execute("INSERT INTO iniciativas (bid,key,tipo,numero,leg,sessao,titulo,autoria,origem,autores_json,n_fases,n_votos,data_entrada,data_ultima,ultima_fase,estado,resultado_generalidade,resultado_final,data_votacao_final,lei_ref,dr_ref,dr_date,dre_act_id,final,fetched_at,source_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (i, f"XVII/PL/{i}", R.choice(["Projeto de Lei", "Proposta de Lei", "Projeto de Resolução"]), i, "XVII", 1, f"Altera o regime sintético n.º {i} e procede à sua regulamentação", R.choice(PCODES), "Parlamento", "[]", 3, 2, d, d, "Votação final global", "Concluído", "Aprovado", R.choice(RESULTS), d, None, None, None, None, 1, now_iso(g), "https://exemplo.invalid/ini"))
        for o, fase in enumerate(["Entrada", "Votação na generalidade", "Votação final global"]):
            con.execute("INSERT INTO fases (bid,ord,data,fase,comissao,competente,obs,publicacoes,texto_titulo,texto_tipo,source_url) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (i, o, g.date(400, 0.4), fase, "Comissão Exemplo", "sim", None, None, None, None, "https://exemplo.invalid/f"))
        for o, fase in enumerate(["Votação na generalidade", "Votação final global"]):
            vid += 1
            f = R.sample(PCODES, R.randint(2, 4))
            rest = [p for p in PCODES if p not in f]
            c = rest[: R.randint(1, len(rest))]
            a = [p for p in rest if p not in c]
            d = g.date(400, 0.5)
            con.execute("INSERT INTO votos (id,bid,ord,data,fase,orgao,reuniao,resultado,unanime,favor,contra,abstencao,ausencia,detalhe,source_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (vid, i, o, d, fase, "Plenário", "Reunião Plenária n.º 1", R.choice(RESULTS), 0, ", ".join(f), ", ".join(c), ", ".join(a), "", None, "https://exemplo.invalid/v"))
            for p in f: con.execute("INSERT INTO voto_partido VALUES (?,?,?,?,?,?)", (vid, p, "favor", "partido", p, R.randint(5, 80)))
            for p in c: con.execute("INSERT INTO voto_partido VALUES (?,?,?,?,?,?)", (vid, p, "contra", "partido", p, R.randint(5, 40)))
        con.execute("INSERT INTO autores VALUES (?,?,?,?)", (i, R.randint(1, 60), g.person(), R.choice(PCODES)))
        con.execute("INSERT INTO relatores VALUES (?,?,?,?,?,?,?)", (i, 0, "Comissão Exemplo", R.randint(1, 60), g.person(), R.choice(PCODES), None))
        con.execute("INSERT INTO listagem VALUES (?,?,?,?,?,?,?,?)", ("XVII", 1, i, "Projeto de Lei", i, 1, R.choice(PCODES), f"Altera o regime sintético n.º {i}"))
    set_meta(con, built=now_iso(g))


@builder("risco")
def build_risco(con, g):
    R = g.R
    create_all(con, "risco")
    flags = [("f_direto", "info", 2, "Ajuste direto elevado", "d", "c"), ("f_unico", "atenção", 3, "Concorrente único", "d", "c"), ("f_mods", "atenção", 3, "Modificações", "d", "c")]
    con.executemany("INSERT INTO flag_defs (flag,level,weight,label,description,caveat,n_flagged,value_flagged) VALUES (?,?,?,?,?,?,?,?)", [f + (50, 1e6) for f in flags])
    src = sqlite3.connect(con.execute("PRAGMA database_list").fetchone()[2].replace("risco.db", "politica.db"))
    cs = src.execute("SELECT id, year, signed, price, buyer_nif, seller_nif, procedure FROM contracts ORDER BY price DESC LIMIT 200").fetchall()
    for c in cs:
        fl = R.sample(flags, R.randint(1, 2))
        for f in fl:
            con.execute("INSERT INTO contract_flags VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (c[0], f[0], f[2], json.dumps({"x": 1}), c[1], c[2], c[3], c[4], c[5], 1, "municipio", "empresa"))
        con.execute("INSERT INTO contract_score VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (c[0], R.uniform(1, 10), ",".join(f[0] for f in fl), c[1], c[2], c[3], c[6], c[4], c[5], "municipio", 1, "empresa"))
    for nif in NIF_MUNI + NIF_BODY[:10]:
        con.execute("INSERT INTO entity_risk VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (nif, "comprador", f"Entidade {nif}", "municipio", R.uniform(1, 10), json.dumps(["f_direto"]), 40, 1e6, 5, "municipio", 14, "{}"))
        con.execute("INSERT INTO entity_context VALUES (?,?,?,?,?)", (nif, "municipio", "municipio", 14, "{}"))
    for b in NIF_MUNI[:6]:
        con.execute("INSERT INTO pair_flags VALUES (?,?,?,?,?,?,?,?,?)", (b, NIF_SUP[0], "f_direto", 2, 5, 1e5, "{}", "municipio", "empresa"))
    set_meta(con, built=now_iso(g))


@builder("divida")
def build_divida(con, g):
    R = g.R
    create_all(con, "divida")
    meta = [("total", "Dívida direta do Estado", "M€", "stock"), ("ot", "Obrigações do Tesouro", "M€", "stock"), ("aforro", "Certificados de aforro", "M€", "stock"), ("ct", "Certificados do Tesouro", "M€", "stock"),
            ("prazo_medio", "Prazo médio", "anos", "perfil"), ("pct_fixa", "Taxa fixa", "%", "perfil"), ("pct_euro", "Em euros", "%", "perfil"), ("duracao", "Duração", "anos", "perfil")]
    con.executemany("INSERT INTO series_meta VALUES (?,?,?,?)", meta)
    y, m = g.today.year, g.today.month
    for k, (code, label, unit, grp) in enumerate(meta):
        base = [260000, 190000, 28000, 8000, 7.5, 88, 94, 6.5][k]
        yy, mm = y - 6, m
        for i in range(72):
            mm += 1
            if mm > 12:
                mm, yy = 1, yy + 1
            last = (dt.date(yy + (mm == 12), mm % 12 + 1, 1) - dt.timedelta(days=1))
            if last > g.today:
                continue
            last = last.isoformat()
            con.execute("INSERT OR IGNORE INTO series VALUES (?,?,?,?)", (code, label, last, round(base * (1 + (0.004 * i if k < 4 else 0) + R.uniform(-0.01, 0.01)), 2)))
    set_meta(con, built=now_iso(g), source="https://exemplo.invalid/divida")


@builder("orcamento")
def build_orcamento(con, g):
    R = g.R
    create_all(con, "orcamento")
    y = g.today.year - 1
    lines = [("estado", "receita efetiva#r", "Receita efetiva", "receita"), ("estado", "despesa efetiva#d", "Despesa efetiva", "despesa"), ("estado", "saldo global#s", "Saldo global", "saldo"),
             ("estado", "saldo primario#s", "Saldo primário", "saldo"), ("estado", "juros e outros encargos#d", "Juros e outros encargos", "despesa"),
             ("estado", "despesas com o pessoal#d", "Despesas com o pessoal", "despesa"), ("estado", "aquisicao de bens e servicos#d", "Aquisição de bens e serviços", "despesa"),
             ("subsetores", "administracoes publicas#1", "Administrações públicas", "receita"), ("receita_estado", "imposto sobre o rendimento das pessoas singulares (irs)#r", "Imposto sobre o rendimento das pessoas singulares (IRS)", "receita"),
             ("receita_estado", "imposto sobre o valor acrescentado (iva)#r", "Imposto sobre o valor acrescentado (IVA)", "receita")]
    for yr in (y - 1, y):
        con.execute("INSERT OR IGNORE INTO seo_editions VALUES (?,?,?,?)", (yr, 12, f"{yr + 1}-01", "https://exemplo.invalid/seo"))
        for mth in range(1, 13):
            for ti, (tbl, lk, label, meas) in enumerate(lines):
                measures = ["receita", "despesa", "saldo"] if tbl == "subsetores" else ["exec"]
                for ms in measures:
                    v = round(R.uniform(1e3, 9e4) * mth * (1.05 if yr == y else 1), 1)
                    con.execute("INSERT INTO exec_cum VALUES (?,?,?,?,?,?,?,?,?,?)", (yr, mth, tbl, lk, label, ti, ms, v, "ed", "https://exemplo.invalid/seo"))
        for tbl, lk, label, meas in lines:
            for kind in ("oe_inicial", "cge"):
                con.execute("INSERT INTO annual VALUES (?,?,?,?,?,?,?,?,?,?)", (yr, tbl, lk, label, 0, kind, round(R.uniform(1e5, 9e5), 1), "M€", "fonte", "https://exemplo.invalid/oe"))
    for i, (slug, name) in enumerate(zip(MIN_SLUGS, MIN_NAMES)):
        con.execute("INSERT INTO programs VALUES (?,?,?)", (f"Programa de Exemplo {i + 1}", f"P{i + 1:03d}", slug))
        con.execute("INSERT INTO mbo_entities VALUES (?,?,?,?,?,?)", (y, "mbo", slug, f"Entidade de Exemplo {i + 1}", NIF_BODY[i], "https://exemplo.invalid/mbo"))
    set_meta(con, built=now_iso(g))


GENERIC_COUNTS = {
    "regioes": {}, "autarquias": {"municipios": NMUNI, "metrics": NMUNI},
}


SKIP = {"habitacao": ("ine_series",), "regioes": ("regions",)}
POST = {}


def post_habitacao(con, g):
    R = g.R
    fams = [("venda", "Total"), ("renda", ""), ("licenciados", "Total"), ("concluidos", "Total"), ("social", "Total")]
    for fam, dim in fams:
        for per in (f"{g.today.year - 2}Q4", f"{g.today.year - 1}Q4"):
            for lvl, dico in [("PT", None)] + [("concelho", d) for d in DICOS]:
                con.execute("INSERT INTO ine_series VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (fam, fam, fam, "n", dico or "PT", MUNI_NAMES[DICOS.index(dico)] if dico else "Portugal", lvl, dico, dim, per, int(per[:4]), int(per[-1]), round(R.uniform(500, 3000), 1), None, "https://exemplo.invalid/ine"))
    for fam, dims in [("censos_ocup", ["Total", "Residência habitual", "Vago para venda ou arrendamento", "Vago por outros motivos", "Uso sazonal ou secundário"]), ("censos_regime", ["Total", "Arrendado", "Próprio"])]:
        for lvl, dico in [("PT", None)] + [("concelho", d) for d in DICOS]:
            for dim in dims:
                con.execute("INSERT INTO ine_series VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (fam, fam, fam, "n", dico or "PT", dico or "Portugal", lvl, dico, dim, "2021", 2021, None, round(R.uniform(1000, 90000), 0), None, "https://exemplo.invalid/ine"))


POST["habitacao"] = post_habitacao


def post_regioes(con, g):
    con.execute("INSERT INTO regions (id,name,short,gov_label,gov_since,gov_url,assembly_name,assembly_url,legislature) VALUES (?,?,?,?,?,?,?,?,?)", ("acores", "Região Autónoma dos Açores", "Açores", "Governo Regional Exemplo", g.date(900, 0), "https://exemplo.invalid/gov", "Assembleia Legislativa Exemplo", "https://exemplo.invalid/al", "XIII"))
    con.execute("INSERT INTO regions (id,name,short,gov_label,gov_since,gov_url,assembly_name,assembly_url,legislature) VALUES (?,?,?,?,?,?,?,?,?)", ("madeira", "Região Autónoma da Madeira", "Madeira", "Governo Regional Exemplo", g.date(900, 0), "https://exemplo.invalid/gov", "Assembleia Legislativa Exemplo", "https://exemplo.invalid/al", "XIV"))


POST["regioes"] = post_regioes


def build_generic(db):
    def fn(con, g):
        create_all(con, db)
        fill_generic(con, g, db, rows=60, counts=GENERIC_COUNTS.get(db, {}), skip=SKIP.get(db, ()))
        if db in POST:
            POST[db](con, g)
        set_meta(con, built=now_iso(g), sample="dados sintéticos")
    return fn


def run_post(con, db, g):
    pass


def main():
    ap = argparse.ArgumentParser(description="Gera bases SQLite sintéticas para desenvolvimento e testes (nunca dados reais).")
    ap.add_argument("--out", default=os.environ.get("ESTADO_ABERTO_DATA") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
    ap.add_argument("--seed", type=int, default=20260101)
    ap.add_argument("--today", default=None)
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()
    only = [x for x in args.only.split(",") if x]
    order = ["politica"] + [d for d in sorted(SCHEMAS) if d != "politica"]
    for db in order:
        if only and db not in only:
            continue
        g = Gen(f"{args.seed}:{db}", today)
        con = open_db(out, db)
        (BUILDERS.get(db) or build_generic(db))(con, g)
        con.commit()
        n = sum(con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for (t,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall() if not t.endswith(("_fts", "_data", "_idx", "_docsize", "_config", "_content")))
        con.close()
        print(f"{db}.db: {n} linhas")
    print(f"escrito em {out}")


if __name__ == "__main__":
    main()
