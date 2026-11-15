"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export type RuleView = { id: string; projectId: string | null; projectName: string | null; strategy: "round_robin" | "fixed"; memberIds: string[]; active: boolean };
export type MemberOption = { userId: string; label: string };
export type ProjectOption = { id: string; name: string };

type Props = { rules: RuleView[]; members: MemberOption[]; projects: ProjectOption[] };
type Draft = { id: string | null; projectId: string; strategy: "round_robin" | "fixed"; memberIds: string[]; active: boolean };

const selectClass = "border-input bg-background h-9 w-full rounded-md border px-2 text-sm";

async function post(path: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(payload),
  });
}

/**
 * Règles d'assignation (J39b, spec §5.3) : créer, modifier (stratégie, membres, actif) et supprimer. « fixed » exige exactement un membre.
 * Owner et admin ; le serveur et la base revérifient le rôle, les membres éligibles (actifs, owner / admin / commercial) et l'entreprise.
 */
export function RulesManager({ rules, members, projects }: Props) {
  const t = useTranslations("Assignment");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const label = (userId: string): string => members.find((member) => member.userId === userId)?.label ?? t("memberUnknown");

  function fail(status: number): void {
    const text = status === 403 ? t("forbidden") : status === 400 ? t("invalid") : status === 409 ? t("conflict") : t("failed");
    setError(text);
    toast.error(text);
  }

  async function run(request: () => Promise<Response>, done: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await request();
      if (response.ok) {
        toast.success(done);
        setDraft(null);
        setDeleting(null);
        router.refresh();
      } else {
        fail(response.status);
      }
    } catch {
      setError(t("failed"));
      toast.error(t("failed"));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!draft) return;
    if (draft.id) {
      const id = draft.id;
      void run(() => post("/api/assignment/rules/update", { rule_id: id, strategy: draft.strategy, eligible_member_ids: draft.memberIds, active: draft.active }), t("updated"));
    } else {
      void run(
        () => post("/api/assignment/rules", { ...(draft.projectId === "" ? {} : { project_id: draft.projectId }), strategy: draft.strategy, eligible_member_ids: draft.memberIds }),
        t("created"),
      );
    }
  }

  const toggleMember = (userId: string): void => {
    if (!draft) return;
    const has = draft.memberIds.includes(userId);
    setDraft({ ...draft, memberIds: has ? draft.memberIds.filter((id) => id !== userId) : [...draft.memberIds, userId] });
  };

  return (
    <div className="grid gap-4">
      {rules.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      ) : (
        <ul className="grid gap-3">
          {rules.map((rule) => (
            <li key={rule.id} className="grid gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{rule.projectId === null ? t("defaultRule") : <bdi>{rule.projectName ?? t("projectUnknown")}</bdi>}</span>
                <Badge variant="secondary">{t(`strategy.${rule.strategy}`)}</Badge>
                <Badge variant={rule.active ? "success" : "outline"}>{rule.active ? t("active") : t("inactive")}</Badge>
              </div>
              <p className="text-muted-foreground text-xs">{rule.memberIds.map(label).join(", ")}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setDraft({ id: rule.id, projectId: rule.projectId ?? "", strategy: rule.strategy, memberIds: rule.memberIds, active: rule.active })}>
                  {t("edit")}
                </Button>
                {deleting === rule.id ? (
                  <>
                    <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void run(() => post("/api/assignment/rules/delete", { rule_id: rule.id }), t("deleted"))}>
                      {t("confirmDelete")}
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setDeleting(null)}>
                      {t("cancel")}
                    </Button>
                  </>
                ) : (
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setDeleting(rule.id)}>
                    {t("delete")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {draft === null ? (
        <div>
          <Button type="button" onClick={() => setDraft({ id: null, projectId: "", strategy: "round_robin", memberIds: [], active: true })}>
            {t("new")}
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-3 rounded-md border p-3">
          <h3 className="font-medium">{draft.id ? t("editTitle") : t("newTitle")}</h3>
          {draft.id ? null : (
            <div className="grid gap-1">
              <Label htmlFor="rule-project">{t("project")}</Label>
              <select id="rule-project" className={selectClass} value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}>
                <option value="">{t("defaultRule")}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid gap-1">
            <Label htmlFor="rule-strategy">{t("strategyLabel")}</Label>
            <select
              id="rule-strategy"
              className={selectClass}
              value={draft.strategy}
              onChange={(event) => setDraft({ ...draft, strategy: event.target.value === "fixed" ? "fixed" : "round_robin" })}
            >
              <option value="round_robin">{t("strategy.round_robin")}</option>
              <option value="fixed">{t("strategy.fixed")}</option>
            </select>
            {draft.strategy === "fixed" ? <p className="text-muted-foreground text-xs">{t("fixedHelp")}</p> : null}
          </div>
          <fieldset className="grid gap-1">
            <legend className="text-sm font-medium">{t("membersLabel")}</legend>
            {members.map((member) => (
              <label key={member.userId} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.memberIds.includes(member.userId)} onChange={() => toggleMember(member.userId)} />
                <span>{member.label}</span>
              </label>
            ))}
          </fieldset>
          {draft.id ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} />
              <span>{t("active")}</span>
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || draft.memberIds.length === 0}>
              {t("save")}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(null)}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-destructive-text text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
