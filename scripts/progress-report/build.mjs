/**
 * Génère le rapport d'avancement (HTML + PDF) dans docs/progress/report/ à partir de
 * scripts/progress-report/data.json et de l'état du dépôt (date, commit, PR GitHub si `gh` est disponible).
 *
 *   pnpm report:progress            -> HTML + PDF du jour (le fichier du jour est remplacé)
 *   pnpm report:progress --html     -> HTML seulement (sans Chrome)
 *
 * Le PDF est produit par Chrome en mode headless (CHROME_PATH pour indiquer un autre exécutable).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const outDir = path.join(root, "docs/progress/report");
const htmlOnly = process.argv.includes("--html");

const data = JSON.parse(readFileSync(path.join(here, "data.json"), "utf8"));
const css = readFileSync(path.join(here, "styles.css"), "utf8");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fr = new Intl.NumberFormat("fr-FR");
const MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// --- état du dépôt -------------------------------------------------------------------------------------------
const now = new Date();
const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const longDate = `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
const commit = run("git", ["rev-parse", "--short", "HEAD"]);
const branch = run("git", ["branch", "--show-current"]);

let prs = { total: 0, merged: 0, open: 0 };
try {
  const list = JSON.parse(
    run("gh", ["pr", "list", "--state", "all", "--json", "state", "--limit", "200"]) || "[]",
  );
  prs = {
    total: list.length,
    merged: list.filter((p) => p.state === "MERGED").length,
    open: list.filter((p) => p.state === "OPEN").length,
  };
} catch {
  /* gh indisponible : les PR ne sont pas affichées */
}

// --- calculs -------------------------------------------------------------------------------------------------
const phaseStats = data.phases.map((p) => {
  const total = p.modules.reduce((n, m) => n + m.days, 0);
  const done = p.modules.reduce((n, m) => n + (m.days * m.progress) / 100, 0);
  return { id: p.id, total, done, percent: total === 0 ? 0 : Math.round((done * 100) / total) };
});
const totalDays = phaseStats.reduce((n, p) => n + p.total, 0);
const doneDays = Math.round(phaseStats.reduce((n, p) => n + p.done, 0) * 10) / 10;
const globalPercent = Math.round((doneDays * 1000) / totalDays) / 10;
const doneCount = Number.isInteger(doneDays)
  ? String(doneDays)
  : String(doneDays).replace(".", ",");
const testsTotal = data.tests.reduce((n, t) => n + t.value, 0);
const maxTest = Math.max(...data.tests.map((t) => t.value));
const lastDone =
  data.phases
    .flatMap((p) => p.modules)
    .filter((m) => m.progress === 100 && /^J\d+$/.test(m.day))
    .at(-1)?.day ?? "J0";

// --- fragments -----------------------------------------------------------------------------------------------
const CHIPS = {
  done: ["done", "Fait"],
  review: ["review", "En revue"],
  part: ["part", "À valider"],
  todo: ["todo", "À faire"],
};
const chip = (status) => `<span class="chip ${CHIPS[status][0]}">${CHIPS[status][1]}</span>`;
const bar = (percent) =>
  `<div class="pcell"><div class="pb"><i style="width:${percent}%"></i></div><b>${percent} %</b></div>`;

function moduleTable(modules, { dayColumn = true, lastHeader = "Remarque" } = {}) {
  const head = `<tr>${dayColumn ? '<th style="width:9%">Jour</th>' : ""}<th style="width:${dayColumn ? 27 : 32}%">Module</th><th style="width:22%">Avancement</th><th style="width:14%">Statut</th><th>${lastHeader}</th></tr>`;
  const rows = modules
    .map(
      (m) =>
        `<tr>${dayColumn ? `<td class="d">${esc(m.day)}</td>` : ""}<td class="n">${esc(m.name)}</td><td>${bar(m.progress)}</td><td>${chip(m.status)}</td><td class="note">${esc(m.note ?? "")}</td></tr>`,
    )
    .join("\n");
  return `<table class="m">${head}\n${rows}</table>`;
}

const footer = (n) =>
  `<div class="footer"><span>Fusion Leap AI Growth · rapport du ${iso}${commit ? ` · commit ${commit}` : ""}</span><span>${n}</span></div>`;
const phaseHeading = (phase, stat, small = true) =>
  `<div class="phase"><h2${small ? "" : ' style="font-size:15px;"'}>${esc(phase.title)} <small>${stat.total} jour${stat.total > 1 ? "s" : ""}</small></h2><div class="pp"${stat.percent === 0 ? ' style="color:#6b7569;"' : ""}>${stat.percent} %</div></div>`;

const byId = Object.fromEntries(
  data.phases.map((p, i) => [p.id, { phase: p, stat: phaseStats[i] }]),
);
const circumference = 339.3;
const dash = Math.round(((globalPercent * circumference) / 100) * 10) / 10;

const prStats =
  prs.total > 0
    ? `<div class="stat"><div class="n">${prs.total}</div><div class="l">PR créées<br>(${prs.merged} fusionnées, ${prs.open} en revue)</div></div>`
    : "";

// --- pages ---------------------------------------------------------------------------------------------------
const cover = `
<div class="page" style="padding-top:0.6in;">
  <div class="hero"></div>
  <div style="position:relative;">
    <div class="pill">Rapport du ${longDate}</div>
    <h1 style="margin-top:14px;">${esc(data.title).replace(" par ", "<br>par ")}</h1>
    <div class="body" style="max-width:5.1in; margin-top:12px;">${esc(data.intro)} Jours <b>J0 à ${lastDone}</b> réalisés sur ${totalDays}.</div>
    <div class="row" style="margin-top:0.35in;">
      <svg width="170" height="170" viewBox="0 0 140 140">
        <circle cx="70" cy="70" r="54" fill="none" stroke="#ECEFE6" stroke-width="16"/>
        <circle cx="70" cy="70" r="54" fill="none" stroke="#8BD43A" stroke-width="16" stroke-linecap="round" stroke-dasharray="${dash} ${circumference}" transform="rotate(-90 70 70)"/>
        <text x="70" y="68" text-anchor="middle" font-family="SG" font-weight="700" font-size="26" fill="#17201a">${String(globalPercent).replace(".", ",")} %</text>
        <text x="70" y="86" text-anchor="middle" font-family="Plex" font-size="9" fill="#6b7569">${doneCount} jours sur ${totalDays}</text>
      </svg>
      <div style="flex:1;">
        <div class="stats" style="margin-top:0;">
          <div class="stat"><div class="n">${doneCount} / ${totalDays}</div><div class="l">jours réalisés<br>(J0 → ${lastDone})</div></div>
          <div class="stat"><div class="n">${fr.format(testsTotal)}</div><div class="l">tests automatisés,<br>tous verts</div></div>
        </div>
        <div class="stats" style="margin-top:10px;">
          ${prStats}
          <div class="stat"><div class="n">${data.adrCount}</div><div class="l">ADR rédigés<br>(${data.adrAccepted} accepté${data.adrAccepted > 1 ? "s" : ""})</div></div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:0.3in;">
      <div class="ct">En une phrase</div>
      <div class="body">${esc(data.summary)}</div>
    </div>
    <div class="legend" style="margin-top:12px;">
      <span>${chip("done")}</span><span><span class="chip review">En revue (PR ouverte)</span></span><span>${chip("part")}</span><span>${chip("todo")}</span>
    </div>
    <h2 style="margin-top:0.35in;">Avancement par phase <small>jours réalisés</small></h2>
    ${data.phases
      .map((p, i) => {
        const s = phaseStats[i];
        const done = Number.isInteger(s.done)
          ? s.done
          : String(Math.round(s.done * 10) / 10).replace(".", ",");
        return `<div class="bar-h"><span class="lb">${esc(p.title.replace(" — ", " · "))}</span><span class="tr"><i style="width:${s.percent}%"></i></span><span class="v">${done} / ${s.total}</span></div>`;
      })
      .join("\n    ")}
  </div>
  ${footer(1)}
</div>`;

const p01 = `
<div class="page">
  ${phaseHeading(byId.p0.phase, byId.p0.stat)}
  ${moduleTable(byId.p0.phase.modules)}
  <div style="margin-top:20px;"></div>
  ${phaseHeading(byId.p1.phase, byId.p1.stat)}
  ${moduleTable(byId.p1.phase.modules, { lastHeader: "Livrable" })}
  ${footer(2)}
</div>`;

const p25 = `
<div class="page">
  <h2>Phases 2 à 5 — Modules produit <small>non commencés ou en cours</small></h2>
  <div class="sub">Ordre de priorité de la spec : isolation, CRM, inbox, campagnes, IA, rapports. Chaque jalon (G2 à G5) est une porte de qualité.</div>
  ${["p2", "p3", "p4", "p5"]
    .map(
      (id) =>
        `${phaseHeading(byId[id].phase, byId[id].stat, false)}\n  ${moduleTable(
          byId[id].phase.modules,
          { dayColumn: false, lastHeader: "Jalon / remarque" },
        ).replace(/<td class="n">/g, '<td class="n">')}`,
    )
    .join("\n  ")}
  ${footer(3)}
</div>`;

const extras = `
<div class="page">
  <h2>Réalisé en plus du plan <small>demandes du propriétaire du produit</small></h2>
  ${moduleTable(data.extras, { dayColumn: false, lastHeader: "Contenu" })}
  <div class="phase" style="margin-top:18px;"><h2>Qualité mesurée <small>tests automatisés, tous verts</small></h2><div class="pp">${fr.format(testsTotal)}</div></div>
  ${data.tests
    .map(
      (t) =>
        `<div class="bar-h"><span class="lb">${esc(t.label)}</span><span class="tr"><i style="width:${Math.max(1, Math.round((t.value * 100) / maxTest))}%"></i></span><span class="v">${fr.format(t.value)}</span></div>`,
    )
    .join("\n  ")}
  <div class="two" style="margin-top:12px;">
    <div class="card" style="margin:0;"><div class="ct">Contrôles automatiques</div><div class="body">${esc(data.controls)}</div></div>
    <div class="card" style="margin:0;"><div class="ct">Sécurité</div><div class="body">${esc(data.security)}</div></div>
  </div>
  ${footer(4)}
</div>`;

const last = `
<div class="page">
  <h2>Points ouverts et décisions à prendre</h2>
  <div class="sub">À traiter par la responsable technique ou le propriétaire du produit.</div>
  ${data.openPoints.map((t) => `<div class="ti">${esc(t)}</div>`).join("\n  ")}
  <h2 style="margin-top:20px;">Prochaines étapes</h2>
  <table class="m"><tr><th style="width:16%">Quand</th><th>Action</th></tr>
  ${data.nextSteps.map((s) => `<tr><td class="d">${esc(s.when)}</td><td>${esc(s.action)}</td></tr>`).join("\n  ")}</table>
  <div class="card">
    <div class="ct">Comment lire ce rapport</div>
    <div class="body">Avancement d'un module = part de ses livrables terminés et vérifiés. <b>100 %</b> = code, tests et documentation livrés ; « En revue » = PR ouverte, pas encore fusionnée. Avancement global = jours réalisés sur ${totalDays} (${doneCount} ÷ ${totalDays} = ${String(globalPercent).replace(".", ",")} %). Rapport régénéré à chaque commit (<code>pnpm report:progress</code>${branch ? `, branche <code>${esc(branch)}</code>` : ""}). Sources : <code>docs/progress/journal.md</code>, <code>docs/plan/development-plan.md</code>, <code>scripts/progress-report/data.json</code>.</div>
  </div>
  ${footer(5)}
</div>`;

const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Fusion Leap AI Growth — Rapport d'avancement par module (${longDate})</title>
<style>
${css}
</style>
</head>
<body>
${cover}
${p01}
${p25}
${extras}
${last}
</body>
</html>
`;

// --- écriture ------------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, `progress-report_${iso}.html`);
const pdfPath = path.join(outDir, `Rapport-avancement_${iso}.pdf`);
writeFileSync(htmlPath, html, "utf8");
console.log(
  `HTML : ${path.relative(root, htmlPath)} (${String(globalPercent).replace(".", ",")} %, ${doneCount}/${totalDays} jours, ${fr.format(testsTotal)} tests)`,
);

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
  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ],
    { stdio: "ignore" },
  );
  console.log(`PDF  : ${path.relative(root, pdfPath)}`);
}
