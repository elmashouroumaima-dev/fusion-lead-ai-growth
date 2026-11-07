import ts from "typescript";

/**
 * Collecteur de jetons de classe fondé sur l'AST TypeScript : renvoie, pour chaque littéral de chaîne d'un fichier
 * (chaînes simples, gabarits sur plusieurs lignes, morceaux de gabarit avec expressions, constantes isolées,
 * arguments de cn() / cva()), les jetons séparés par des espaces avec leur ligne. Contrairement à un balayage par ligne,
 * une classe physique posée dans un gabarit multi-ligne ou dans une constante hors `className=` est vue.
 */
export type ClassToken = { token: string; line: number };

export function collectClassTokens(fileName: string, source: string): ClassToken[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const out: ClassToken[] = [];
  const add = (node: ts.Node, text: string): void => {
    // le texte brut d'un gabarit multi-ligne : la ligne d'un jeton = ligne du début du littéral + retours à la ligne précédents
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    text.split("\n").forEach((chunk, offset) => {
      for (const token of chunk.split(/\s+/)) if (token) out.push({ token, line: start + offset });
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) add(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Utilités Tailwind PHYSIQUES (le jeton est examiné sans ses variantes `hover:`, `sm:`, `[&>svg]:`, sans `!` ni signe moins). */
const PHYSICAL_TOKEN =
  /^-?(?:(?:ml|mr|pl|pr|left|right|scroll-ml|scroll-mr|scroll-pl|scroll-pr|rounded-[lr]|rounded-t[lr]|rounded-b[lr]|border-[lr])-\S+|(?:float-left|float-right|text-left|text-right|rounded-l|rounded-r|border-l|border-r)$)/;

export function isPhysicalClassToken(token: string): boolean {
  const base = (token.split(":").pop() ?? "").replace(/^!/, "");
  return PHYSICAL_TOKEN.test(base);
}

export function physicalClassOffences(fileName: string, source: string): { token: string; line: number }[] {
  return collectClassTokens(fileName, source).filter(({ token }) => isPhysicalClassToken(token));
}
