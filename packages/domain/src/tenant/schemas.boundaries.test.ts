import { describe, expect, it } from "vitest";
import {
  activeOrgCookieSchema,
  APP_ROLES,
  createOrganizationApiSchema,
  createOrganizationSchema,
  isValidTimeZone,
  idempotencyKeySchema,
  SUPPORTED_TIME_ZONES,
  tenantRoleSchema,
  timezoneSchema,
  uuidSchema,
} from "./schemas";

const ORG = "11111111-1111-4111-8111-111111111111";
const ok = (input: unknown) => createOrganizationSchema.safeParse(input).success;

describe("createOrganizationSchema : bornes du nom", () => {
  it.each([
    [0, false],
    [1, true],
    [119, true],
    [120, true],
    [121, false],
  ])("nom de %i caractères -> %s", (len, expected) => {
    expect(ok({ name: "x".repeat(len) })).toBe(expected);
  });

  it("la longueur est mesurée APRÈS rognage : 120 + espaces passe, 121 + espaces échoue", () => {
    expect(ok({ name: `  ${"x".repeat(120)}  ` })).toBe(true);
    expect(ok({ name: `  ${"x".repeat(121)}  ` })).toBe(false);
  });

  it.each(["\t", "\n", "   ", "\u00a0\u00a0", "\u2003"])("nom composé d'espaces %j refusé", (name) => {
    expect(ok({ name })).toBe(false);
  });

  it("conserve les caractères arabes et rogne sans altérer l'intérieur", () => {
    expect(createOrganizationSchema.parse({ name: "  شركة   الأمل  " }).name).toBe("شركة   الأمل");
  });

  it.each([[null], [undefined], [["a"]], [{}], [true]])("type non texte %j refusé", (name) => {
    expect(ok({ name })).toBe(false);
  });
});

describe("createOrganizationSchema : caractères du nom", () => {
  it.each([
    ["contrôle C0 (NUL)", "A\u0000B"],
    ["contrôle C0 (BEL)", "A\u0007"],
    ["DEL", "A\u007F"],
    ["contrôle C1", "A\u0085B"],
    ["espace de largeur nulle", "A\u200BB"],
    ["marque gauche-droite", "A\u200EB"],
    ["embedding bidi", "A\u202EB"],
    ["isolat bidi", "A\u2066B"],
    ["joiner de mots", "A\u2060B"],
    ["marque arabe ALM", "A\u061CB"],
    ["BOM interne", "A\uFEFFB"],
    ["séparateur de ligne", "A\u2028B"],
    ["séparateur de paragraphe", "A\u2029B"],
    ["retour ligne interne", "A\nB"],
    ["uniquement des invisibles", "\u200B\u200B"],
  ])("refuse %s", (_l, name) => {
    expect(ok({ name })).toBe(false);
  });
  it.each(["---", "!!!", "...", "😀😀", "()", "_"])("refuse un nom sans lettre ni chiffre : %j", (name) => {
    expect(ok({ name })).toBe(false);
  });
  it.each(["A", "7", "٣", "شركة", "Société Générale", "A&B", "东京", "Acme (MA) - 2"])("accepte %j", (name) => {
    expect(ok({ name })).toBe(true);
  });
  it("la limite de 120 reste mesurée après rognage et les chiffres arabes comptent", () => {
    expect(ok({ name: `٣${"x".repeat(119)}` })).toBe(true);
  });
});

describe("fuseau horaire : validation par motif + moteur, indépendante de la liste de suggestions", () => {
  it.each(["Asia/Kolkata", "Europe/Kyiv", "America/Argentina/Buenos_Aires", "Etc/GMT+2", "Africa/Casablanca", "UTC"])(
    "accepte %s",
    (timezone) => {
      expect(isValidTimeZone(timezone)).toBe(true);
      expect(ok({ name: "A", timezone })).toBe(true);
    },
  );
  it.each([
    "EST",
    "PST8PDT",
    "GMT",
    "Z",
    "europe/paris",
    "EUROPE/PARIS",
    "asia/kolkata",
    "Asia/kolkata",
    "ASIA/KOLKATA",
    "Asia/kolkata",
    "ASIA/KOLKATA",
    "Europe/paris",
    "utc",
    "Europe/Atlantis",
    "Europe/",
    "/Paris",
    "Europe//Paris",
    "Europe/Pa ris",
    "Europe/Paris\n",
    "+05:30",
    "Etc/GMT+99",
  ])("refuse %j", (timezone) => {
    expect(isValidTimeZone(timezone)).toBe(false);
    expect(ok({ name: "A", timezone })).toBe(false);
  });
  it.each([undefined, null, 5, {}])("isValidTimeZone refuse le type %j", (v) => {
    expect(isValidTimeZone(v)).toBe(false);
  });
});

describe("createOrganizationApiSchema : strict", () => {
  it.each(["organization_id", "role", "slug", "created_by", "status", "x"])("refuse le champ inconnu %s", (field) => {
    expect(createOrganizationApiSchema.safeParse({ name: "A", [field]: "v" }).success).toBe(false);
  });
  it("accepte les trois champs connus, avec défauts", () => {
    expect(createOrganizationApiSchema.parse({ name: " A " })).toEqual({ name: "A", locale: "ar", timezone: "UTC" });
  });
  it("le schéma tolérant (Server Action) ignore toujours les extras", () => {
    expect(createOrganizationSchema.safeParse({ name: "A", uiLocale: "en", creation_key: "k" }).success).toBe(true);
  });
});

describe("createOrganizationSchema : locale", () => {
  it.each(["ar", "en"])("accepte %s", (locale) => {
    expect(createOrganizationSchema.parse({ name: "A", locale }).locale).toBe(locale);
  });
  it.each(["fr", "AR", "En", "ar-MA", " ar", "", null])("refuse %j", (locale) => {
    expect(ok({ name: "A", locale })).toBe(false);
  });
  it("défaut ar quand la locale est absente", () => {
    expect(createOrganizationSchema.parse({ name: "A" }).locale).toBe("ar");
  });
});

describe("createOrganizationSchema : fuseau horaire", () => {
  it.each(["UTC", "Africa/Casablanca", "Europe/Paris", "Asia/Riyadh", "America/Buenos_Aires"])(
    "accepte %s",
    (timezone) => {
      expect(ok({ name: "A", timezone })).toBe(true);
    },
  );
  it.each(["Mars/Olympus", "europe/paris", "utc", "UTC ", " UTC", "GMT+2", "+02:00", "Europe", "../etc/passwd", "'; drop table--", ""])(
    "refuse %j",
    (timezone) => {
      expect(ok({ name: "A", timezone })).toBe(false);
    },
  );
  it("liste de fuseaux : contient UTC, est triée sans doublon et gelée", () => {
    expect(SUPPORTED_TIME_ZONES).toContain("UTC");
    expect(new Set(SUPPORTED_TIME_ZONES).size).toBe(SUPPORTED_TIME_ZONES.length);
    expect(SUPPORTED_TIME_ZONES.length).toBeGreaterThan(300);
    expect(Object.isFrozen(SUPPORTED_TIME_ZONES)).toBe(true);
  });
  it("timezoneSchema n'accepte que des chaînes valides", () => {
    expect(timezoneSchema.safeParse(42).success).toBe(false);
    expect(timezoneSchema.safeParse("Africa/Casablanca").success).toBe(true);
  });
  it("défaut UTC quand le fuseau est absent", () => {
    expect(createOrganizationSchema.parse({ name: "A" }).timezone).toBe("UTC");
  });
});

describe("createOrganizationSchema : champs inconnus", () => {
  it("ne laisse JAMAIS passer organization_id / role / created_by dans la sortie", () => {
    const out = createOrganizationSchema.parse({
      name: "A",
      organization_id: ORG,
      role: "company_owner",
      created_by: ORG,
      slug: "forced",
      status: "active",
    });
    expect(Object.keys(out).sort()).toEqual(["locale", "name", "timezone"]);
  });
});

describe("idempotencyKeySchema : bornes et alphabet", () => {
  it.each([
    [7, false],
    [8, true],
    [9, true],
    [127, true],
    [128, true],
    [129, false],
  ])("clé de %i caractères -> %s", (len, expected) => {
    expect(idempotencyKeySchema.safeParse("a".repeat(len)).success).toBe(expected);
  });
  it.each(["abcdefgh", "ABCDEFGH", "01234567", "a_b-c_d-", "-------_", "0f8fad5b-d9cb-469f-a165-70867728950e"])(
    "accepte %s",
    (key) => {
      expect(idempotencyKeySchema.safeParse(key).success).toBe(true);
    },
  );
  it.each([
    "abcdefg.",
    "abcdefg h",
    " abcdefgh",
    "abcdefgh ",
    "abcdefgh\n",
    "abc/defgh",
    "abc:defgh",
    "abc+defgh",
    "abcdefgé",
    "مفتاح-الإنشاء",
    "abcdefgh\u0000",
  ])("refuse %j", (key) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
  });
  it.each([null, undefined, 12345678, ["abcdefgh"]])("refuse le type %j", (key) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});

describe("cookie fl_active_org (uuid)", () => {
  it("accepte un uuid, insensible à la casse", () => {
    expect(activeOrgCookieSchema.safeParse(ORG).success).toBe(true);
    expect(activeOrgCookieSchema.safeParse(ORG.toUpperCase()).success).toBe(true);
  });
  it.each([
    "",
    " ",
    ` ${ORG}`,
    `${ORG} `,
    ORG.slice(1),
    `${ORG}0`,
    ORG.replaceAll("-", ""),
    "g1111111-1111-4111-8111-111111111111",
    `${ORG}; Path=/`,
    `${ORG}\r\nSet-Cookie: x=1`,
    "null",
    "undefined",
    "00000000-0000-0000-0000-00000000000",
  ])("refuse %j", (value) => {
    expect(activeOrgCookieSchema.safeParse(value).success).toBe(false);
    expect(uuidSchema.safeParse(value).success).toBe(false);
  });
  it.each([undefined, null, 1, ["x"], {}])("refuse le type %j", (value) => {
    expect(activeOrgCookieSchema.safeParse(value).success).toBe(false);
  });
});

describe("TenantRole", () => {
  it("couvre exactement les cinq rôles tenant (ADR 014), sans platform_admin", () => {
    expect([...APP_ROLES].sort()).toEqual(["analyst", "company_admin", "company_owner", "marketing_manager", "sales_agent"]);
    for (const role of APP_ROLES) expect(tenantRoleSchema.safeParse(role).success).toBe(true);
    for (const bad of ["platform_admin", "owner", "COMPANY_OWNER", "", null]) {
      expect(tenantRoleSchema.safeParse(bad).success).toBe(false);
    }
  });
});
