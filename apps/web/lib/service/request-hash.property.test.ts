import { describe, expect, it } from "vitest";
import { canonicalRequestHash } from "./idempotency";

const h = (body: unknown, method = "POST", path = "/api/x") => canonicalRequestHash({ method, path, body });

/** PRNG déterministe (mulberry32) : les tests restent reproductibles. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("canonicalRequestHash : propriétés", () => {
  it("l'ordre des clés n'a aucune influence, à tous les niveaux", () => {
    expect(h({ a: 1, b: { x: 1, y: [{ p: 1, q: 2 }] } })).toBe(h({ b: { y: [{ q: 2, p: 1 }], x: 1 }, a: 1 }));
  });

  it("insensible à la mise en forme du JSON source (espaces, retours à la ligne, tabulations)", () => {
    const compact = JSON.parse('{"a":1,"b":[1,2],"c":"x y"}');
    const spaced = JSON.parse('{\n\t"c" : "x y",\n  "b": [ 1 ,\n 2 ], "a":   1\n}');
    expect(h(compact)).toBe(h(spaced));
  });

  it("espaces DANS une chaîne : significatifs", () => {
    expect(h({ a: "x y" })).not.toBe(h({ a: "x  y" }));
    expect(h({ a: "x" })).not.toBe(h({ a: "x " }));
  });

  it("l'ordre des tableaux est significatif", () => {
    expect(h({ a: [1, 2, 3] })).not.toBe(h({ a: [3, 2, 1] }));
  });

  it("nombre et chaîne distincts ; booléen, null et chaîne distincts", () => {
    const variants = [{ a: 1 }, { a: "1" }, { a: true }, { a: "true" }, { a: null }, { a: "null" }, { a: [1] }, { a: { "0": 1 } }];
    expect(new Set(variants.map((v) => h(v))).size).toBe(variants.length);
  });

  it("0 et -0 : même JSON, même empreinte ; 1 et 1.0 identiques ; 1 et 1.5 différents", () => {
    expect(h({ a: 0 })).toBe(h({ a: -0 }));
    expect(h({ a: 1 })).toBe(h({ a: 1.0 }));
    expect(h({ a: 1 })).not.toBe(h({ a: 1.5 }));
  });

  it("imbrication : un objet aplati n'est pas un objet imbriqué", () => {
    expect(h({ a: { b: 1 } })).not.toBe(h({ "a.b": 1 }));
    expect(h({ a: { b: { c: 1 } } })).not.toBe(h({ a: { b: 1 }, c: 1 }));
  });

  it("clé = valeur échangées donnent une autre empreinte (pas de concaténation ambiguë)", () => {
    expect(h({ a: "b" })).not.toBe(h({ b: "a" }));
    expect(h({ ab: "c" })).not.toBe(h({ a: "bc" }));
    expect(h({ a: "1,b:2" })).not.toBe(h({ a: "1", b: 2 }));
  });

  it("Unicode : valeurs hachées telles quelles (NFC et NFD différents), emoji et arabe stables", () => {
    expect(h({ a: "é" })).not.toBe(h({ a: "é" }));
    expect(h({ a: "مرحبا \u{1F30D}" })).toBe(h({ a: "مرحبا \u{1F30D}" }));
    expect(h({ a: "مرحبا" })).not.toBe(h({ a: "مرحبًا" }));
    expect(h({ "é": 1 })).not.toBe(h({ "é": 1 }));
  });

  it("undefined : propriété ignorée, donc { a:1, b:undefined } == { a:1 } mais != { a:1, b:null }", () => {
    expect(h({ a: 1, b: undefined })).toBe(h({ a: 1 }));
    expect(h({ a: 1, b: undefined })).not.toBe(h({ a: 1, b: null }));
  });

  it("méthode (insensible à la casse) et chemin (sensible) font partie de l'empreinte", () => {
    expect(h({ a: 1 }, "post")).toBe(h({ a: 1 }, "POST"));
    expect(h({ a: 1 }, "POST")).not.toBe(h({ a: 1 }, "DELETE"));
    expect(h({ a: 1 }, "POST", "/api/x")).not.toBe(h({ a: 1 }, "POST", "/api/X"));
    expect(h({ a: 1 }, "POST", "/api/x")).not.toBe(h({ a: 1 }, "POST", "/api/x/"));
  });

  it("le chemin et le corps ne peuvent pas être confondus (injection de séparateur)", () => {
    expect(canonicalRequestHash({ method: "POST", path: '/a","body":{"x":1}', body: null })).not.toBe(
      canonicalRequestHash({ method: "POST", path: "/a", body: { x: 1 } }),
    );
  });

  it("1000 corps distincts pseudo-aléatoires : aucune collision, format SHA-256 hex", () => {
    const rand = rng(20261112);
    const seen = new Map<string, string>();
    for (let i = 0; i < 1000; i++) {
      const body = {
        i,
        n: Math.floor(rand() * 1e9),
        s: Math.floor(rand() * 1e9).toString(36),
        arr: [Math.floor(rand() * 10), Math.floor(rand() * 10), i % 7],
        nested: { flag: rand() > 0.5, k: `k${i}` },
      };
      const hash = h(body);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      const previous = seen.get(hash);
      expect(previous, `collision entre ${previous} et ${JSON.stringify(body)}`).toBeUndefined();
      seen.set(hash, JSON.stringify(body));
    }
    expect(seen.size).toBe(1000);
  });

  it("1000 permutations de clés du même objet : une seule empreinte", () => {
    const rand = rng(7);
    const entries = Array.from({ length: 12 }, (_v, i) => [`key${i}`, i % 3 === 0 ? `v${i}` : i] as const);
    const reference = h(Object.fromEntries(entries));
    for (let i = 0; i < 1000; i++) {
      const shuffled = [...entries].sort(() => rand() - 0.5);
      expect(h(Object.fromEntries(shuffled))).toBe(reference);
    }
  });

  it("une valeur non sérialisable est refusée (jamais hachée par approximation)", () => {
    expect(() => h({ a: Number.NaN })).toThrow();
    expect(() => h({ a: 10n })).toThrow();
    expect(() => h({ a: new Date() })).toThrow();
  });
});
