"""Adapter for the Assembleia da República open data (Iniciativas, Informação Base, votes).

STATUS: not implemented yet. On 2026-10-29 the parliament's open-data pages
(https://www.parlamento.pt/Cidadania/Paginas/DadosAbertos.aspx -> DAIniciativas.aspx, DAInformacaoBase.aspx)
returned empty responses, so the real file URLs/format could not be inspected.

When the feed is back, this module should fill:
  - initiative_steps (official phases: entrada, admissão, baixa a comissão, generalidade, especialidade, votação final, promulgação, publicação)
  - votes           (result + per-party favor/against/abstention)
  - laws, law_versions (published acts and their amendment chain, from "Diplomas Aprovados" + Diário da República)
  - people          (body='Assembleia da República': the 230 deputies with party, circle, committees)
Tables already exist (see common.SCHEMA); the server and UI already render them when non-empty.

`python ar_opendata.py` just probes availability.
"""
import sys
import urllib.request

from common import UA

PROBES = [
    "https://www.parlamento.pt/Cidadania/Paginas/DAIniciativas.aspx",
    "https://www.parlamento.pt/Cidadania/Paginas/DAInformacaoBase.aspx",
    "https://www.parlamento.pt/Cidadania/Paginas/DADiplomasAprovados.aspx",
]


def main():
    ok = False
    for u in PROBES:
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=30) as r:
                body = r.read()
            print(f"{len(body):>8} bytes  {u}")
            ok = ok or len(body) > 0
        except Exception as e:
            print(f"   ERROR  {u}: {e}")
    print("AR open data is", "REACHABLE - implement the adapter" if ok else "still unavailable")
    return 0


if __name__ == "__main__":
    sys.exit(main())
