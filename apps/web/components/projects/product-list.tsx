import type { AuthLocale, ProductRow } from "@fusion-leap/domain";
import { PackageIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { assetLinks } from "../../lib/projects/assets";
import { createClient } from "../../lib/supabase/server";
import { ProductDialog } from "./product-dialog";

type Props = {
  locale: AuthLocale;
  organizationId: string;
  projectId: string;
  products: readonly ProductRow[];
  /** Modification autorisée (rôle owner / admin et projet actif) : la base revérifie. */
  canEdit: boolean;
};

/** Produits et offres d'un projet : lecture pour tous les rôles ; modification pour owner et admin sur un projet actif. */
export async function ProductList({ locale, organizationId, projectId, products, canEdit }: Props) {
  const t = await getTranslations({ locale, namespace: "Projects" });
  // Liens signés de 60 s pour tous les fichiers de la page, en un seul appel (images : aperçu ; PDF : téléchargement).
  const links = await assetLinks(
    await createClient(),
    products.flatMap((product) => product.assets),
  );
  const linksOf = (product: ProductRow) => links.filter((link) => product.assets.includes(link.path));

  if (products.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
        <PackageIcon className="size-6" aria-hidden="true" />
        <p>{t("products.empty")}</p>
      </div>
    );
  }

  return (
    <Table aria-labelledby="products-title" className="min-w-[36rem]">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("products.kind")}</TableHead>
          <TableHead scope="col">{t("products.offer")}</TableHead>
          <TableHead scope="col">{t("products.priceHint")}</TableHead>
          <TableHead scope="col">{t("products.assets")}</TableHead>
          {canEdit ? (
            <TableHead scope="col" className="text-end">
              {t("table.actions")}
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {products.map((product) => (
          <TableRow key={product.id}>
            <TableCell className="font-medium">
              <bdi>{product.kind}</bdi>
            </TableCell>
            <TableCell className="max-w-xs whitespace-pre-line">
              <bdi>{product.offer}</bdi>
              {product.landing_url ? (
                <a
                  href={product.landing_url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  dir="ltr"
                  className="text-primary-text mt-1 block truncate text-xs underline underline-offset-2"
                >
                  {product.landing_url}
                </a>
              ) : null}
            </TableCell>
            <TableCell>{product.price_hint ? <bdi>{product.price_hint}</bdi> : null}</TableCell>
            <TableCell>
              <p className="text-muted-foreground text-xs">{t("products.assetCount", { count: product.assets.length })}</p>
              <ul className="mt-1 flex flex-wrap gap-1">
                {linksOf(product).map((file) => (
                  <li key={file.path}>
                    {file.url ? (
                      <a
                        href={file.url}
                        {...(file.image ? { target: "_blank" } : {})}
                        rel="noopener noreferrer"
                        dir="ltr"
                        className="text-primary-text block max-w-32 truncate text-xs underline underline-offset-2"
                        aria-label={file.image ? t("files.open", { name: file.name }) : t("files.download", { name: file.name })}
                      >
                        {file.name}
                      </a>
                    ) : (
                      <span dir="ltr" className="block max-w-32 truncate text-xs">
                        {file.name}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </TableCell>
            {canEdit ? (
              <TableCell className="text-end">
                <ProductDialog organizationId={organizationId} projectId={projectId} product={product} files={linksOf(product)} />
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
