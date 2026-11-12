/**
 * Génère le PDF d'un guide de tests (Markdown) : `pnpm test:guide` produit docs/testing/Guide-tests-phases-2-3.pdf à partir de
 * docs/testing/phase2-3-functional-tests.md, avec couverture, sommaire, tableaux de cas et FICHE DE RÉSULTATS (OK / KO / commentaire) générée
 * à partir des identifiants de cas (première colonne des tableaux : A1, B12, T6.3...). Chrome headless (CHROME_PATH pour un autre exécutable).
 * Sous-ensemble de Markdown pris en charge : titres #, ##, ###, paragraphes, listes (avec blocs de code imbriqués), tableaux, blocs de code, citations, règles.
 *
 *   pnpm test:guide                 -> PDF
 *   pnpm test:guide --html          -> HTML seulement (sans Chrome)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const source = path.join(root, "docs/testing/phase2-3-functional-tests.md");
const outPdf = path.join(root, "docs/testing/Guide-tests-phases-2-3.pdf");
const tmpDir = path.join(root, "docs/progress/report"); // les polices sont à côté (fonts/)
const htmlOnly = process.argv.includes("--html");

const md = readFileSync(source, "utf8").replace(/\r\n/g, "\n");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- inline ----------------------------------------------------------------------------------------------------
function inline(text) {
  const codes = [];
  let t = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `${codes.length - 1}`;
  });
  t = esc(t)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t.replace(/(\d+)/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

/** Découpe une ligne de tableau sur les « | » qui ne sont PAS dans un code `...`. */
function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cur = "";
  let inCode = false;
  for (const ch of trimmed) {
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const caseIds = []; // { id, section, step }
let currentSection = "";

// --- blocs -----------------------------------------------------------------------------------------------------
function renderBlocks(src) {
  const lines = src.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    // bloc de code
    const fence = /^(\s*)```(\w*)\s*$/.exec(line);
    if (fence) {
      const indent = fence[1].length;
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i].slice(Math.min(indent, lines[i].length - lines[i].trimStart().length)));
        i += 1;
      }
      i += 1;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      if (level <= 2) currentSection = text.replace(/\s*\(.*\)\s*$/, "");
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i += 1;
      continue;
    }
    // tableau
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const isCases = /^ID$/i.test(head[0] ?? "");
      const body = rows
        .map((r) => {
          const id = r[0] ?? "";
          if (isCases && /^[A-Z]\d+(\.\d+)?$/.test(id)) caseIds.push({ id, section: currentSection, step: (r[1] ?? "").replace(/`/g, "").replace(/\*\*/g, "").replace(/\\"/g, '"').replace(/\s+/g, " ").slice(0, 96) });
          return `<tr>${r.map((c, k) => `<td${isCases && k === 0 ? ' class="cid"' : ""}>${inline(c)}</td>`).join("")}</tr>`;
        })
        .join("\n");
      out.push(`<table class="t${isCases ? " cases" : ""}"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>\n${body}\n</tbody></table>`);
      continue;
    }
    // liste (à puces ou numérotée), avec contenu imbriqué indenté
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m || m[1].length !== li[1].length) break;
        const buf = [m[3]];
        i += 1;
        while (i < lines.length && (lines[i].trim() === "" || /^\s{2,}/.test(lines[i])) && !(lines[i].trim() === "" && !(lines[i + 1] ?? "").startsWith("  "))) {
          buf.push(lines[i].replace(/^ {1,4}/, ""));
          i += 1;
        }
        items.push(buf.join("\n"));
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((b) => `<li>${renderItem(b)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }
    // paragraphe
    const buf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,3}\s|```|\||---+\s*$|\s*([-*]|\d+\.)\s)/.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

function renderItem(text) {
  const nl = text.indexOf("\n");
  if (nl === -1) return inline(text);
  return `${inline(text.slice(0, nl))}${renderBlocks(text.slice(nl + 1))}`;
}

const body = renderBlocks(md);

// --- couverture et sommaire ------------------------------------------------------------------------------------
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const now = new Date();
const longDate = `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
let commit = "";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  /* hors dépôt */
}
const toc = [...md.matchAll(/^(#{1,2})\s+(.*)$/gm)]
  .filter((m) => !/^Tests fonctionnels/.test(m[2]))
  .map((m) => `<li class="l${m[1].length}">${inline(m[2])}</li>`)
  .join("\n");

const cover = `
<section class="cover">
  <div class="hero"></div>
  <div class="coverbody">
    <div class="brand"><i></i>FUSION LEAP AI GROWTH</div>
    <div class="pill">Guide de recette · ${longDate}</div>
    <h1 class="ct">Tests fonctionnels<br>Phases 2 et 3</h1>
    <div class="lead">Projets, leads et deals, capture, import, assignation, synchronisation CRM, intégrations, webhooks e-mail, conversations et envoi sous contrôles : de J16 à J32.</div>
    <div class="facts">
      <div><b>${caseIds.length}</b><span>cas de test</span></div>
      <div><b>~5 h</b><span>durée estimée</span></div>
      <div><b>2</b><span>parties : interface, technique</span></div>
    </div>
    <div class="how"><h3>Comment utiliser ce guide</h3>
      <ol>
        <li>Préparer l'environnement et charger les données (section 0).</li>
        <li>Dérouler les cas dans l'ordre : chaque ligne indique les étapes et le <b>résultat attendu</b>.</li>
        <li>Noter <b>OK</b> ou <b>KO</b> dans la <b>fiche de résultats</b> (dernières pages).</li>
        <li>Pour chaque KO : identifiant du cas, ce qui a été fait et vu, capture d'écran.</li>
      </ol>
    </div>
    <div class="tocbox"><h3>Sommaire</h3><ul class="toc">${toc}</ul></div>
  </div>
</section>`;

// --- fiche de résultats ----------------------------------------------------------------------------------------
const bySection = new Map();
for (const c of caseIds) {
  if (!bySection.has(c.section)) bySection.set(c.section, []);
  bySection.get(c.section).push(c);
}
const sheet = `
<section class="sheet">
  <h1>Fiche de résultats</h1>
  <p>Cocher <b>OK</b> ou <b>KO</b> pour chaque cas. En cas de KO, détailler dans la colonne <b>Commentaire</b> (ce qui a été vu) et joindre une capture d'écran. Testeur : ____________________ Date : ____________ Version testée (commit) : ${commit || "________"}</p>
  ${[...bySection.entries()]
    .map(
      ([section, rows]) => `<h2>${inline(section)}</h2>
  <table class="t sheet"><thead><tr><th style="width:9%">Cas</th><th>Étape (début)</th><th style="width:6%">OK</th><th style="width:6%">KO</th><th style="width:26%">Commentaire</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td class="cid">${r.id}</td><td>${esc(r.step)}${r.step.length >= 96 ? "…" : ""}</td><td class="box"></td><td class="box"></td><td></td></tr>`).join("\n  ")}
  </tbody></table>`,
    )
    .join("\n  ")}
</section>`;

const css = `
@font-face{font-family:"SG";src:url("fonts/SpaceGrotesk.ttf");font-weight:300 700}
@font-face{font-family:"Plex";src:url("fonts/IBMPlexSans.ttf");font-weight:100 700}
@page{size:A4;margin:20mm 15mm 18mm 15mm;
  @top-left{content:"FUSION LEAP";font:700 8px "SG";letter-spacing:.14em;color:#17201a}
  @top-right{content:"Guide de tests · Phases 2 et 3";font:8px "Plex";color:#6b7569}
  @bottom-left{content:"Rapport du ${longDate}${commit ? ` · commit ${commit}` : ""}";font:8px "Plex";color:#6b7569}
  @bottom-right{content:counter(page) " / " counter(pages);font:8px "Plex";color:#6b7569}}
@page:first{margin:0;@top-left{content:none}@top-right{content:none}@bottom-left{content:none}@bottom-right{content:none}}
:root{--ink:#17201a;--ink2:#39453b;--muted:#6b7569;--line:#e3e8dd;--wash:#f7f9f3;--lime:#d0ff9b;--lime-soft:#eeffd9;--green:#2e7d1e;--green-fill:#8bd43a}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Plex",sans-serif;color:var(--ink);font-size:10px;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.cover{height:297mm;width:210mm;position:relative;overflow:hidden;page-break-after:always}
.hero{position:absolute;inset:0 0 auto 0;height:120mm;background:linear-gradient(#d0ff9b,#eeffd9 60%,#fff)}
.coverbody{position:relative;padding:16mm 16mm 0 16mm}
.brand{display:flex;align-items:center;gap:7px;font:700 10px "SG";letter-spacing:.14em}
.brand i{width:11px;height:11px;border-radius:3px;background:var(--green-fill);display:inline-block}
.pill{display:inline-block;background:var(--ink);color:#fff;border-radius:999px;padding:4px 12px;font-size:9px;font-weight:600;margin-top:16mm}
h1.ct{font:700 40px/1.02 "SG";letter-spacing:-.02em;margin-top:6mm}
.lead{max-width:150mm;margin-top:6mm;font-size:12px;color:var(--ink2)}
.facts{display:flex;gap:8px;margin-top:10mm}
.facts div{flex:1;background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.facts b{display:block;font:700 24px "SG";letter-spacing:-.02em}
.facts span{font-size:9px;color:var(--muted)}
.how,.tocbox{margin-top:8mm}
.how h3,.tocbox h3{font:700 12px "SG";margin-bottom:3mm}
.how ol{margin-left:5mm;font-size:10.5px;color:var(--ink2)}
.how li{margin:1.5mm 0}
.toc{list-style:none;columns:2;column-gap:8mm;font-size:9.5px}
.toc li{break-inside:avoid;margin:1.2mm 0;color:var(--ink2)}
.toc li.l1{font-weight:700;color:var(--ink);margin-top:3mm}
.toc li.l2{padding-left:3mm}
main{display:block}
h1{font:700 20px "SG";letter-spacing:-.01em;margin:9mm 0 3mm;color:var(--ink);break-after:avoid}
h2{font:700 15px "SG";letter-spacing:-.01em;margin:8mm 0 2.5mm;break-after:avoid;padding-bottom:1.5mm;border-bottom:1.5px solid var(--ink)}
h3{font:700 12px "SG";margin:5mm 0 2mm;break-after:avoid}
p{margin:2.5mm 0;color:var(--ink2)}
hr{border:0;border-top:1px solid var(--line);margin:6mm 0}
ul,ol{margin:2mm 0 2mm 5mm;color:var(--ink2)}
li{margin:1.2mm 0}
li pre{margin:2mm 0}
a{color:var(--green)}
strong{color:var(--ink)}
code{font-family:Consolas,"Courier New",monospace;background:var(--wash);border:1px solid var(--line);border-radius:3px;padding:0 3px;font-size:8.6px;word-break:break-word}
pre{background:#17201a;color:#e8f5da;border-radius:8px;padding:3mm 4mm;margin:3mm 0;white-space:pre-wrap;word-break:break-word;break-inside:avoid;font-size:8.3px;line-height:1.5}
pre code{background:none;border:0;padding:0;color:inherit;font-size:inherit}
table.t{width:100%;border-collapse:collapse;margin:3mm 0;font-size:9.2px}
table.t th{text-align:left;font-size:8px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:600;padding:0 3mm 1.5mm 0;border-bottom:1.5px solid var(--ink)}
table.t td{padding:2mm 3mm 2mm 0;border-bottom:1px solid var(--line);vertical-align:top;color:var(--ink2);word-break:break-word}
table.t tr{break-inside:avoid}
table.cases td:first-child,table.cases th:first-child{width:9mm}
td.cid{font:700 10px "SG";color:var(--green);white-space:nowrap}
table.cases th:nth-child(2){width:46%}
.sheet h1{margin-top:0}
section.sheet{break-before:page}
table.sheet td.box{border:1px solid #9aa596;width:9mm;height:7mm}
table.sheet td{padding:1.4mm 2mm 1.4mm 1mm;font-size:8.6px}
blockquote{border-left:3px solid var(--green-fill);background:var(--lime-soft);padding:2mm 4mm;margin:3mm 0;color:var(--ink2)}
`;

const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Guide de tests — Phases 2 et 3 (J16 à J32)</title><style>${css}</style></head><body>${cover}<main>${body}</main>${sheet}</body></html>`;

mkdirSync(tmpDir, { recursive: true });
const htmlPath = path.join(tmpDir, "_test-guide.html");
writeFileSync(htmlPath, html, "utf8");
console.log(`HTML : ${path.relative(root, htmlPath)} (${caseIds.length} cas de test)`);

if (!htmlOnly) {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const chrome = candidates.find((c) => existsSync(c));
  if (!chrome) {
    console.error("Chrome introuvable : définir CHROME_PATH (ou utiliser --html).");
    process.exit(1);
  }
  execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${outPdf}`, pathToFileURL(htmlPath).href], { stdio: "ignore" });
  console.log(`PDF  : ${path.relative(root, outPdf)}`);
}
