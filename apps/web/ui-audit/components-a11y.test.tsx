import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Alert } from "../components/ui/alert";
import { Button, buttonVariants } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { SheetContent } from "../components/ui/sheet";

/**
 * Accessibilité des briques d'interface et des repères de page (ADR 015). Aucune bibliothèque de test DOM n'est
 * installée : rendu côté serveur (react-dom/server) pour le balisage, parcours de l'arbre React pour les portails
 * Radix (qui ne se montent pas côté serveur), et contrôles sur le code source pour les invariants de structure.
 */
const WEB_ROOT = path.resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(path.join(WEB_ROOT, rel), "utf8");

type El = { type?: unknown; props?: { children?: unknown; [k: string]: unknown } };
function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    out.push(node as El);
    walk((node as El).props?.children, out);
  }
  return out;
}
const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join("") : typeof node === "string" ? node : node && typeof node === "object" && "props" in node ? textOf((node as El).props?.children) : "";

// --------------------------------------------------------------------------------------------------
// Button
// --------------------------------------------------------------------------------------------------

describe("Button", () => {
  it("rend un <button> natif avec anneau de focus visible et état désactivable", () => {
    const html = renderToStaticMarkup(<Button>Envoyer</Button>);
    expect(html).toMatch(/^<button\b/);
    expect(html).toContain('data-slot="button"');
    expect(html).toMatch(/focus-visible:ring-\[3px\]/);
    expect(html).toMatch(/focus-visible:border-ring/);
    expect(html).toContain("disabled:pointer-events-none");
    expect(html).toContain("outline-none"); // l'indicateur de focus est remplacé par l'anneau, jamais supprimé
    expect(renderToStaticMarkup(<Button disabled>x</Button>)).toMatch(/\sdisabled(?:=""|\s|>)/);
  });

  it("transmet le nom accessible et les états ARIA (bouton icône, bascule)", () => {
    const html = renderToStaticMarkup(
      <Button size="icon" aria-label="Afficher le mot de passe" aria-pressed={false} type="button">
        <svg aria-hidden="true" />
      </Button>,
    );
    expect(html).toContain('aria-label="Afficher le mot de passe"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('type="button"');
  });

  it("asChild applique le style au lien enfant sans <button> imbriqué", () => {
    const html = renderToStaticMarkup(
      <Button asChild>
        <span data-x="1">Membres</span>
      </Button>,
    );
    expect(html).toMatch(/^<span\b[^>]*data-slot="button"[^>]*data-x="1"|^<span\b[^>]*data-x="1"[^>]*data-slot="button"/);
    expect(html).not.toContain("<button");
    expect(html).toMatch(/focus-visible:ring-\[3px\]/);
  });

  it("les variantes sont distinctes et la cible tactile des boutons icône est d'au moins 32px", () => {
    const variants = ["default", "destructive", "outline", "secondary", "ghost", "link"] as const;
    const classes = variants.map((v) => buttonVariants({ variant: v }));
    expect(new Set(classes).size).toBe(variants.length);
    expect(buttonVariants({ size: "icon" })).toContain("size-9");
    expect(buttonVariants({ size: "icon-sm" })).toContain("size-8");
    expect(buttonVariants({ size: "default" })).toContain("h-9");
  });

  it("la variante lien utilise le vert lisible en sombre (text-primary-text), jamais le vert brut", () => {
    const link = buttonVariants({ variant: "link" });
    expect(link).toContain("text-primary-text");
    expect(link).not.toMatch(/(?:^|\s)text-primary(?:\s|$)/);
  });
});

// --------------------------------------------------------------------------------------------------
// Input / Label
// --------------------------------------------------------------------------------------------------

describe("Input", () => {
  it("n'expose aria-invalid que lorsque error est vrai", () => {
    const attr = /saria-invalid="/;
    expect(renderToStaticMarkup(<Input name="a" />)).not.toMatch(attr);
    expect(renderToStaticMarkup(<Input name="a" error={false} />)).not.toMatch(attr);
    expect(renderToStaticMarkup(<Input name="a" error />)).toContain('aria-invalid="true"');
  });

  it("transmet aria-describedby, name, type, required et autocomplete tels quels", () => {
    const html = renderToStaticMarkup(<Input id="e" name="email" type="email" required autoComplete="email" aria-describedby="e-hint e-err" />);
    expect(html).toContain('id="e"');
    expect(html).toContain('name="email"');
    expect(html).toContain('type="email"');
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain('aria-describedby="e-hint e-err"');
    expect(html).toMatch(/\srequired(?:=""|\s|\/)/);
  });

  it("a un anneau de focus visible et un style d'erreur déclenché par aria-invalid (pas seulement la couleur)", () => {
    const html = renderToStaticMarkup(<Input />);
    expect(html).toContain("focus-visible:ring-[3px]");
    expect(html).toContain("focus-visible:border-ring");
    expect(html).toContain("aria-invalid:border-destructive");
    expect(html).toContain("aria-invalid:ring-destructive/20");
  });

  it("la taille de police n'est pas inférieure à 16px sur mobile (pas de zoom à la prise de focus)", () => {
    expect(renderToStaticMarkup(<Input />)).toMatch(/\btext-base\b/);
  });
});

describe("Label", () => {
  it("rend un <label> relié par htmlFor", () => {
    const html = renderToStaticMarkup(<Label htmlFor="x">Courriel</Label>);
    expect(html).toMatch(/^<label\b[^>]*\sfor="x"/);
    expect(html).toContain("Courriel");
  });
});

// --------------------------------------------------------------------------------------------------
// Alert
// --------------------------------------------------------------------------------------------------

describe("Alert", () => {
  it("annonce par défaut en role=alert ; role=status disponible pour les messages non urgents", () => {
    expect(renderToStaticMarkup(<Alert>x</Alert>)).toContain('role="alert"');
    expect(renderToStaticMarkup(<Alert role="status">x</Alert>)).toContain('role="status"');
    expect(renderToStaticMarkup(<Alert role="status">x</Alert>)).not.toContain('role="alert"');
  });

  it("la variante destructive utilise le jeton de texte d'erreur (contraste AA clair et sombre) et les icônes suivent la couleur du texte", () => {
    const html = renderToStaticMarkup(<Alert variant="destructive">x</Alert>);
    expect(html).toContain("text-destructive-text");
    expect(html).not.toContain("dark:text-red-300");
  });
});

// --------------------------------------------------------------------------------------------------
// Dialog / Sheet (portails : parcours de l'arbre)
// --------------------------------------------------------------------------------------------------

describe("Dialog", () => {
  it("le bouton de fermeture a un nom accessible traduit et son icône est décorative", () => {
    const tree = walk(DialogContent({ closeLabel: "Fermer", children: <p>corps</p> }));
    const close = tree.find((e) => e.props?.["data-slot"] === "dialog-close");
    expect(close).toBeDefined();
    const label = walk(close).find((e) => e.type === "span" && String(e.props?.className).includes("sr-only"));
    expect(textOf(label)).toBe("Fermer");
  });

  it("showCloseButton={false} retire le bouton de fermeture", () => {
    const tree = walk(DialogContent({ closeLabel: "Fermer", showCloseButton: false, children: <p>corps</p> }));
    expect(tree.find((e) => e.props?.["data-slot"] === "dialog-close")).toBeUndefined();
  });

  it("le contenu est centré avec des propriétés logiques et corrigé en RTL, avec une ombre/overlay", () => {
    const tree = walk(DialogContent({ closeLabel: "Fermer", children: null }));
    const content = tree.find((e) => e.props?.["data-slot"] === "dialog-content");
    const cls = String(content?.props?.className);
    expect(cls).toContain("start-[50%]");
    expect(cls).toContain("rtl:translate-x-[50%]");
    expect(cls).toContain("outline-none");
    expect(cls).not.toMatch(/(?:^|\s)(?:left|right)-/);
    expect(tree.some((e) => typeof e.type === "function" && e.type.name === "DialogOverlay")).toBe(true);
  });

  it("le bouton de fermeture est placé en fin de ligne (end-4) et reste atteignable au clavier (focus visible)", () => {
    const tree = walk(DialogContent({ closeLabel: "Fermer", children: null }));
    const cls = String(tree.find((e) => e.props?.["data-slot"] === "dialog-close")?.props?.className);
    expect(cls).toContain("end-4");
    expect(cls).toContain("focus:ring-2");
  });

  it("Dialog, titre et description se rendent sans erreur côté serveur (fermé : aucun contenu piégé)", () => {
    const html = renderToStaticMarkup(
      <Dialog open={false}>
        <DialogContent closeLabel="Fermer">
          <DialogTitle>Titre</DialogTitle>
          <DialogDescription>Description</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(html).toBe("");
  });
});

describe("Sheet", () => {
  it("exige et affiche un nom accessible de fermeture, côté logique start/end", () => {
    const start = walk(SheetContent({ closeLabel: "Fermer", side: "start", children: null }));
    const end = walk(SheetContent({ closeLabel: "Fermer", side: "end", children: null }));
    const content = (tree: El[]) => String(tree.find((e) => e.props?.["data-slot"] === "sheet-content")?.props?.className);
    expect(content(start)).toMatch(/\bstart-0\b/);
    expect(content(end)).toMatch(/\bend-0\b/);
    for (const tree of [start, end]) {
      expect(textOf(tree.find((e) => e.type === "span" && String(e.props?.className).includes("sr-only")))).toBe("Fermer");
      expect(content(tree)).not.toMatch(/(?:^|\s)(?:left|right)-0/);
    }
  });
});

// --------------------------------------------------------------------------------------------------
// Invariants de source : focus, mouvement, repères, titres
// --------------------------------------------------------------------------------------------------

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(WEB_ROOT, dir))) {
    if (entry === "node_modules" || entry === ".next") continue;
    const rel = `${dir}/${entry}`;
    if (statSync(path.join(WEB_ROOT, rel)).isDirectory()) filesUnder(rel, out);
    else out.push(rel);
  }
  return out;
}

describe("focus visible sur chaque contrôle interactif de components/ui", () => {
  it.each([
    "button",
    "input",
    "select",
    "dropdown-menu",
    "dialog",
    "sheet",
    "sidebar",
  ])("%s.tsx définit un style de focus", (name) => {
    expect(read(`components/ui/${name}.tsx`), name).toMatch(/focus(?:-visible)?:|data-\[highlighted\]|data-\[selected|focus-visible/);
  });

  it("la feuille globale impose un contour de focus clavier de 2px de la couleur --ring", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ring\)/);
  });

  const withOutlineRemoved = filesUnder("components").filter(
    (f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx") && /\boutline-(?:none|hidden)\b/.test(read(f)),
  );

  it("la détection voit les composants qui retirent le contour natif", () => {
    expect(withOutlineRemoved.length).toBeGreaterThan(5);
    expect(withOutlineRemoved).toContain("components/ui/input.tsx");
  });

  for (const file of withOutlineRemoved) {
    it(`${file} : le contour retiré est remplacé par un anneau de focus`, () => {
      expect(read(file)).toMatch(/focus(?:-visible)?:(?:ring|border|bg|outline)/);
    });
  }
});

describe("mouvement réduit", () => {
  it("la feuille globale neutralise animations, transitions et défilement animé", () => {
    const css = read("app/globals.css");
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n {2}\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(block).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  it("la barre latérale désactive ses transitions avec motion-reduce", () => {
    expect(read("components/ui/sidebar.tsx")).toContain("motion-reduce:transition-none");
  });

  it("le lien d'évitement (skip link) cible #main et n'anime que par translation", () => {
    const layout = read("app/[locale]/layout.tsx");
    expect(layout).toContain('href="#main"');
    expect(layout).toMatch(/focus:translate-y-0/);
  });
});

describe("repères de page : un seul <main id=\"main\"> par rendu, un seul <h1> par page", () => {
  it("les pages et layouts d'app/ ne posent aucun <main> (la coquille de leur groupe de routes le fournit)", () => {
    const offenders = filesUnder("app")
      .filter((f) => /(?:page|layout)\.tsx$/.test(f))
      .filter((f) => {
        const code = read(f)
          .split("\n")
          .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
          .join("\n");
        return /<main\b/.test(code);
      });
    expect(offenders).toEqual([]);
  });

  it.each([
    ["components/public/public-frame.tsx", /<main\s+id="main"/],
    ["components/layout/app-shell.tsx", /<main id="main"/],
    ["components/layout/app-shell.tsx", /<SidebarInset id="main"/],
  ])("%s fournit la cible du lien d'évitement (%s)", (file, pattern) => {
    expect(read(file)).toMatch(pattern);
  });

  it("SidebarInset est un élément <main>", () => {
    expect(read("components/ui/sidebar.tsx")).toMatch(/function SidebarInset[\s\S]*?<main\b/);
  });

  it("chaque groupe de routes a sa coquille : (public) et invite -> PublicFrame, (app) -> AppShell", () => {
    expect(read("app/[locale]/(public)/layout.tsx")).toMatch(/PublicFrame/);
    expect(read("app/[locale]/invite/layout.tsx")).toMatch(/PublicFrame/);
    expect(read("app/[locale]/page.tsx")).toMatch(/PublicFrame|<h1/);
    expect(read("app/[locale]/(app)/layout.tsx")).toMatch(/AppShell/);
  });

  it("la coquille d'application expose <header> et la navigation est étiquetée", () => {
    expect(read("components/layout/app-shell.tsx")).toMatch(/<header\b/);
    expect(read("components/layout/app-sidebar.tsx")).toMatch(/<nav aria-label=\{t\("nav\.label"\)\}/);
    // le sélecteur de langue est un menu étiqueté, pas un second repère <nav>
    expect(read("components/layout/language-switcher.tsx")).not.toMatch(/<nav\b/);
    expect(read("components/layout/language-switcher.tsx")).toMatch(/aria-label=\{t\("label"\)\}/);
  });

  const pages = filesUnder("app").filter((f) => f.endsWith("/page.tsx"));

  it("il y a des pages à contrôler", () => {
    expect(pages.length).toBeGreaterThanOrEqual(9);
  });

  it.each(pages)("%s a exactement un titre de niveau 1", (file) => {
    const src = read(file);
    const count = (src.match(/<h1\b/g) ?? []).length + (src.match(/<PageCardTitle\b/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("les titres de page ne sautent pas de niveau (pas de <h3> sans <h2>)", () => {
    for (const file of pages) {
      const src = read(file);
      if (/<h3\b/.test(src)) expect(src, file).toMatch(/<h2\b/);
    }
  });
});

describe("langue et direction du document", () => {
  it("<html> reçoit lang et dir, suppressHydrationWarning pour next-themes", () => {
    const layout = read("app/[locale]/layout.tsx");
    expect(layout).toMatch(/<html lang=\{locale\} dir=\{dir\} suppressHydrationWarning/);
  });

  it("les textes en langue étrangère embarqués portent leur propre langue (sélecteur de langue)", () => {
    expect(read("components/layout/language-switcher.tsx")).toMatch(/lang=\{other\}/);
    expect(read("components/layout/language-switcher.tsx")).toMatch(/hrefLang=\{other\}/);
  });

  it("les valeurs toujours LTR (e-mail, URL) sont isolées dir=ltr / <bdi> dans les composants", () => {
    expect(read("components/auth/auth-form.tsx")).toMatch(/dir="ltr"/);
    expect(read("components/members/invite-form.tsx")).toMatch(/dir="ltr"/);
    expect(read("components/layout/user-menu.tsx")).toMatch(/<bdi dir="ltr"/);
  });
});

describe("annonces et noms d'organisation", () => {
  it("un message d'erreur n'est annoncé que par UN canal : aucune notification d'erreur (toast.error) ; la région live suffit", () => {
    for (const file of filesUnder("components").filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))) {
      expect(read(file), file).not.toMatch(/toast\.error\(/);
    }
  });

  it("les noms d'organisation (saisis par l'utilisateur) sont isolés par <bdi> : sélecteur, liste, fil d'Ariane, tableau de bord", () => {
    expect(read("components/org/organization-switcher.tsx")).toMatch(/<bdi>\{option\.name\}<\/bdi>/);
    expect(read("components/org/organization-list.tsx")).toMatch(/<bdi[^>]*>\{item\.name\}<\/bdi>/);
    expect(read("components/layout/app-shell.tsx")).toMatch(/<bdi[^>]*>\{activeOrganizationName\}<\/bdi>/);
    expect(read("app/[locale]/(app)/dashboard/page.tsx")).toMatch(/<bdi>\{tenant\.organization\.name\}<\/bdi>/);
    expect(read("components/layout/user-menu.tsx")).toMatch(/<bdi dir="ltr"/);
  });
});
