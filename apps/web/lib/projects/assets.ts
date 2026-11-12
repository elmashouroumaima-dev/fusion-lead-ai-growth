import { randomUUID } from "node:crypto";
import {
  ASSET_MAX_BYTES,
  ASSET_MAX_PER_PRODUCT,
  ASSET_SIGNED_URL_SECONDS,
  assetFileName,
  buildAssetPath,
  checkAssetBytes,
  isAssetPathOf,
  isImageAsset,
  sanitizeAssetFileName,
  type ProductRow,
} from "@fusion-leap/domain";
import type { ServiceErrorCode } from "../service/errors";
import { logger } from "../service/logger";
import type { ServerSupabase } from "../tenant/identity";
import { mapProjectsDbError } from "./map-error";
import { getProduct, getProject } from "./queries";

/**
 * Fichiers des produits (J17, partie 2 ; ADR 005 §12, ADR 007 G-D11). Principes :
 *  - l'envoi se fait avec les droits de l'UTILISATEUR (client serveur + politiques Storage) : jamais `service_role` ;
 *  - le type réel est lu dans les OCTETS (png, jpeg, webp, pdf), la taille est bornée, le nom d'objet est GÉNÉRÉ ici
 *    (`{entreprise}/{projet}/{uuid}/{nom nettoyé}`) : aucun chemin ni type fourni par le client n'est repris ;
 *  - l'entreprise vient du contexte vérifié ; le produit et son projet sont relus (RLS) : un produit d'une autre entreprise est
 *    « introuvable » ;
 *  - si l'enregistrement du chemin échoue, l'objet envoyé est supprimé ; à la suppression, la base d'abord, puis l'objet ;
 *  - lecture : URL signées de 60 secondes, générées à chaque affichage (jamais d'URL publique).
 */

export type AssetFailure = ServiceErrorCode | "file_empty" | "file_too_large" | "file_type" | "file_missing" | "too_many_files";
export type AssetResult<T> = { ok: true; value: T } | { ok: false; code: AssetFailure };

const BUCKET = "assets";
const fail = (code: AssetFailure): { ok: false; code: AssetFailure } => ({ ok: false, code });

/** Erreur Storage -> code : un refus de politique (403) est « interdit », le reste une panne. */
function storageFailure(error: { message?: string | undefined; statusCode?: string | number | undefined } | null): AssetFailure {
  const status = String(error?.statusCode ?? "");
  const message = error?.message ?? "";
  if (status === "403" || status === "401" || /row-level security|not allowed|unauthorized/i.test(message)) return "forbidden";
  return "internal_error";
}

async function loadProduct(supabase: ServerSupabase, organizationId: string, productId: string) {
  try {
    const product = await getProduct(supabase, organizationId, productId);
    if (!product) return fail("not_found");
    const project = await getProject(supabase, organizationId, product.project_id);
    if (!project) return fail("not_found");
    if (project.status === "archived") return fail("conflict");
    return { ok: true as const, product };
  } catch {
    return fail("internal_error");
  }
}

/** Erreur des fonctions SQL d'association : « trop de fichiers » est propre à cette fonctionnalité. */
function attachFailure(error: { code?: string | null; message?: string | null }): AssetFailure {
  if (error.code === "P0001" && (error.message ?? "").includes("too_many_files")) return "too_many_files";
  return mapProjectsDbError(error);
}

async function readProduct(supabase: ServerSupabase, organizationId: string, productId: string): Promise<ProductRow | null> {
  try {
    return await getProduct(supabase, organizationId, productId);
  } catch {
    return null;
  }
}

/** Envoie un fichier et l'associe au produit. */
export async function uploadProductAsset(
  supabase: ServerSupabase,
  organizationId: string,
  productId: string,
  file: File | null,
): Promise<AssetResult<ProductRow>> {
  if (file === null) return fail("file_missing");
  if (file.size === 0) return fail("file_empty");
  // Refus avant toute lecture du contenu si la taille annoncée dépasse déjà la limite.
  if (file.size > ASSET_MAX_BYTES) return fail("file_too_large");

  const loaded = await loadProduct(supabase, organizationId, productId);
  if (!loaded.ok) return loaded;
  const { product } = loaded;
  if (product.assets.length >= ASSET_MAX_PER_PRODUCT) return fail("too_many_files");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkAssetBytes(bytes);
  if (!check.ok) return fail(check.code === "empty" ? "file_empty" : check.code === "too_large" ? "file_too_large" : "file_type");

  const path = buildAssetPath(organizationId, product.project_id, randomUUID(), sanitizeAssetFileName(file.name, check.extension));
  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: check.mime, upsert: false });
  if (error) return fail(storageFailure(error));

  // Association ATOMIQUE sous verrou du produit (append_product_asset) : pas de réécriture de la liste lue plus tôt.
  const { error: attachError } = await supabase.rpc("append_product_asset", { p_org: organizationId, p_product: product.id, p_path: path });
  if (attachError) {
    // Aucun objet orphelin : l'envoi est annulé (au mieux ; un échec de nettoyage est journalisé sans le chemin).
    const cleanup = await supabase.storage.from(BUCKET).remove([path]);
    if (cleanup.error) logger.warn("asset_cleanup_failed", { reason: "upload_rollback" });
    return fail(attachFailure(attachError));
  }
  const row = await readProduct(supabase, organizationId, product.id);
  return row ? { ok: true, value: row } : fail("internal_error");
}

/** Retire un fichier du produit (la base d'abord) puis supprime l'objet. Seul un chemin DÉJÀ associé au produit est accepté. */
export async function removeProductAsset(
  supabase: ServerSupabase,
  organizationId: string,
  productId: string,
  path: string,
): Promise<AssetResult<ProductRow>> {
  const loaded = await loadProduct(supabase, organizationId, productId);
  if (!loaded.ok) return loaded;
  const { product } = loaded;
  if (!product.assets.includes(path) || !isAssetPathOf(path, organizationId, product.project_id)) return fail("not_found");

  // Retrait ATOMIQUE (remove_product_asset) : renvoie le nombre de produits qui référencent encore l'objet ; il n'est supprimé
  // du Storage que si plus aucun produit ne le référence.
  const { data: remaining, error } = await supabase.rpc("remove_product_asset", { p_org: organizationId, p_product: product.id, p_path: path });
  if (error) return fail(attachFailure(error));
  if (remaining === 0) {
    const removal = await supabase.storage.from(BUCKET).remove([path]);
    if (removal.error) logger.warn("asset_cleanup_failed", { reason: "remove" });
  }
  const row = await readProduct(supabase, organizationId, product.id);
  return row ? { ok: true, value: row } : fail("internal_error");
}

export type AssetLink = { path: string; name: string; image: boolean; url: string | null };

/**
 * Liens de lecture d'une liste de chemins : URL signées de 60 secondes (images : affichage ; PDF : téléchargement forcé).
 * Un chemin refusé ou illisible donne `url: null` (jamais d'erreur côté page).
 */
export async function assetLinks(supabase: ServerSupabase, paths: readonly string[]): Promise<AssetLink[]> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return [];
  const images = unique.filter(isImageAsset);
  const documents = unique.filter((path) => !isImageAsset(path));
  const urls = new Map<string, string>();

  async function sign(list: string[], download: boolean): Promise<void> {
    if (list.length === 0) return;
    try {
      const { data } = await supabase.storage.from(BUCKET).createSignedUrls(list, ASSET_SIGNED_URL_SECONDS, download ? { download: true } : undefined);
      for (const entry of data ?? []) if (entry.path && entry.signedUrl) urls.set(entry.path, entry.signedUrl);
    } catch {
      // liens indisponibles : les fichiers s'affichent sans lien
    }
  }
  await Promise.all([sign(images, false), sign(documents, true)]);

  return paths.map((path) => ({ path, name: assetFileName(path), image: isImageAsset(path), url: urls.get(path) ?? null }));
}
