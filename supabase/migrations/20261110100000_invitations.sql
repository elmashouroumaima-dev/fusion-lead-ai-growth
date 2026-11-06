-- J10 — Invitations d'adhésion (ADR 007 G-R8, ADR 014, ADR 005 §5–§6, menace B6).
-- Sources : spec §2, §11, §13-2 ; ADR 005 ; ADR 006 ; ADR 007 (G-R8) ; ADR 014 (membres, propriété).
-- Retour arrière : supabase/rollbacks/20261110100000_invitations.sql
--
-- Décisions validées par la responsable technique (J10) :
--  * durée de validité d'une invitation = 7 jours (constante c_validity dans create_invitation) ;
--  * l'acceptation exige que l'e-mail CONFIRMÉ du compte (auth.users.email, en minuscules,
--    email_confirmed_at non nul) soit égal à email_normalized ; TOUT échec d'acceptation renvoie la
--    même erreur générique (P0001 'invitation_invalid') : rien ne fuit sur la cause ;
--  * ré-inviter une adresse révoque l'invitation en attente précédente et en crée une nouvelle,
--    dans la même transaction ;
--  * le jeton n'est JAMAIS stocké : seul son sha256 (64 hexadécimaux) l'est (menace B6) ;
--  * authenticated ne lit jamais token_hash (GRANT SELECT par colonne) : le hash est la preuve
--    présentée à accept_invitation, il ne doit donc pas être lisible, même par owner/admin ;
--  * changement de rôle / retrait d'un membre : mécanismes J7 existants (UPDATE role/status sous RLS),
--    aucune fonction nouvelle ici ; transfert de propriété : private.transfer_ownership.
--
-- Révision avant première application (exception délibérée, validée) : cette migration n'a jamais été
-- commitée ni appliquée hors de la base locale de développement ; elle est donc modifiée en place
-- (avec son retour arrière) au lieu d'ajouter une migration corrective. Révision : (1) accept_invitation
-- revérifie l'inviteur ; (2) transfer_ownership verrouille les lignes AVANT le verrou consultatif
-- (même ordre que protect_last_owner) ; (3) e-mail restreint à l'ASCII imprimable sans espace.
--
-- Sécurité (même schéma que J9) :
--  * fonctions private.* SECURITY DEFINER, search_path vide, noms qualifiés ; l'identité vient
--    UNIQUEMENT de auth.uid() (aucun paramètre « user id ») ; non authentifié => 28000 'unauthenticated' ;
--  * wrappers public.* SECURITY INVOKER (L10 : aucune SECURITY DEFINER dans public) ;
--  * EXECUTE retiré de PUBLIC / anon / service_role, accordé à authenticated seul ;
--  * aucune politique ni GRANT d'écriture sur invitations : toute écriture passe par ces fonctions.
-- Journal d'audit (J11) et idempotence générique (J12) : non construits ici.

-- ---------------------------------------------------------------------------
-- Table invitations
-- ---------------------------------------------------------------------------
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  email_normalized text not null,
  role public.app_role not null,
  token_hash text not null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invitations_token_hash_key unique (token_hash),
  constraint invitations_org_id_key unique (organization_id, id),
  constraint invitations_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint invitations_email_normalized check (
    email_normalized = lower(btrim(email_normalized))
    and char_length(email_normalized) <= 254
    and email_normalized ~ '^[!-~]+$'
    and email_normalized ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint invitations_not_accepted_and_revoked check (
    accepted_at is null or revoked_at is null
  )
);
comment on table public.invitations is
  'Invitations d''adhésion (G-R8). Le jeton n''est jamais stocké : seulement son sha256. Écriture par fonctions serveur uniquement.';
comment on column public.invitations.token_hash is
  'sha256 hexadécimal du jeton ; illisible par authenticated (GRANT SELECT par colonne).';

create index invitations_org_created_idx on public.invitations (organization_id, created_at desc);

-- Une seule invitation EN ATTENTE par (entreprise, e-mail).
create unique index invitations_org_email_pending_key
  on public.invitations (organization_id, email_normalized)
  where accepted_at is null and revoked_at is null;

create trigger set_updated_at before update on public.invitations
  for each row execute function private.set_updated_at();
create trigger prevent_organization_id_change
  before update of organization_id on public.invitations
  for each row execute function private.prevent_organization_id_change();

-- ---------------------------------------------------------------------------
-- RLS : lecture owner/admin de l'entreprise ; aucun droit d'écriture ; anon rien
-- ---------------------------------------------------------------------------
alter table public.invitations enable row level security;
revoke all on table public.invitations from anon, authenticated;

grant select (
  id, organization_id, email_normalized, role, expires_at, accepted_at, accepted_by,
  revoked_at, invited_by, created_at, updated_at
) on table public.invitations to authenticated;

create policy invitations_select on public.invitations
  for select to authenticated
  using (private.has_role(organization_id, array['company_owner', 'company_admin']::public.app_role[]));

-- ---------------------------------------------------------------------------
-- private.create_invitation
-- ---------------------------------------------------------------------------
create function private.create_invitation(
  p_org uuid,
  p_email text,
  p_role public.app_role,
  p_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Durée de validité d'une invitation (décision J10) : 7 jours.
  c_validity constant interval := interval '7 days';
  v_uid uuid;
  v_caller_role public.app_role;
  v_raw text;
  v_email text;
  v_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  -- Autorisation d'abord (aucune validation n'est révélée à un non-habilité).
  if p_org is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select m.role into v_caller_role
    from public.organization_members m
   where m.organization_id = p_org and m.user_id = v_uid and m.status = 'active';
  if v_caller_role is null or v_caller_role not in ('company_owner', 'company_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- ADR 014 : un admin ne peut jamais attribuer company_owner.
  if p_role = 'company_owner' and v_caller_role <> 'company_owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Validation (les messages ne contiennent jamais la valeur saisie).
  -- E-mail : ASCII imprimable sans espace UNIQUEMENT (ni bidi, ni largeur nulle, ni contrôle, ni
  -- non-ASCII). Le contrôle porte sur la saisie AVANT lower() : certains caractères non ASCII
  -- (ex. U+212A, signe Kelvin) se transforment en ASCII par lower() et passeraient sinon.
  v_raw := btrim(p_email);
  v_email := lower(v_raw);
  if p_role is null
     or v_raw is null
     or char_length(v_raw) > 254
     or v_raw !~ '^[!-~]+$'
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'validation_failed' using errcode = '22023', detail = 'email';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'validation_failed' using errcode = '22023', detail = 'token_hash';
  end if;

  -- Sérialise les invitations simultanées pour la même adresse dans la même entreprise.
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text || ':' || v_email, 0));

  if exists (
    select 1
      from public.organization_members m
      join auth.users u on u.id = m.user_id
     where m.organization_id = p_org
       and m.status = 'active'
       and lower(btrim(u.email)) = v_email
  ) then
    raise exception 'already_member' using errcode = 'P0001';
  end if;

  -- Ré-invitation : l'invitation en attente précédente est révoquée (son jeton cesse de fonctionner).
  update public.invitations i
     set revoked_at = now()
   where i.organization_id = p_org
     and i.email_normalized = v_email
     and i.accepted_at is null
     and i.revoked_at is null;

  insert into public.invitations (organization_id, email_normalized, role, token_hash, expires_at, invited_by)
  values (p_org, v_email, p_role, p_token_hash, now() + c_validity, v_uid)
  returning id into v_id;

  -- J11 : l'écriture au journal d'audit (sans e-mail ni jeton) sera ajoutée ici.
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.revoke_invitation
-- ---------------------------------------------------------------------------
create function private.revoke_invitation(p_org uuid, p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_caller_role public.app_role;
  v_inv public.invitations%rowtype;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if p_org is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select m.role into v_caller_role
    from public.organization_members m
   where m.organization_id = p_org and m.user_id = v_uid and m.status = 'active';
  if v_caller_role is null or v_caller_role not in ('company_owner', 'company_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select i.* into v_inv
    from public.invitations i
   where i.id = p_invitation_id and i.organization_id = p_org
   for update;
  if not found then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;
  if v_inv.role = 'company_owner' and v_caller_role <> 'company_owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_inv.accepted_at is not null or v_inv.revoked_at is not null then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;

  update public.invitations set revoked_at = now() where id = v_inv.id;
  -- J11 : audit de la révocation.
end;
$$;

-- ---------------------------------------------------------------------------
-- private.accept_invitation : TOUT échec => 'invitation_invalid' (identique, aucune fuite)
-- ---------------------------------------------------------------------------
create function private.accept_invitation(p_token_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_inv public.invitations%rowtype;
  v_email text;
  v_confirmed timestamptz;
  v_member public.organization_members%rowtype;
  v_inviter_role public.app_role;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;

  -- Verrou de ligne : deux acceptations simultanées sont sérialisées (une seule réussit).
  select i.* into v_inv
    from public.invitations i
   where i.token_hash = p_token_hash
   for update;
  if not found then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;

  select lower(btrim(u.email)), u.email_confirmed_at into v_email, v_confirmed
    from auth.users u
   where u.id = v_uid;

  if v_inv.accepted_at is not null
     or v_inv.revoked_at is not null
     or v_inv.expires_at <= now()
     or v_confirmed is null
     or v_email is null
     or v_email <> v_inv.email_normalized then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;

  -- Ré-vérification de l'inviteur AU MOMENT de l'acceptation (ADR 014) : il doit être encore
  -- owner/admin ACTIF de l'entreprise (et owner actif si le rôle invité est company_owner).
  -- invited_by NULL (compte supprimé) => aucune ligne => invalide. Même erreur générique.
  -- Lecture sans verrou volontaire : un FOR SHARE ici inverserait l'ordre des verrous de lignes
  -- par rapport à transfer_ownership / protect_last_owner.
  select m.role into v_inviter_role
    from public.organization_members m
   where m.organization_id = v_inv.organization_id
     and m.user_id = v_inv.invited_by
     and m.status = 'active';
  if v_inviter_role is null
     or v_inviter_role not in ('company_owner', 'company_admin')
     or (v_inv.role = 'company_owner' and v_inviter_role <> 'company_owner') then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;

  select m.* into v_member
    from public.organization_members m
   where m.organization_id = v_inv.organization_id and m.user_id = v_uid
   for update;

  if not found then
    begin
      insert into public.organization_members (organization_id, user_id, role, status, invited_by)
      values (v_inv.organization_id, v_uid, v_inv.role, 'active', v_inv.invited_by);
    exception when unique_violation then
      raise exception 'invitation_invalid' using errcode = 'P0001';
    end;
  elsif v_member.status in ('removed', 'invited') then
    -- Ré-activation avec le rôle de l'invitation.
    update public.organization_members
       set role = v_inv.role, status = 'active', invited_by = v_inv.invited_by
     where id = v_member.id;
  else
    -- 'active' (déjà membre) ou 'suspended' (suspension non contournable par invitation).
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;

  update public.invitations
     set accepted_at = now(), accepted_by = v_uid
   where id = v_inv.id;

  -- J11 : audit de l'acceptation.
  return v_inv.organization_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.transfer_ownership : promotion de la cible + rétrogradation de l'appelant, atomiques
-- ---------------------------------------------------------------------------
create function private.transfer_ownership(p_org uuid, p_new_owner uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_caller public.organization_members%rowtype;
  v_target public.organization_members%rowtype;
  v_row public.organization_members%rowtype;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if p_org is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Pré-contrôle SANS verrou : un non-owner ne verrouille jamais rien.
  if not exists (
    select 1 from public.organization_members m
     where m.organization_id = p_org and m.user_id = v_uid
       and m.status = 'active' and m.role = 'company_owner'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_new_owner is null or p_new_owner = v_uid then
    raise exception 'invalid_target' using errcode = 'P0001';
  end if;

  -- ORDRE DES VERROUS (identique à protect_last_owner : lignes d'abord, verrou consultatif ensuite) :
  -- 1) lignes de l'appelant et de la cible, en ordre d'id déterministe ; 2) verrou consultatif.
  -- Le trigger verrouille sa ligne (UPDATE) puis prend le verrou consultatif : l'ordre inverse
  -- (consultatif puis lignes) provoquait un interblocage possible.
  for v_row in
    select m.* from public.organization_members m
     where m.organization_id = p_org and m.user_id in (v_uid, p_new_owner)
     order by m.id
       for update
  loop
    if v_row.user_id = v_uid then v_caller := v_row; else v_target := v_row; end if;
  end loop;

  -- Re-validation sur les lignes verrouillées (l'état a pu changer depuis le pré-contrôle).
  if v_caller.id is null or v_caller.status <> 'active' or v_caller.role <> 'company_owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_target.id is null or v_target.status <> 'active' or v_target.role = 'company_owner' then
    raise exception 'invalid_target' using errcode = 'P0001';
  end if;

  -- Même verrou consultatif que protect_last_owner (ré-entrant dans la session).
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text, 0));

  -- Promotion d'abord (deux owners actifs), puis rétrogradation : protect_last_owner reste satisfait.
  update public.organization_members set role = 'company_owner' where id = v_target.id;
  update public.organization_members set role = 'company_admin' where id = v_caller.id;
  -- J11 : audit du transfert de propriété.
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilèges des fonctions privées : authenticated seul
-- ---------------------------------------------------------------------------
revoke all on function private.create_invitation(uuid, text, public.app_role, text) from public, anon, service_role;
revoke all on function private.revoke_invitation(uuid, uuid) from public, anon, service_role;
revoke all on function private.accept_invitation(text) from public, anon, service_role;
revoke all on function private.transfer_ownership(uuid, uuid) from public, anon, service_role;
grant execute on function private.create_invitation(uuid, text, public.app_role, text) to authenticated;
grant execute on function private.revoke_invitation(uuid, uuid) to authenticated;
grant execute on function private.accept_invitation(text) to authenticated;
grant execute on function private.transfer_ownership(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Wrappers SECURITY INVOKER exposés à la Data API (POST /rpc/<nom>)
-- ---------------------------------------------------------------------------
create function public.create_invitation(
  p_org uuid,
  p_email text,
  p_role public.app_role,
  p_token_hash text
)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  select private.create_invitation(p_org, p_email, p_role, p_token_hash);
$$;

create function public.revoke_invitation(p_org uuid, p_invitation_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.revoke_invitation(p_org, p_invitation_id);
$$;

create function public.accept_invitation(p_token_hash text)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  select private.accept_invitation(p_token_hash);
$$;

create function public.transfer_ownership(p_org uuid, p_new_owner uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.transfer_ownership(p_org, p_new_owner);
$$;

revoke all on function public.create_invitation(uuid, text, public.app_role, text) from public, anon, service_role;
revoke all on function public.revoke_invitation(uuid, uuid) from public, anon, service_role;
revoke all on function public.accept_invitation(text) from public, anon, service_role;
revoke all on function public.transfer_ownership(uuid, uuid) from public, anon, service_role;
grant execute on function public.create_invitation(uuid, text, public.app_role, text) to authenticated;
grant execute on function public.revoke_invitation(uuid, uuid) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.transfer_ownership(uuid, uuid) to authenticated;
