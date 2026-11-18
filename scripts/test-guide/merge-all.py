"""Assemble UN SEUL PDF de recette à partir des guides par phase (docs/testing/*.pdf) : couverture + sommaire cliquable + signets.
Usage : python scripts/test-guide/merge-all.py   (Chrome requis pour la couverture ; variable CHROME_PATH pour un autre exécutable)
Le texte des guides n'est pas recopié : chaque guide garde sa source et se régénère à part ; ce script ne fait que les réunir."""
import html
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pypdf

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / "docs" / "testing"
OUT = DIR / "Guide-test-complet-toutes-phases.pdf"

PARTS = [
    ("Phase 1", "Comptes, entreprises et rôles (J4 à J15)", "Guide-test-simple-phase1-comptes-roles.pdf"),
    ("Phase 2", "Projets, leads, contacts et deals (J16 à J28)", "Guide-test-simple-phase2-crm.pdf"),
    ("Phases 2 et 3", "Recette détaillée, partie interface et partie technique (J16 à J32)", "Guide-tests-phases-2-3.pdf"),
    ("Phase 3", "Conversations et envoi d'e-mails (J29 à J31)", "Guide-test-simple-phase3-conversations-envoi.pdf"),
    ("Phase 3", "Boîte de réception et réponses (J38)", "Guide-test-simple-boite-reponses.pdf"),
    ("Phase 3", "Exploitation, configuration et import (J39 à J40)", "Guide-test-simple-phase3-exploitation-configuration.pdf"),
    ("Checkpoint C3", "Test réel : Postmark, WhatsApp, arrêt d'urgence, fuites (J41), étape par étape", "Guide-test-reel-complet-C3.pdf"),
]


def chrome() -> str:
    for candidate in [os.environ.get("CHROME_PATH", ""), r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe", "/usr/bin/google-chrome"]:
        if candidate and Path(candidate).exists():
            return candidate
    sys.exit("Chrome introuvable (CHROME_PATH)")


def cover(rows: list[tuple[str, str, int, int]]) -> bytes:
    lines = "".join(
        f"<tr><td>{html.escape(tag)}</td><td>{html.escape(title)}</td><td class='p'>p. {start}</td><td class='p'>{count} p.</td></tr>" for tag, title, start, count in rows
    )
    page = f"""<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
@page {{ size: A4; margin: 18mm 16mm; }}
body {{ font-family: "Segoe UI", Arial, sans-serif; color: #1b2430; }}
h1 {{ font-size: 26pt; color: #123a63; margin: 40px 0 4px; }} .sub {{ color:#51607a; margin-bottom: 26px; }}
table {{ border-collapse: collapse; width: 100%; font-size: 10.5pt; }} th, td {{ border-bottom: 1px solid #c9d3e0; padding: 7px 6px; text-align: left; vertical-align: top; }}
th {{ background:#eef1f6; }} td.p {{ white-space: nowrap; color:#51607a; }}
.box {{ margin-top: 26px; border:1px solid #f0b44c; background:#fff4e0; border-radius:6px; padding:9px 12px; font-size: 10pt; }}
</style></head><body>
<h1>Guide de test complet : toutes les phases</h1>
<div class="sub">Fusion Leap AI Growth · un seul fichier, dans l'ordre où l'on teste</div>
<table><tr><th>Partie</th><th>Contenu</th><th>Départ</th><th>Durée</th></tr>{lines}</table>
<div class="box"><b>Ordre conseillé :</b> d'abord les phases 1 à 3 (comptes de démonstration, aucun envoi réel), ensuite le test réel C3 (vrais Postmark et WhatsApp, vos propres adresses et numéros seulement).<br>
Chaque guide a sa propre fiche de résultat (OK / KO / non testé). <b>KO</b> = le test n'a pas donné le résultat attendu : noter le code d'erreur, jamais un jeton. <b>Non testé</b> n'est pas un échec.<br>
Les signets du PDF (volet de gauche) mènent à chaque partie.</div>
</body></html>"""
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "cover.html"
        dst = Path(tmp) / "cover.pdf"
        src.write_text(page, encoding="utf-8")
        subprocess.run([chrome(), "--headless=new", "--disable-gpu", "--no-pdf-header-footer", f"--print-to-pdf={dst}", src.as_uri()], check=True, capture_output=True)
        return dst.read_bytes()


def main() -> None:
    readers = []
    for tag, title, name in PARTS:
        path = DIR / name
        if not path.exists():
            sys.exit(f"guide manquant : {path.name}")
        readers.append((tag, title, pypdf.PdfReader(str(path))))
    start = 2  # la couverture occupe la page 1 (une seule page : le sommaire tient dessus)
    rows = []
    for tag, title, reader in readers:
        rows.append((tag, title, start, len(reader.pages)))
        start += len(reader.pages)
    cover_bytes = cover(rows)
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as handle:
        handle.write(cover_bytes)
        cover_path = handle.name
    cover_reader = pypdf.PdfReader(cover_path)
    if len(cover_reader.pages) != 1:
        sys.exit("la couverture dépasse une page")
    writer = pypdf.PdfWriter()
    writer.append(cover_reader)
    writer.add_outline_item("Sommaire", 0)
    for (tag, title, reader), (_, _, first, _) in zip(readers, rows):
        writer.append(reader)
        writer.add_outline_item(f"{tag} : {title}", first - 1)
    writer.add_metadata({"/Title": "Guide de test complet : toutes les phases", "/Author": "Fusion Leap AI Growth"})
    with OUT.open("wb") as fh:
        writer.write(fh)
    os.unlink(cover_path)
    print(f"{OUT.name} : {start - 1} pages, {len(readers)} guides")


if __name__ == "__main__":
    main()
