"use client";

import { IMPORT_FIELDS, IMPORT_MAX_BYTES, type ImportField, type ImportReason } from "@fusion-leap/domain";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { guessMapping } from "../../lib/imports/guess-mapping";

export type ProjectOption = { id: string; name: string };

type Uploaded = { batchId: string; rowCount: number; columns: string[] };
type Preview = {
  rowCount: number;
  valid: number;
  newContacts: number;
  existingContacts: number;
  duplicatesInFile: number;
  errors: number;
  errorsByReason: Partial<Record<ImportReason, number>>;
  errorRows: Array<{ rowNo: number; reason: ImportReason }>;
  rows: Array<{ rowNo: number; cells: string[]; status: "new" | "existing" | "duplicate_in_file" | "error"; reason: ImportReason | null }>;
};
type Step = "upload" | "mapping" | "confirm" | "queued";
type MappingState = Partial<Record<ImportField, number>>;

const selectClass = "border-input bg-background h-9 w-full rounded-md border px-2 text-sm";

const idempotencyKey = (): string => crypto.randomUUID();

async function postJson(path: string, payload: unknown, withKey = false): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(withKey ? { "idempotency-key": idempotencyKey() } : {}) },
    body: JSON.stringify(payload),
  });
}

/**
 * Assistant d'import CSV en trois étapes (J39c, spec §9.1) : envoi du fichier, correspondance des colonnes avec aperçu, confirmation.
 * RIEN n'est écrit dans les contacts avant la confirmation (l'envoi et l'aperçu ne créent qu'un lot « envoyé » sans effet). L'aperçu contient
 * des cellules du fichier : elles restent dans l'état de ce composant (ni URL, ni stockage du navigateur, ni journal) et disparaissent avec lui.
 * Le serveur revérifie le rôle (owner, admin), l'entreprise et chaque règle ; l'écran n'est qu'une aide.
 */
export function ImportWizard({ projects }: { projects: ProjectOption[] }) {
  const t = useTranslations("Imports");
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [mapping, setMapping] = useState<MappingState>({});
  const [country, setCountry] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);

  function failure(status: number): void {
    const text = status === 403 ? t("errors.forbidden") : status === 400 ? t("errors.invalid") : status === 409 ? t("errors.conflict") : status === 404 ? t("errors.notFound") : t("errors.generic");
    setError(text);
    toast.error(text);
  }

  function reset(): void {
    setStep("upload");
    setFile(null);
    setUploaded(null);
    setMapping({});
    setCountry("");
    setPreview(null);
    setError(null);
  }

  async function upload(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !file || projectId === "") return;
    if (file.size === 0 || file.size > IMPORT_MAX_BYTES) {
      setError(t("errors.tooLarge"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/imports?project_id=${encodeURIComponent(projectId)}`, { method: "POST", headers: { "content-type": "text/csv" }, body: file });
      if (!response.ok) {
        failure(response.status);
        return;
      }
      const body = (await response.json()) as { batch_id?: unknown; row_count?: unknown; columns?: unknown };
      if (typeof body.batch_id !== "string" || typeof body.row_count !== "number" || !Array.isArray(body.columns)) {
        setError(t("errors.generic"));
        return;
      }
      const columns = body.columns.map((column) => String(column));
      setUploaded({ batchId: body.batch_id, rowCount: body.row_count, columns });
      setMapping(guessMapping(columns));
      setStep("mapping");
    } catch {
      setError(t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  const mappingBody = () => ({
    batch_id: uploaded?.batchId,
    mapping: Object.fromEntries(Object.entries(mapping).filter(([, value]) => typeof value === "number")),
    default_country: country.trim() === "" ? null : country.trim().toUpperCase(),
  });
  const hasIdentifier = mapping.email !== undefined || mapping.phone !== undefined;

  async function runPreview(): Promise<void> {
    if (busy || !uploaded || !hasIdentifier) return;
    setBusy(true);
    setError(null);
    try {
      const response = await postJson("/api/imports/preview", mappingBody());
      if (!response.ok) {
        failure(response.status);
        return;
      }
      const body = (await response.json()) as { preview?: Preview };
      if (!body.preview) {
        setError(t("errors.generic"));
        return;
      }
      setPreview(body.preview);
      setStep("confirm");
    } catch {
      setError(t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    if (busy || !uploaded) return;
    setBusy(true);
    setError(null);
    try {
      const response = await postJson("/api/imports/confirm", mappingBody(), true);
      if (!response.ok) {
        failure(response.status);
        return;
      }
      toast.success(t("confirm.queued"));
      setStep("queued");
      setPreview(null);
      router.refresh();
    } catch {
      setError(t("errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (busy || !uploaded) return;
    setBusy(true);
    try {
      await postJson("/api/imports/cancel", { batch_id: uploaded.batchId }, true);
      toast.success(t("confirm.cancelled"));
      router.refresh();
    } catch {
      // le lot « envoyé » non confirmé reste sans effet : on repart quand même d'un écran propre
    } finally {
      setBusy(false);
      reset();
    }
  }

  const stepIndex = step === "upload" ? 1 : step === "mapping" ? 2 : 3;

  return (
    <div className="grid gap-4">
      <ol className="text-muted-foreground flex flex-wrap gap-3 text-sm" aria-label={t("steps.label")}>
        {(["upload", "mapping", "confirm"] as const).map((key, index) => (
          <li key={key} aria-current={stepIndex === index + 1 ? "step" : undefined} className={stepIndex === index + 1 ? "text-foreground font-medium" : undefined}>
            {index + 1}. {t(`steps.${key}`)}
          </li>
        ))}
      </ol>

      {step === "upload" ? (
        <form onSubmit={(event) => void upload(event)} className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="import-project">{t("upload.project")}</Label>
            <select id="import-project" className={selectClass} value={projectId} onChange={(event) => setProjectId(event.target.value)} required>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="import-file">{t("upload.file")}</Label>
            <Input id="import-file" type="file" accept=".csv,text/csv,text/plain" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required />
            <p className="text-muted-foreground text-xs">{t("upload.help")}</p>
          </div>
          <div>
            <Button type="submit" disabled={busy || !file || projectId === ""}>
              {busy ? t("upload.sending") : t("upload.send")}
            </Button>
          </div>
        </form>
      ) : null}

      {step === "mapping" && uploaded ? (
        <div className="grid gap-3">
          <p className="text-sm">{t("upload.read", { rows: uploaded.rowCount, columns: uploaded.columns.length })}</p>
          <p className="text-muted-foreground text-sm">{t("mapping.help")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {IMPORT_FIELDS.map((field) => (
              <div key={field} className="grid min-w-0 grid-cols-1 gap-1">
                <Label htmlFor={`map-${field}`}>{t(`mapping.fields.${field}`)}</Label>
                <select
                  id={`map-${field}`}
                  className={selectClass}
                  value={mapping[field] === undefined ? "" : String(mapping[field])}
                  onChange={(event) => {
                    const next = { ...mapping };
                    if (event.target.value === "") delete next[field];
                    else next[field] = Number(event.target.value);
                    setMapping(next);
                  }}
                >
                  <option value="">{t("mapping.none")}</option>
                  {uploaded.columns.map((column, index) => (
                    <option key={index} value={index} disabled={Object.entries(mapping).some(([key, value]) => key !== field && value === index)}>
                      {index + 1}. {column}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div className="grid min-w-0 grid-cols-1 gap-1">
              <Label htmlFor="map-country-default">{t("mapping.defaultCountry")}</Label>
              <Input id="map-country-default" dir="ltr" maxLength={2} value={country} onChange={(event) => setCountry(event.target.value.toUpperCase())} />
              <p className="text-muted-foreground text-xs">{t("mapping.defaultCountryHelp")}</p>
            </div>
          </div>
          {!hasIdentifier ? <p className="text-muted-foreground text-xs">{t("mapping.identifierRequired")}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy || !hasIdentifier} onClick={() => void runPreview()}>
              {busy ? t("mapping.previewing") : t("mapping.preview")}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>
              {t("confirm.cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {step === "confirm" && uploaded && preview ? (
        <div className="grid gap-4">
          <Alert role="status">
            <AlertDescription>{t("preview.noneWritten")}</AlertDescription>
          </Alert>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            {(
              [
                ["rows", preview.rowCount],
                ["valid", preview.valid],
                ["newContacts", preview.newContacts],
                ["existing", preview.existingContacts],
                ["duplicates", preview.duplicatesInFile],
                ["errors", preview.errors],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className="rounded-md border p-3">
                <dt className="text-muted-foreground text-xs">{t(`preview.${key}`)}</dt>
                <dd className="text-lg font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
          {Object.keys(preview.errorsByReason).length > 0 ? (
            <div className="grid gap-1">
              <h3 className="text-sm font-medium">{t("preview.errorsByReason")}</h3>
              <ul className="text-sm">
                {(Object.entries(preview.errorsByReason) as Array<[ImportReason, number]>).map(([reason, count]) => (
                  <li key={reason}>
                    {t(`reasons.${reason}`)} : {count}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {preview.rows.length > 0 ? (
            <div className="grid gap-1">
              <h3 className="text-sm font-medium">{t("preview.sample")}</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-start text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b">
                      <th className="py-1 pe-2 text-start font-medium">{t("preview.row")}</th>
                      <th className="py-1 pe-2 text-start font-medium">{t("preview.status")}</th>
                      {uploaded.columns.map((column, index) => (
                        <th key={index} className="py-1 pe-2 text-start font-medium">
                          <bdi>{column}</bdi>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.rowNo} className="border-b last:border-0">
                        <td className="py-1 pe-2">{row.rowNo}</td>
                        <td className="py-1 pe-2">
                          <Badge variant={row.status === "error" ? "destructive" : row.status === "new" ? "success" : "secondary"}>
                            {row.status === "error" && row.reason ? t(`reasons.${row.reason}`) : t(`status.${row.status}`)}
                          </Badge>
                        </td>
                        {uploaded.columns.map((_, index) => (
                          <td key={index} className="py-1 pe-2" dir="auto">
                            {row.cells[index] ?? ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          <p className="text-sm">{t("confirm.warn", { valid: preview.valid })}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy || preview.valid === 0} onClick={() => void confirm()}>
              {busy ? t("confirm.confirming") : t("confirm.button")}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setStep("mapping")}>
              {t("preview.back")}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>
              {t("confirm.cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {step === "queued" ? (
        <div className="grid gap-3">
          <Alert role="status">
            <AlertDescription>{t("confirm.queued")}</AlertDescription>
          </Alert>
          <div>
            <Button type="button" variant="outline" onClick={reset}>
              {t("confirm.another")}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-destructive-text text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
