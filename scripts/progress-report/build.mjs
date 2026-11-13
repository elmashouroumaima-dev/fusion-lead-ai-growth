/**
 * Génère le rapport d'avancement (HTML + PDF) dans docs/progress/report/ à partir de
 * scripts/progress-report/data.json, de l'historique (history.json) et de l'état du dépôt (date, commit, PR GitHub si `gh` est disponible,
 * ADR de docs/adr).
 *
 *   pnpm report:progress            -> HTML + PDF du jour (le fichier du jour est remplacé)
 *   pnpm report:progress --html     -> HTML seulement (sans Chrome)
 *
 * Le PDF est produit par Chrome en mode headless (CHROME_PATH pour indiquer un autre exécutable).
 * history.json garde une ligne par jour (avancement, jours, tests) : il alimente « depuis le dernier rapport » et les courbes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const branch = run("git", ["branch", "--show-current"]);

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
// dernier jour réalisé : début du module + part de ses jours réalisés (J31–J33 à 67 % = J32), modules « J30b… » exclus
const lastDone = `J${Math.max(
  0,
  ...allModules.filter((m) => m.progress > 0).map((m) => {
    const start = /^J(\d+)(?:–|-|$)/.exec(m.day);
    return start ? Number(start[1]) + Math.max(1, Math.round((m.days * m.progress) / 100)) - 1 : 0;
  }),
)}`;
const reviews = data.recent.filter((r) => r.review);
const findings = reviews.reduce((n, r) => n + r.review.blocking + r.review.major + r.review.medium, 0);

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
const dDays = previous ? Math.round((doneDays - previous.days) * 10) / 10 : 0;
const dTests = previous && previous.tests ? testsTotal - previous.tests : 0;

// --- fragments -----------------------------------------------------------------------------------------------
const CHIPS = { done: ["done", "Fait"], review: ["review", "En revue"], part: ["part", "À valider"], todo: ["todo", "À faire"] };
const chip = (status) => `<span class="chip ${CHIPS[status][0]}">${CHIPS[status][1]}</span>`;
const bar = (percent) => `<div class="pcell"><div class="pb"><i style="width:${percent}%"></i></div><b>${percent} %</b></div>`;

function moduleTable(modules, { dayColumn = true, lastHeader = "Livrable" } = {}) {
  const head = `<tr>${dayColumn ? '<th style="width:11%">Jour</th>' : ""}<th style="width:${dayColumn ? 26 : 34}%">Module</th><th style="width:17%">Avancement</th><th style="width:10%">Statut</th><th>${lastHeader}</th></tr>`;
  const rows = modules
    .map(
      (m) =>
        `<tr>${dayColumn ? `<td class="d">${esc(m.day)}</td>` : ""}<td class="n">${esc(m.name)}</td><td>${bar(m.progress)}</td><td>${chip(m.status)}</td><td class="note">${esc(m.note ?? "")}</td></tr>`,
    )
    .join("\n");
  return `<table class="m">${head}\n${rows}</table>`;
}

const circumference = 2 * Math.PI * 54;
function ring(percent, size, label) {
  const dash = Math.round(((percent * circumference) / 100) * 10) / 10;
  return `<svg width="${size}" height="${size}" viewBox="0 0 140 140">
    <circle cx="70" cy="70" r="54" fill="none" stroke="#ffffff" stroke-width="16"/>
    <circle cx="70" cy="70" r="54" fill="none" stroke="#ECEFE6" stroke-width="16"/>
    <circle cx="70" cy="70" r="54" fill="none" stroke="#8BD43A" stroke-width="16" stroke-linecap="round" stroke-dasharray="${dash} ${circumference.toFixed(1)}" transform="rotate(-90 70 70)"/>
    <text x="70" y="70" text-anchor="middle" font-family="SG" font-weight="700" font-size="23" fill="#17201a">${dec(percent)} %</text>
    <text x="70" y="88" text-anchor="middle" font-family="Plex" font-size="9" fill="#6b7569">${esc(label)}</text>
  </svg>`;
}

/** Courbe de l'avancement global : une ligne par jour de l'historique, repère quand le plan change de taille. */
function progressChart() {
  const W = 700;
  const H = 215;
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
  for (let v = 0; v <= ymax; v += 10) grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#eef1e9"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end" font-size="8" fill="#6b7569">${v} %</text>`);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)} ${y(p.percent).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.at(-1).t).toFixed(1)} ${y(0)} L${x(pts[0].t).toFixed(1)} ${y(0)} Z`;
  const marks = [];
  pts.forEach((p, i) => {
    if (i > 0 && p.totalDays !== pts[i - 1].totalDays) {
      const px = (x(p.t) + x(pts[i - 1].t)) / 2;
      marks.push(`<line x1="${px}" x2="${px}" y1="${T}" y2="${H - B}" stroke="#c9a227" stroke-dasharray="3 3"/><text x="${px + 4}" y="${T + 8}" font-size="8" fill="#7a5600">plan de ${pts[i - 1].totalDays} à ${p.totalDays} jours</text>`);
    }
  });
  const dots = pts
    .map((p, i) => {
      const last = i === pts.length - 1;
      const label = `<text x="${(x(p.t) + (i === 0 ? 6 : 0)).toFixed(1)}" y="${(y(p.percent) + (i === 0 ? 17 : -8)).toFixed(1)}" text-anchor="${last ? "end" : i === 0 ? "start" : "middle"}" font-family="SG" font-weight="700" font-size="9" fill="#17201a">${dec(p.percent)} %</text>`;
      return `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.percent).toFixed(1)}" r="${last ? 4.5 : 3}" fill="${last ? "#2e7d1e" : "#8bd43a"}" stroke="#fff" stroke-width="1.5"/>${label}<text x="${x(p.t).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="8" fill="#6b7569">${dateLabel(p.date)}</text>`;
    })
    .join("");
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Plex">${grid.join("")}<path d="${area}" fill="#8bd43a" opacity="0.18"/><path d="${line}" fill="none" stroke="#2e7d1e" stroke-width="2.2" stroke-linejoin="round"/>${marks.join("")}${dots}</svg>`;
}

/** Colonnes : nombre de tests à chaque date de l'historique. */
function testsChart() {
  const pts = timeline.filter((h) => h.tests);
  const W = 340;
  const H = 235;
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
      return `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${last ? "#2e7d1e" : "#8bd43a"}"/><text x="${cx.toFixed(1)}" y="${(H - B - h - 4).toFixed(1)}" text-anchor="middle" font-family="SG" font-weight="700" font-size="8.5" fill="#17201a">${fr.format(p.tests)}</text><text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="8" fill="#6b7569">${dateLabel(p.date)}</text>`;
    })
    .join("");
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Plex">${cols}</svg>`;
}

const sevChips = (r) =>
  [
    r.blocking > 0 ? `<span class="sev b">${r.blocking} bloquant${r.blocking > 1 ? "s" : ""}</span>` : `<span class="sev n">0 bloquant</span>`,
    `<span class="sev m">${r.major} majeur${r.major > 1 ? "s" : ""}</span>`,
    `<span class="sev m">${r.medium} moyen${r.medium > 1 ? "s" : ""}</span>`,
  ].join(" ");

const highlights = [
  { k: "Fusion", t: prs.total > 0 ? `${prs.merged} PR fusionnées` : "Travail intégré", p: "Tout le travail de J0 à " + lastDone + " est dans la branche principale, un commit par sujet." },
  { k: "Envoi sous contrôles", t: "15 contrôles avant chaque e-mail", p: "Approbation humaine obligatoire, puis contrôle final juste avant l'appel au fournisseur." },
  { k: "Réception sûre", t: "Aucun contact créé par un inconnu", p: "Une réponse est rattachée à la bonne conversation ; un expéditeur inconnu ou usurpé va dans une file de tri." },
];
const remaining = Math.round((totalDays - doneDays) * 10) / 10;
const nextMilestone = data.milestones.find((m) => m.status !== "done" && /\d{4}/.test(m.when));

// --- pages ---------------------------------------------------------------------------------------------------
const pages = [];
const page = (title, body, cls = "") => pages.push({ title, body, cls });

// 1. couverture
page(
  "Synthèse",
  `
  <div class="hero"></div>
  <div class="rel">
    <span class="pill">Rapport du ${longDate}</span>
    <h1 style="margin-top:16px;">Rapport<br>d'avancement</h1>
    <div class="lead" style="max-width:5.4in; margin-top:12px;">${esc(data.intro)} Jours <b>J0 à ${lastDone}</b> réalisés sur ${totalDays}.</div>
    <div class="coverrow">
      ${ring(globalPercent, 168, `${dec(doneDays)} jours sur ${totalDays}`)}
      <div class="kpis">
        <div class="kpi hl"><div class="n">${dec(doneDays)} / ${totalDays}</div><div class="l">jours réalisés</div></div>
        <div class="kpi"><div class="n">${fr.format(testsTotal)}</div><div class="l">tests automatisés, tous verts</div></div>
        <div class="kpi"><div class="n">${modulesDone} / ${allModules.length}</div><div class="l">modules terminés</div></div>
        <div class="kpi"><div class="n">${prs.total > 0 ? `${prs.merged} / ${prs.total}` : "—"}</div><div class="l">PR fusionnées${prs.open > 0 ? `<br>(${prs.open} en revue)` : ""}</div></div>
        <div class="kpi"><div class="n">${adrAccepted} / ${adrTotal}</div><div class="l">décisions d'architecture (ADR) acceptées</div></div>
        <div class="kpi"><div class="n">${findings}</div><div class="l">failles trouvées par les revues adverses, toutes corrigées</div></div>
      </div>
    </div>
    ${
      previous
        ? `<div class="since"><span class="kicker" style="margin-right:4px;">Depuis le ${dateLabel(previous.date)}</span><b>${sign(dPercent, "point")}</b> d'avancement <span class="delta">${sign(dDays, "jour")}</span> <span class="delta">${sign(dTests, "test")}</span></div>`
        : ""
    }
    <div class="grid3" style="margin-top:14px;">
      ${highlights.map((h) => `<div class="hi"><div class="kicker">${esc(h.k)}</div><h3>${esc(h.t)}</h3><p>${esc(h.p)}</p></div>`).join("\n      ")}
    </div>
    <div class="card" style="margin-top:14px;">
      <div class="ct">En une phrase</div>
      <div class="body">${esc(data.summary)}</div>
    </div>
    <div class="sec">
      <h2>Avancement par phase <small>jours réalisés</small></h2>
      <div style="margin-top:10px;">
      ${data.phases
        .map((p, i) => {
          const s = phaseStats[i];
          const done = Number.isInteger(s.done) ? s.done : dec(Math.round(s.done * 10) / 10);
          return `<div class="bar-h${s.percent === 0 ? " dim" : ""}"><span class="lb">${esc(p.title.replace(" — ", " · "))}</span><span class="tr"><i style="width:${s.percent}%"></i></span><span class="v">${done} / ${s.total} · ${s.percent} %</span></div>`;
        })
        .join("\n      ")}
      </div>
    </div>
  </div>`,
  "cover",
);

// 2. journal du jour : une phrase par étape, activités repliées, vignettes, lignes ajoutées et retirées
function diffStat(pattern) {
  if (!pattern) return null;
  const out = run("git", ["log", "--all", "--no-merges", `--since=${iso} 00:00`, "-E", `--grep=${pattern}`, "--numstat", "--format="]);
  let added = 0;
  let removed = 0;
  for (const line of out.split("\n")) {
    const [a, r] = line.split("\t");
    if (/^\d+$/.test(a) && /^\d+$/.test(r)) {
      added += Number(a);
      removed += Number(r);
    }
  }
  return added + removed === 0 ? null : { added, removed };
}
const inline = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>");
page(
  data.journal.title,
  `
  <h2>${esc(data.journal.title)} <small>${longDate}</small></h2>
  <div class="sub">${esc(data.journal.intro)}</div>
  <div class="jr">
    ${data.journal.steps
      .map((st) => {
        const stat = diffStat(st.grep);
        return `<div class="js"><div class="jt">${inline(st.sentence)}</div>
      <div class="ja">${st.actions.map((x) => `<span>${esc(x)}</span>`).join("")}${stat ? `<span class="jd"><b class="plus">+${fr.format(stat.added)}</b> <b class="minus">−${fr.format(stat.removed)}</b></span>` : ""}</div>
      ${st.thumbs ? `<div class="jth">${st.thumbs.map(([f, c]) => `<figure><img src="journal/${esc(f)}" alt="${esc(c)}"><figcaption>${esc(c)}</figcaption></figure>`).join("")}</div>` : ""}</div>`;
      })
      .join("\n    ")}
  </div>`,
);

// 2. feuille de route
page(
  "Feuille de route",
  `
  <h2>Feuille de route <small>jalons, courbe d'avancement, phases</small></h2>
  <div class="sub">Les jalons sont des portes de qualité : on ne les franchit qu'avec les preuves.</div>
  <div class="tl">
    ${data.milestones
      .map((m) => `<div class="ms ${m.status}"><b>${esc(m.label)}</b><span class="w">${esc(m.when)}</span><span class="nt">${esc(m.note)}</span></div>`)
      .join("\n    ")}
  </div>
  <div class="chart" style="margin-top:12px;">
    <div class="ct">Avancement global au fil des jours</div>
    <div class="cs">Part des ${totalDays} jours du plan réalisés, mesurée à chaque rapport.</div>
    ${progressChart()}
  </div>
  <div class="sec grid3">
    ${data.phases
      .map((p, i) => {
        const s = phaseStats[i];
        const done = Number.isInteger(s.done) ? s.done : dec(Math.round(s.done * 10) / 10);
        const parts = [s.counts.done ? `${s.counts.done} fait${s.counts.done > 1 ? "s" : ""}` : "", s.counts.part ? `${s.counts.part} à valider` : "", s.counts.todo ? `${s.counts.todo} à faire` : ""].filter(Boolean).join(" · ");
        return `<div class="pcard"><div class="hd"><h3>${esc(p.title.replace(" — ", " · "))}</h3><div class="pn${s.percent === 0 ? " zero" : ""}">${s.percent}%</div></div><div class="meta">${done} / ${s.total} jours · ${p.modules.length} modules<br>${esc(parts)}</div><div class="tr"><i style="width:${s.percent}%"></i></div></div>`;
      })
      .join("\n    ")}
  </div>
  <div class="sec grid3">
    <div class="ask"><div class="n">${dec(remaining)} jours</div><div class="l">restent à réaliser sur ${totalDays} (${dec(Math.round((100 - globalPercent) * 10) / 10)} % du plan)</div></div>
    <div class="ask"><div class="n">${nextMilestone ? esc(nextMilestone.when) : "—"}</div><div class="l">prochain jalon daté : ${nextMilestone ? esc(nextMilestone.label) : "aucun"}</div></div>
    <div class="ask"><div class="n">J33</div><div class="l">prochaine journée : désabonnement, prérequis du premier envoi marketing</div></div>
  </div>`,
);

// 3. phases 0 et 1 + extras
page(
  "Phases 0 et 1",
  `
  <div class="phase"><h2>${esc(data.phases[0].title)} <small>${phaseStats[0].total} jours</small></h2><div class="pp">${phaseStats[0].percent} %</div></div>
  ${moduleTable(data.phases[0].modules)}
  <div class="phase"><h2>${esc(data.phases[1].title)} <small>${phaseStats[1].total} jours</small></h2><div class="pp">${phaseStats[1].percent} %</div></div>
  ${moduleTable(data.phases[1].modules)}
  <div class="phase"><h2>Réalisé en plus du plan <small>demandes du propriétaire du produit</small></h2></div>
  ${moduleTable(data.extras, { dayColumn: false, lastHeader: "Contenu" })}`,
);

// 4. phases 2 à 5
page(
  "Phases 2 à 5",
  `
  ${data.phases
    .slice(2)
    .map(
      (p, i) =>
        `<div class="phase"><h2>${esc(p.title)} <small>${phaseStats[i + 2].total} jours</small></h2><div class="pp"${phaseStats[i + 2].percent === 0 ? ' style="color:#6b7569;"' : ""}>${phaseStats[i + 2].percent} %</div></div>\n  ${moduleTable(p.modules, { lastHeader: i < 2 ? "Livrable" : "Jalon / remarque" })}`,
    )
    .join("\n  ")}`,
);

// 5. livré récemment
page(
  "Livré récemment",
  `
  <h2>Livré récemment <small>J30 à J34 : les canaux e-mail et WhatsApp</small></h2>
  <div class="sub">Chaque journée est validée par des tests, puis attaquée par une revue de sécurité indépendante avant la fusion.</div>
  ${data.recent
    .map(
      (r) => `<div class="day"><div class="hd"><span class="dn">${esc(r.day)}</span><h3>${esc(r.title)}</h3></div>
    <ul>${r.items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    <div class="ft"><span>Preuves : ${esc(r.proof)}</span>${r.review ? `<span>· Revue de sécurité :</span>${sevChips(r.review)}` : `<span>· revue de sécurité faite</span>`}</div></div>`,
    )
    .join("\n  ")}
  <div class="grid2" style="margin-top:10px;">
    <div class="cap ok"><div class="ct">Déjà possible</div><ul>${data.capabilities.ready.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    <div class="cap no"><div class="ct">Pas encore possible</div><ul>${data.capabilities.notYet.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
  </div>`,
);

// 6. qualité
page(
  "Qualité et sécurité",
  `
  <h2>Qualité mesurée <small>tests automatisés, tous verts</small></h2>
  <div class="sub">${fr.format(testsTotal)} tests au total${previous && previous.tests ? ` (${sign(dTests, "test")} depuis le ${dateLabel(previous.date)})` : ""}.</div>
  <div class="grid2" style="grid-template-columns:1.15fr 1fr;">
    <div class="chart" style="padding-top:14px;">
      <div class="ct">Tests par catégorie</div>
      <div class="cs" style="margin-top:2px;">Ce que couvre chaque ligne.</div>
      <div style="margin-top:4px;">
      ${data.tests
        .map(
          (t) =>
            `<div style="margin:8px 0 9px;"><div class="bar-h" style="margin:0;"><span class="lb" style="width:1.45in;">${esc(t.label)}</span><span class="tr"><i style="width:${Math.max(1, Math.round((t.value * 100) / maxTest))}%"></i></span><span class="v" style="width:0.5in;">${fr.format(t.value)}</span></div>${t.note ? `<div class="tnote">${esc(t.note)}</div>` : ""}</div>`,
        )
        .join("\n      ")}
      </div>
    </div>
    <div class="chart">
      <div class="ct">Tests au fil des jours</div>
      <div class="cs">Total à chaque rapport.</div>
      ${testsChart()}
    </div>
  </div>
  <div class="sec grid2">
    <div class="card plain"><div class="ct">Contrôles automatiques</div><div class="body">${esc(data.controls)}</div></div>
    <div class="card plain"><div class="ct">Sécurité</div><div class="body">${esc(data.security)}</div></div>
  </div>
  <div class="sec">
    <h2>Revues de sécurité adverses <small>failles trouvées avant la fusion</small></h2>
    <table class="m"><tr><th style="width:12%">Jour</th><th>Sujet</th><th style="width:44%">Résultat</th></tr>
    ${reviews.map((r) => `<tr><td class="d">${esc(r.day)}</td><td class="n">${esc(r.title)}</td><td>${sevChips(r.review)}</td></tr>`).join("\n    ")}</table>
    <div class="sub" style="margin-top:8px;">Toutes ces failles sont corrigées avant la fusion, avec un test qui la reproduit. Un bloquant empêche la fusion ; un majeur est corrigé le jour même.</div>
  </div>`,
);

// 7. décisions et suite
const urgent = (u) => (/^Avant (C3|J34|le premier)/.test(u) ? "hot" : "todo");
page(
  "Décisions et suite",
  `
  <h2>Points ouverts et décisions à prendre</h2>
  <div class="sub">À traiter par la responsable technique, le propriétaire du produit ou l'équipe.</div>
  <div class="dech"><span>#</span><span>Point</span><span>Qui</span><span>Échéance</span></div>
  ${data.openPoints.map((p, i) => `<div class="dec"><span class="i">${i + 1}</span><span>${esc(p.text)}</span><span class="o">${esc(p.owner)}</span><span><span class="chip ${urgent(p.urgency)}">${esc(p.urgency)}</span></span></div>`).join("\n  ")}
  <div class="sec">
    <h2>Prochaines étapes</h2>
    <table class="m"><tr><th style="width:16%">Quand</th><th>Action</th></tr>
    ${data.nextSteps.map((s) => `<tr><td class="d">${esc(s.when)}</td><td>${esc(s.action)}</td></tr>`).join("\n    ")}</table>
  </div>
  <div class="card" style="margin-top:14px;">
    <div class="ct">Comment lire ce rapport</div>
    <div class="body">Avancement d'un module = part de ses livrables terminés et vérifiés : <b>100 %</b> = code, tests et documentation livrés. Statuts : ${chip("done")} fusionné · ${chip("review")} PR ouverte · ${chip("part")} fait mais à valider · ${chip("todo")} à faire. Avancement global = jours réalisés sur ${totalDays} (${dec(doneDays)} ÷ ${totalDays} = ${dec(globalPercent)} %). Rapport régénéré à chaque commit (<code>pnpm report:progress</code>${branch ? `, branche <code>${esc(branch)}</code>` : ""}). Sources : <code>docs/progress/journal.md</code>, <code>docs/plan/development-plan.md</code>, <code>scripts/progress-report/data.json</code>, <code>scripts/progress-report/history.json</code>.</div>
  </div>`,
);

const total = pages.length;
const rendered = pages
  .map(
    (p, i) => `
<div class="page ${p.cls}">
  <div class="top"><span class="brand"><i></i>FUSION LEAP</span><span>${esc(p.title)} · ${longDate}</span></div>
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
}
