/**
 * Génère le rapport d'avancement (HTML + PDF) dans docs/progress/report/ à partir de
 * scripts/progress-report/data.json, de l'historique (history.json) et de l'état du dépôt (date, commit, PR GitHub si `gh` est disponible,
 * ADR de docs/adr).
 *
 *   pnpm report:progress            -> PDF du jour ; c'est le SEUL rapport gardé dans le dossier (anciens PDF et sources HTML supprimés)
 *   pnpm report:progress --html     -> HTML seulement (sans Chrome ; rien n'est supprimé)
 *
 * Le PDF est produit par Chrome en mode headless (CHROME_PATH pour indiquer un autre exécutable).
 * history.json garde une ligne par jour (avancement, jours, tests) : il alimente « depuis le dernier rapport » et les courbes.
 *
 * Mise en page (21 novembre 2026) : A4, aux couleurs de l'application (menthe, teal, noir, police Inter).
 *  - lecture (5 pages) : synthèse · dernières livraisons · ce qui reste · points ouverts · qualité ;
 *  - annexes (3 pages) : détail des phases 0 à 5, réalisé en plus du plan et fonctions disponibles.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const outDir = path.join(root, "docs/progress/report");
const htmlOnly = process.argv.includes("--html");

const data = JSON.parse(readFileSync(path.join(here, "data.json"), "utf8"));
const css = readFileSync(path.join(here, "styles.css"), "utf8");
const historyPath = path.join(here, "history.json");
const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : [];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fr = new Intl.NumberFormat("fr-FR");
const dec = (n) => String(n).replace(".", ",");
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const SHORT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// --- état du dépôt -------------------------------------------------------------------------------------------
const now = new Date();
const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const longDate = `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
const commit = run("git", ["rev-parse", "--short", "HEAD"]);

let prs = { total: 0, merged: 0, open: 0 };
try {
  const list = JSON.parse(run("gh", ["pr", "list", "--state", "all", "--json", "state", "--limit", "200"]) || "[]");
  prs = { total: list.length, merged: list.filter((p) => p.state === "MERGED").length, open: list.filter((p) => p.state === "OPEN").length };
} catch {
  /* gh indisponible : les PR ne sont pas affichées */
}

// ADR : nombre total et acceptés (ligne « Statut » de chaque fichier)
const adrDir = path.join(root, "docs/adr");
let adrTotal = data.adrCount;
let adrAccepted = data.adrAccepted;
if (existsSync(adrDir)) {
  const files = readdirSync(adrDir).filter((f) => /^\d{3}-.*\.md$/.test(f));
  adrTotal = files.length;
  adrAccepted = files.filter((f) => /\*\*Statut\s*:\*\*\s*Accepted/i.test(readFileSync(path.join(adrDir, f), "utf8").split("\n").slice(0, 12).join("\n"))).length;
}

// --- calculs -------------------------------------------------------------------------------------------------
const phaseStats = data.phases.map((p) => {
  const total = p.modules.reduce((n, m) => n + m.days, 0);
  const done = p.modules.reduce((n, m) => n + (m.days * m.progress) / 100, 0);
  const counts = { done: 0, part: 0, review: 0, todo: 0 };
  for (const m of p.modules) counts[m.status] += 1;
  return { id: p.id, total, done, percent: total === 0 ? 0 : Math.round((done * 100) / total), counts };
});
const totalDays = phaseStats.reduce((n, p) => n + p.total, 0);
const doneDays = Math.round(phaseStats.reduce((n, p) => n + p.done, 0) * 10) / 10;
const globalPercent = Math.round((doneDays * 1000) / totalDays) / 10;
const testsTotal = data.tests.reduce((n, t) => n + t.value, 0);
const maxTest = Math.max(...data.tests.map((t) => t.value));
const allModules = data.phases.flatMap((p) => p.modules);
const modulesDone = allModules.filter((m) => m.status === "done").length;
const reviews = data.recent.filter((r) => r.review); // `review: false` = revue pas encore faite : exclue du tableau des revues

// historique : une ligne par jour ; « depuis le dernier rapport » = la dernière ligne d'un jour antérieur
const today = { date: iso, percent: globalPercent, days: doneDays, totalDays, tests: testsTotal };
const timeline = [...history.filter((h) => h.date !== iso), today].sort((a, b) => a.date.localeCompare(b.date));
const previous = [...history].filter((h) => h.date < iso).at(-1) ?? null;
writeFileSync(historyPath, `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
const dateLabel = (d) => {
  const [, m, day] = d.split("-").map(Number);
  return `${day} ${SHORT[m - 1]}`;
};
const sign = (n, unit, plural = unit) => (n === 0 ? `0 ${unit}` : `${n > 0 ? "+" : "−"}${dec(Math.abs(Math.round(n * 10) / 10))} ${Math.abs(n) > 1 ? plural : unit}`);
const dPercent = previous ? Math.round((globalPercent - previous.percent) * 10) / 10 : 0;
const dTests = previous && previous.tests ? testsTotal - previous.tests : 0;
const remaining = Math.round((totalDays - doneDays) * 10) / 10;

// --- fragments -----------------------------------------------------------------------------------------------
const CHIPS = { done: ["done", "Fait"], review: ["review", "En revue"], part: ["part", "À valider"], todo: ["todo", "À faire"] };
const chip = (status) => `<span class="chip ${CHIPS[status][0]}">${CHIPS[status][1]}</span>`;
const bar = (percent) => `<div class="pcell"><div class="track"><i style="width:${percent}%"></i></div><b>${percent} %</b></div>`;

function moduleTable(modules, { dayColumn = true, lastHeader = "Livrable" } = {}) {
  const head = `<tr>${dayColumn ? '<th style="width:11%">Jour</th>' : ""}<th style="width:${dayColumn ? 25 : 33}%">Module</th><th style="width:19%">Avancement</th><th style="width:10%">Statut</th><th>${lastHeader}</th></tr>`;
  const rows = modules
    .map(
      (m) =>
        `<tr>${dayColumn ? `<td class="d">${esc(m.day)}</td>` : ""}<td class="n">${esc(m.name)}</td><td>${bar(m.progress)}</td><td>${chip(m.status)}</td><td class="note">${esc(m.note ?? "")}</td></tr>`,
    )
    .join("\n");
  return `<table>${head}\n${rows}</table>`;
}

const circumference = 2 * Math.PI * 54;
/** Anneau d'avancement (fond sombre : pistes translucides, arc menthe). */
function ring(percent, size, label) {
  const dash = Math.round(((percent * circumference) / 100) * 10) / 10;
  return `<svg width="${size}" height="${size}" viewBox="0 0 140 140">
    <circle cx="70" cy="70" r="54" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="14"/>
    <circle cx="70" cy="70" r="54" fill="none" stroke="#00d4a4" stroke-width="14" stroke-linecap="round" stroke-dasharray="${dash} ${circumference.toFixed(1)}" transform="rotate(-90 70 70)"/>
    <text x="70" y="68" text-anchor="middle" font-family="Inter" font-weight="700" font-size="25" fill="#ffffff">${dec(percent)} %</text>
    <text x="70" y="86" text-anchor="middle" font-family="Inter" font-size="8.6" fill="rgba(255,255,255,0.72)">${esc(label)}</text>
  </svg>`;
}

/** Courbe de l'avancement global : une ligne par jour de l'historique, repère quand le plan change de taille. */
function progressChart() {
  const W = 700;
  const H = 135;
  const L = 34;
  const R = 12;
  const T = 12;
  const B = 24;
  const pts = timeline.map((h) => ({ ...h, t: Date.parse(`${h.date}T00:00:00Z`) }));
  const t0 = pts[0].t;
  const t1 = Math.max(pts.at(-1).t, t0 + 86400000);
  const ymax = Math.ceil((Math.max(...pts.map((p) => p.percent)) + 5) / 10) * 10;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - v / ymax) * (H - T - B);
  const grid = [];
  for (let v = 0; v <= ymax; v += 10) grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#edf0f2"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end" font-size="8" fill="#5d6671">${v} %</text>`);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)} ${y(p.percent).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.at(-1).t).toFixed(1)} ${y(0)} L${x(pts[0].t).toFixed(1)} ${y(0)} Z`;
  const marks = [];
  pts.forEach((p, i) => {
    if (i > 0 && p.totalDays !== pts[i - 1].totalDays) {
      const px = (x(p.t) + x(pts[i - 1].t)) / 2;
      marks.push(`<line x1="${px}" x2="${px}" y1="${T}" y2="${H - B}" stroke="#c9a227" stroke-dasharray="3 3"/><text x="${px + 4}" y="${T + 8}" font-size="8" fill="#7a5300">plan de ${pts[i - 1].totalDays} à ${p.totalDays} jours</text>`);
    }
  });
  const dots = pts
    .map((p, i) => {
      const last = i === pts.length - 1;
      const showValue = i === 0 || last || p.percent !== pts[i - 1].percent;
      const label = !showValue ? "" : `<text x="${(x(p.t) + (i === 0 ? 6 : 0)).toFixed(1)}" y="${(y(p.percent) + (i === 0 ? 17 : -8)).toFixed(1)}" text-anchor="${last ? "end" : i === 0 ? "start" : "middle"}" font-weight="700" font-size="8.6" fill="#0a0a0a">${dec(p.percent)} %</text>`;
      return `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.percent).toFixed(1)}" r="${last ? 4.5 : 3}" fill="${last ? "#00775f" : "#00d4a4"}" stroke="#fff" stroke-width="1.5"/>${label}<text x="${x(p.t).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="8" fill="#5d6671">${dateLabel(p.date)}</text>`;
    })
    .join("");
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Inter">${grid.join("")}<path d="${area}" fill="#00d4a4" opacity="0.14"/><path d="${line}" fill="none" stroke="#00b48a" stroke-width="2.4"/>${marks.join("")}${dots}</svg>`;
}

/** Colonnes : nombre de tests à chaque date de l'historique. */
function testsChart() {
  const pts = timeline.filter((h) => h.tests);
  const W = 340;
  const H = 190;
  const L = 8;
  const B = 20;
  const T = 16;
  const max = Math.max(...pts.map((p) => p.tests));
  const slot = (W - L * 2) / pts.length;
  const bw = Math.min(30, slot * 0.62);
  const cols = pts
    .map((p, i) => {
      const h = ((H - T - B) * p.tests) / max;
      const cx = L + slot * i + slot / 2;
      const last = i === pts.length - 1;
      return `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${last ? "#00775f" : "#00d4a4"}"/><text x="${cx.toFixed(1)}" y="${(H - B - h - 4).toFixed(1)}" text-anchor="middle" font-weight="700" font-size="8" fill="#0a0a0a">${fr.format(p.tests)}</text>${(i % 3 === 0 && pts.length - 1 - i > 1) || last ? `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="7.4" fill="#5d6671">${dateLabel(p.date)}</text>` : ""}`;
    })
    .join("");
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Inter">${cols}</svg>`;
}

const sevChips = (r) =>
  [
    r.blocking > 0 ? `<span class="sev b">${r.blocking} bloquant${r.blocking > 1 ? "s" : ""}</span>` : `<span class="sev n">0 bloquant</span>`,
    `<span class="sev m">${r.major} majeur${r.major > 1 ? "s" : ""}</span>`,
    `<span class="sev m">${r.medium} moyen${r.medium > 1 ? "s" : ""}</span>`,
  ].join(" ");

const urgent = (u) => (/^Avant (C3|J34|le premier|G3|un client)/.test(u) ? "hot" : "todo");
const nextMilestone = data.milestones.find((m) => m.status !== "done" && /\d{4}/.test(m.when));
const phaseLabel = (title) => title.replace(" — ", " · ");
/** Échappe puis met en forme les `fragments de code` des textes. */
const rich = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>");

// --- pages ---------------------------------------------------------------------------------------------------
const pages = [];
const page = (title, body, { cls = "", hero = "" } = {}) => pages.push({ title, body, cls, hero });

// 1. synthèse
page(
  "Synthèse",
  `
  <div class="kpis">
    <div class="kpi hl"><div class="n">${dec(doneDays)} / ${totalDays}</div><div class="l">jours du plan réalisés</div></div>
    <div class="kpi"><div class="n">${fr.format(testsTotal)}</div><div class="l">tests automatiques, tous verts</div></div>
    <div class="kpi"><div class="n">${modulesDone} / ${allModules.length}</div><div class="l">modules terminés</div></div>
    <div class="kpi"><div class="n">${prs.total > 0 ? `${prs.merged} / ${prs.total}` : "—"}</div><div class="l">PR fusionnées${prs.open > 0 ? ` (${prs.open} ouverte${prs.open > 1 ? "s" : ""})` : ""}</div></div>
  </div>
  <div class="brief">
    <div class="kicker">En bref</div>
    <h2 style="margin-top:1mm;">${esc(data.brief.headline)}</h2>
    <ul>${data.brief.bullets.map((b) => `<li><span>${esc(b)}</span></li>`).join("")}</ul>
  </div>
  ${
    previous && (dPercent !== 0 || dTests !== 0)
      ? `<div class="since">Depuis le ${dateLabel(previous.date)} : <b>${sign(dPercent, "point")}</b> d'avancement · <b>${sign(dTests, "test")}</b> · ${adrAccepted} / ${adrTotal} décisions d'architecture (ADR) acceptées.</div>`
      : ""
  }
  <div class="phases">
    <h2>Avancement par phase <small>jours réalisés</small></h2>
    ${data.phases
      .map((p, i) => {
        const s = phaseStats[i];
        const done = Number.isInteger(s.done) ? s.done : dec(Math.round(s.done * 10) / 10);
        const state = s.percent === 100 ? chip("done") : s.percent === 0 ? chip("todo") : '<span class="chip part">En cours</span>';
        return `<div class="ph"><span class="nm">${esc(phaseLabel(p.title))}</span><span class="track${s.percent === 0 ? " dim" : ""}"><i style="width:${s.percent}%"></i></span><span class="v">${done} / ${s.total} j</span><span>${state}</span></div>`;
      })
      .join("\n    ")}
  </div>`,
  {
    cls: "cover",
    hero: `<div class="hero">
      <div style="flex:1;">
        <div class="top"><span class="brand"><i></i>FUSION LEAP</span><span>Synthèse · ${longDate}</span></div>
        <span class="pill">Rapport du ${longDate}</span>
        <h1>Rapport<br>d'avancement</h1>
        <div class="tag">Fusion Leap AI Growth : plateforme SaaS multi-tenant de croissance (CRM, canaux, campagnes, agents IA).</div>
      </div>
      <div class="ringbox">${ring(globalPercent, 150, `${dec(doneDays)} jours sur ${totalDays}`)}</div>
    </div>`,
  },
);

// 2. dernières livraisons
page(
  "Dernières livraisons",
  `
  <h2>Dernières livraisons</h2>
  <div class="sub">Les quatre dernières livraisons, avec la preuve que ça marche. Chaque livraison est vérifiée par des tests ; le détail de toutes les livraisons est dans le CHANGELOG.</div>
  ${data.recent
    .slice(-4)
    .map(
      (r) => `<div class="day"><div class="hd"><span class="dn">${esc(r.day)}</span><h3>${esc(r.title)}</h3></div>
    <ul>${r.items.map((t) => `<li>${rich(t)}</li>`).join("")}</ul>
    <div class="ft">Preuves : ${rich(r.proof)}${r.review ? ` · Revue de sécurité : ${sevChips(r.review)}` : ""}</div></div>`,
    )
    .join("\n  ")}`,
);

// 3. ce qui reste
page(
  "Ce qui reste",
  `
  <h2>Ce qui reste à faire</h2>
  <div class="sub">Les prochaines étapes, dans l'ordre, et les jalons du projet.</div>
  <div class="steps">
    ${data.nextSteps.map((s) => `<div class="step"><span class="w">${esc(s.when)}</span><p>${esc(s.action)}</p></div>`).join("\n    ")}
  </div>
  <div class="sec">
    <h2>Jalons <small>portes de qualité : on ne les franchit qu'avec les preuves</small></h2>
    <div class="tl">
      ${data.milestones.map((m) => `<div class="ms ${m.status}"><b>${esc(m.label)}</b><span class="w">${esc(m.when)}</span>${esc(m.note)}</div>`).join("\n      ")}
    </div>
  </div>
  <div class="sec chart">
    <div class="ct">Avancement global au fil des jours</div>
    <div class="cs">Part des ${totalDays} jours du plan réalisés, à chaque rapport. Il reste ${dec(remaining)} jours${nextMilestone ? ` ; prochain jalon daté : ${esc(nextMilestone.label)} (${esc(nextMilestone.when)})` : ""}.</div>
    ${progressChart()}
  </div>
  <div class="sec cols">
    <div class="cap ok"><h3>Déjà possible</h3><ul>${data.capabilities.ready.slice(-3).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    <div class="cap no"><h3>Pas encore possible</h3><ul>${data.capabilities.notYet.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
  </div>`,
);

// 4. points ouverts
page(
  "Points ouverts",
  `
  <h2>Points ouverts et décisions <small>${data.openPoints.length} points</small></h2>
  <div class="sub">À traiter par la responsable technique, le propriétaire du produit ou l'équipe. En rouge : ce qui bloque une étape proche.</div>
  <div class="dech"><span>#</span><span>Point</span><span>Qui</span><span>Échéance</span></div>
  ${data.openPoints.map((p, i) => `<div class="dec"><span class="i">${i + 1}</span><span>${esc(p.text)}</span><span class="o">${esc(p.owner)}</span><span><span class="chip ${urgent(p.urgency)}">${esc(p.urgency)}</span></span></div>`).join("\n  ")}`,
);

// 5. qualité
page(
  "Qualité et sécurité",
  `
  <h2>Qualité mesurée <small>${fr.format(testsTotal)} tests automatiques, tous verts${previous && previous.tests && dTests !== 0 ? ` (${sign(dTests, "test")} depuis le ${dateLabel(previous.date)})` : ""}</small></h2>
  <div class="cols" style="grid-template-columns:1.2fr 1fr; margin-top:4mm;">
    <div class="chart">
      <div class="ct">Tests par catégorie</div>
      <div class="cs">Ce que couvre chaque ligne.</div>
      ${data.tests
        .map(
          (t) =>
            `<div class="bar-h"><span class="lb">${esc(t.label)}</span><span class="track"><i style="width:${Math.max(1, Math.round((t.value * 100) / maxTest))}%"></i></span><span class="v">${fr.format(t.value)}</span></div>`,
        )
        .join("\n      ")}
    </div>
    <div class="chart">
      <div class="ct">Tests au fil des jours</div>
      <div class="cs">Total à chaque rapport.</div>
      ${testsChart()}
    </div>
  </div>
  <div class="sec cols">
    <div class="card"><div class="ct">Contrôles automatiques</div><div class="body">${esc(data.controls)}</div></div>
    <div class="card"><div class="ct">Sécurité</div><div class="body">${esc(data.security)}</div></div>
  </div>
  ${
    reviews.length === 0
      ? ""
      : `<div class="sec">
    <h2>Revues de sécurité adverses <small>failles trouvées avant la fusion</small></h2>
    <table style="margin-top:3mm;"><tr><th style="width:12%">Jour</th><th>Sujet</th><th style="width:44%">Résultat</th></tr>
    ${reviews.map((r) => `<tr><td class="d">${esc(r.day)}</td><td class="n">${esc(r.title)}</td><td>${sevChips(r.review)}</td></tr>`).join("\n    ")}</table>
    <div class="legend">Toutes ces failles sont corrigées avant la fusion, avec un test qui la reproduit. Un bloquant empêche la fusion ; un majeur est corrigé le jour même.</div>
  </div>`
  }
  <div class="legend" style="margin-top:6mm;">Comment lire les statuts : ${chip("done")} fusionné dans la branche principale · ${chip("review")} PR ouverte · ${chip("part")} fait, en attente d'une décision · ${chip("todo")} à faire. Avancement d'un module = part de ses livrables terminés et vérifiés ; 100 % = code, tests et documentation livrés.</div>`,
);

// annexes
page(
  "Annexe · phases 0 et 1",
  `
  <span class="annex-tag">Annexe</span>
  <div class="phase"><h2>${esc(data.phases[0].title)} <small>${phaseStats[0].total} jours</small></h2><div class="pp">${phaseStats[0].percent} %</div></div>
  ${moduleTable(data.phases[0].modules)}
  <div class="phase"><h2>${esc(data.phases[1].title)} <small>${phaseStats[1].total} jours</small></h2><div class="pp">${phaseStats[1].percent} %</div></div>
  ${moduleTable(data.phases[1].modules)}`,
);
page(
  "Annexe · phases 2 et 3",
  `
  <span class="annex-tag">Annexe</span>
  ${data.phases
    .slice(2, 4)
    .map(
      (p, i) =>
        `<div class="phase"><h2>${esc(p.title)} <small>${phaseStats[i + 2].total} jours</small></h2><div class="pp">${phaseStats[i + 2].percent} %</div></div>\n  ${moduleTable(p.modules)}`,
    )
    .join("\n  ")}`,
);
page(
  "Annexe · phases 4 et 5",
  `
  <span class="annex-tag">Annexe</span>
  ${data.phases
    .slice(4)
    .map(
      (p, i) =>
        `<div class="phase"><h2>${esc(p.title)} <small>${phaseStats[i + 4].total} jours</small></h2><div class="pp" style="color:#5d6671;">${phaseStats[i + 4].percent} %</div></div>\n  ${moduleTable(p.modules)}`,
    )
    .join("\n  ")}
  <div class="sec cap ok wide"><h3>Toutes les fonctions disponibles <small style="font-weight:500;color:#5d6671;">${data.capabilities.ready.length} fonctions</small></h3><ul>${data.capabilities.ready.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`,
);
page(
  "Annexe · en plus du plan",
  `
  <span class="annex-tag">Annexe</span>
  <div class="phase"><h2>Réalisé en plus du plan <small>demandes du propriétaire du produit</small></h2></div>
  <table><tr><th style="width:34%">Module</th><th style="width:10%">Statut</th><th>Contenu</th></tr>
  ${data.extras.map((m) => `<tr><td class="n">${esc(m.name)}</td><td>${chip(m.status)}</td><td class="note">${esc(m.note ?? "")}</td></tr>`).join("\n  ")}</table>`,
);

const total = pages.length;
const rendered = pages
  .map(
    (p, i) => `
<div class="page ${p.cls}">
  ${p.hero || `<div class="top"><span class="brand"><i></i>FUSION LEAP</span><span>${esc(p.title)} · ${longDate}</span></div>`}
  ${p.body}
  <div class="footer"><span>Fusion Leap AI Growth · rapport du ${iso}${commit ? ` · commit ${commit}` : ""}</span><span>${i + 1} / ${total}</span></div>
</div>`,
  )
  .join("\n");

const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Fusion Leap AI Growth — Rapport d'avancement (${longDate})</title>
<style>
${css}
</style>
</head>
<body>
${rendered}
</body>
</html>
`;

// --- écriture ------------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, `progress-report_${iso}.html`);
const pdfPath = path.join(outDir, `Rapport-avancement_${iso}.pdf`);
writeFileSync(htmlPath, html, "utf8");
console.log(`HTML : ${path.relative(root, htmlPath)} (${dec(globalPercent)} %, ${dec(doneDays)}/${totalDays} jours, ${fr.format(testsTotal)} tests, ${total} pages)`);

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
  execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href], { stdio: "ignore" });
  console.log(`PDF  : ${path.relative(root, pdfPath)}`);
  // un seul rapport dans le dossier : le PDF du jour. Les anciens PDF et toutes les sources HTML (régénérables) sont supprimés ; l'historique est dans git.
  for (const f of readdirSync(outDir)) {
    const isOldPdf = /^Rapport-avancement_\d{4}-\d{2}-\d{2}\.pdf$/.test(f) && f !== path.basename(pdfPath);
    const isHtml = /^progress-report_\d{4}-\d{2}-\d{2}\.html$/.test(f);
    if (isOldPdf || isHtml) rmSync(path.join(outDir, f));
  }
}
