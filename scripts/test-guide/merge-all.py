"""Assemble LE guide de test complet : docs/testing/Guide-test-complet.pdf (couverture + sommaire + signets), le SEUL PDF du dossier docs/testing.

Les parties sont listées dans docs/testing/parts/parts.json (ordre, étiquette, titre). Une partie est :
  - un .pdf   : repris tel quel ;
  - un .html  : rendu en PDF par Chrome ;
  - un .md    : rendu par scripts/test-guide/build-pdf.mjs (tableaux de cas avec identifiants -> fiche de résultats OK / KO).
Pour AJOUTER quelque chose au guide : déposer le fichier dans docs/testing/parts/, ajouter une ligne dans parts.json, puis `pnpm test:guide`.

Usage : python scripts/test-guide/merge-all.py   (Chrome requis ; variable CHROME_PATH pour un autre exécutable ; module pypdf)
"""
import html
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pypdf

ROOT = Path(__file__).resolve().parents[2]
TESTING = ROOT / "docs" / "testing"
PARTS_DIR = TESTING / "parts"
OUT = TESTING / "Guide-test-complet.pdf"


def chrome() -> str:
    for candidate in [os.environ.get("CHROME_PATH", ""), r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"]:
        if candidate and Path(candidate).exists():
            return candidate
    sys.exit("Chrome introuvable (CHROME_PATH)")


def html_to_pdf(src: Path, dst: Path) -> None:
    subprocess.run([chrome(), "--headless=new", "--disable-gpu", "--no-pdf-header-footer", f"--print-to-pdf={dst}", src.resolve().as_uri()], check=True, capture_output=True)


def render_part(entry: dict, tmp: Path, index: int) -> Path:
    src = (PARTS_DIR / entry["file"]).resolve()
    if not src.exists():
        sys.exit(f"partie manquante : {entry['file']}")
    suffix = src.suffix.lower()
    if suffix == ".pdf":
        return src
    dst = tmp / f"part-{index:02d}.pdf"
    if suffix in (".html", ".htm"):
        html_to_pdf(src, dst)
    elif suffix == ".md":
        subprocess.run(["node", str(ROOT / "scripts" / "test-guide" / "build-pdf.mjs"), str(src), str(dst)], check=True, capture_output=True, cwd=ROOT)
    else:
        sys.exit(f"type de partie non géré : {entry['file']}")
    return dst


def cover(rows: list[tuple[str, str, int, int]], tmp: Path) -> Path:
    lines = "".join(
        f"<tr><td>{html.escape(tag)}</td><td>{html.escape(title)}</td><td class='p'>p. {start}</td><td class='p'>{count} p.</td></tr>" for tag, title, start, count in rows
    )
    page = f"""<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
@page {{ size: A4; margin: 0; }}
:root {{ --brand:#00d4a4; --ink:#0a0a0a; --muted:#5d6671; --line:#e6e8eb; --night:#1a3d4a; }}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{ font-family: "Segoe UI", Arial, sans-serif; color: var(--ink); -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
.hero {{ padding: 16mm 16mm 12mm; color: #fff; background: linear-gradient(135deg, #0a0a0a 0%, var(--night) 55%, #00b48a 125%); }}
.hero .pill {{ display:inline-block; border:1px solid rgba(0,212,164,.55); background:rgba(0,212,164,.18); color:var(--brand); border-radius:999px; padding:2px 11px; font-size:9pt; font-weight:600; }}
.hero h1 {{ font-size: 28pt; margin-top: 10px; line-height: 1.08; }}
.hero p {{ margin-top: 8px; color: rgba(255,255,255,.78); font-size: 10.5pt; max-width: 130mm; }}
.wrap {{ padding: 9mm 16mm; }}
table {{ border-collapse: collapse; width: 100%; font-size: 10pt; }}
th, td {{ border-bottom: 1px solid var(--line); padding: 7px 6px; text-align: left; vertical-align: top; }}
th {{ font-size: 8pt; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); border-bottom: 2px solid var(--ink); }}
td:first-child {{ font-weight: 700; color: #00775f; white-space: nowrap; }}
td.p {{ white-space: nowrap; color: var(--muted); }}
.box {{ margin-top: 8mm; background:#e5faf4; border:1px solid #b9efe0; border-radius:12px; padding:5mm 6mm; font-size:9.6pt; line-height:1.5; }}
</style></head><body>
<div class="hero"><span class="pill">Fusion Leap AI Growth</span><h1>Guide de test complet</h1><p>Un seul fichier, dans l'ordre où l'on teste : toutes les phases, puis le test réel.</p></div>
<div class="wrap">
<table><tr><th>Partie</th><th>Contenu</th><th>Départ</th><th>Durée</th></tr>{lines}</table>
<div class="box"><b>Ordre conseillé :</b> d'abord les phases 1 à 3 (comptes de démonstration, aucun envoi réel), ensuite le test réel C3 (vrais fournisseurs, vos propres adresses et numéros seulement).<br>
Chaque partie a sa fiche de résultat (OK / KO / non testé). <b>KO</b> = le test n'a pas donné le résultat attendu : noter le code d'erreur, jamais un jeton. <b>Non testé</b> n'est pas un échec. Les signets du PDF (volet de gauche) mènent à chaque partie.</div>
</div></body></html>"""
    src = tmp / "cover.html"
    dst = tmp / "cover.pdf"
    src.write_text(page, encoding="utf-8")
    html_to_pdf(src, dst)
    return dst


def main() -> None:
    config = json.loads((PARTS_DIR / "parts.json").read_text(encoding="utf-8"))
    entries = config["parts"]
    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)
        rendered = [(entry, pypdf.PdfReader(str(render_part(entry, tmp, i)))) for i, entry in enumerate(entries)]
        start = 2  # la couverture occupe la page 1
        rows = []
        for entry, reader in rendered:
            rows.append((entry["tag"], entry["title"], start, len(reader.pages)))
            start += len(reader.pages)
        cover_reader = pypdf.PdfReader(str(cover(rows, tmp)))
        if len(cover_reader.pages) != 1:
            sys.exit("la couverture dépasse une page : réduire les titres")
        writer = pypdf.PdfWriter()
        writer.append(cover_reader)
        writer.add_outline_item("Sommaire", 0)
        for (entry, reader), (_, _, first, _) in zip(rendered, rows):
            writer.append(reader)
            writer.add_outline_item(f"{entry['tag']} : {entry['title']}", first - 1)
        writer.add_metadata({"/Title": "Guide de test complet : toutes les phases", "/Author": "Fusion Leap AI Growth"})
        with OUT.open("wb") as fh:
            writer.write(fh)
    # un seul PDF dans docs/testing : l'ancien nom n'est plus produit
    old = TESTING / "Guide-test-complet-toutes-phases.pdf"
    if old.exists():
        old.unlink()
    print(f"{OUT.name} : {start - 1} pages, {len(entries)} parties")


if __name__ == "__main__":
    main()
