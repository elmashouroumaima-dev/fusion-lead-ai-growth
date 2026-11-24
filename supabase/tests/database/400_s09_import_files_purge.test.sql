-- S-09 : purge des fichiers d'import. Lots « uploaded » abandonnés annulés (place libérée), fichiers des lots terminés dus à la purge puis marqués purgés, objets du bucket sans lot
-- repérés. Fonctions réservées à service_role. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into public.organizations (id, name, slug) values ('ebd00000-0000-4000-8000-00000000000a', 'S9 Alpha', 's9-alpha-test');
insert into public.subscriptions (organization_id, plan_id, status) values ('ebd00000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active');
insert into public.projects (id, organization_id, type, name, status, settings) values ('ecd00000-0000-4000-8000-0000000000a1', 'ebd00000-0000-4000-8000-00000000000a', 'custom', 'S9 projet', 'active', '{}');

-- lots : u1 (uploaded, vieux de 2 jours), u2 (uploaded, récent), d1 (done, fini il y a 1 heure), d2 (done, fini il y a 2 minutes), f1 (failed, fini il y a 1 heure),
-- c1 (cancelled, déjà purgé), q1 (queued, vieux de 2 jours : jamais touché)
insert into public.import_batches (id, organization_id, project_id, status, file_path, file_size, mapping, created_at, finished_at, file_purged_at) values
  ('e1d00000-0000-4000-8000-000000000001', 'ebd00000-0000-4000-8000-00000000000a', 'ecd00000-0000-4000-8000-0000000000a1', 'uploaded', 'ebd00000-0000-4000-8000-00000000000a/e1d00000-0000-4000-8000-000000000001.csv', 100, null, now() - interval '2 days', null, null),
  ('e1d00000-0000-4000-8000-000000000002', 'ebd00000-0000-4000-8000-00000000000a', 'ecd00000-0000-4000-8000-0000000000a1', 'uploaded', 'ebd00000-0000-4000-8000-00000000000a/e1d00000-0000-4000-8000-000000000002.csv', 100, null, now() - interval '5 minutes', null, null);
insert into public.import_batches (id, organization_id, project_id, status, file_path, file_size, mapping, created_at, finished_at, file_purged_at)
select b.id, 'ebd00000-0000-4000-8000-00000000000a', 'ecd00000-0000-4000-8000-0000000000a1', b.st, 'ebd00000-0000-4000-8000-00000000000a/' || b.id || '.csv', 100,
       '{"email": 0}'::jsonb, now() - interval '3 hours', b.fin, b.purged
  from (values
    ('e1d00000-0000-4000-8000-0000000000d1'::uuid, 'done', now() - interval '1 hour', null::timestamptz),
    ('e1d00000-0000-4000-8000-0000000000d2'::uuid, 'done', now() - interval '2 minutes', null),
    ('e1d00000-0000-4000-8000-0000000000f1'::uuid, 'failed', now() - interval '1 hour', null),
    ('e1d00000-0000-4000-8000-0000000000c1'::uuid, 'cancelled', now() - interval '1 hour', now() - interval '30 minutes'),
    ('e1d00000-0000-4000-8000-0000000000a1'::uuid, 'queued', null, null)
  ) as b(id, st, fin, purged);
update public.import_batches set created_at = now() - interval '2 days' where id = 'e1d00000-0000-4000-8000-0000000000a1';

select is((select private.import_expire_stale(interval '24 hours')), 1, 'un seul lot « uploaded » est abandonné (celui de 2 jours) : annulé');
select is((select status from public.import_batches where id = 'e1d00000-0000-4000-8000-000000000001'), 'cancelled', 'le lot abandonné est annulé (sa place est libérée)');
select is((select status from public.import_batches where id = 'e1d00000-0000-4000-8000-000000000002'), 'uploaded', 'un lot « uploaded » récent n''est pas touché');
select is((select status from public.import_batches where id = 'e1d00000-0000-4000-8000-0000000000a1'), 'queued', 'un lot « queued » n''est jamais touché, même vieux');

select is((select array_agg(batch_id order by batch_id) from private.import_files_due(100)),
  array['e1d00000-0000-4000-8000-0000000000d1', 'e1d00000-0000-4000-8000-0000000000f1']::uuid[],
  'fichiers dus : fait et échoué depuis plus de 10 minutes ; ni le lot abandonné tout juste annulé (délai de grâce de 10 minutes), ni le lot de 2 minutes, ni le lot déjà purgé, ni les lots non terminés');

select private.import_file_purged('ebd00000-0000-4000-8000-00000000000a', 'e1d00000-0000-4000-8000-0000000000d1');
select ok((select file_purged_at is not null from public.import_batches where id = 'e1d00000-0000-4000-8000-0000000000d1'), 'un lot terminé est marqué purgé');
select is((select count(*)::int from private.import_files_due(100) where batch_id = 'e1d00000-0000-4000-8000-0000000000d1'), 0, 'un lot purgé n''est plus dû');
select private.import_file_purged('ebd00000-0000-4000-8000-00000000000a', 'e1d00000-0000-4000-8000-000000000002');
select ok((select file_purged_at is null from public.import_batches where id = 'e1d00000-0000-4000-8000-000000000002'), 'un lot non terminé ne peut pas être marqué purgé');

-- objets du bucket : un orphelin ancien (sans lot) est repéré ; un objet récent et l'objet d'un lot connu ne le sont pas
insert into storage.objects (bucket_id, name, created_at) values
  ('imports', 'ebd00000-0000-4000-8000-00000000000a/e1d00000-0000-4000-8000-0000000000e1.csv', now() - interval '3 days'),
  ('imports', 'ebd00000-0000-4000-8000-00000000000a/e1d00000-0000-4000-8000-0000000000e2.csv', now() - interval '5 minutes'),
  ('imports', 'ebd00000-0000-4000-8000-00000000000a/e1d00000-0000-4000-8000-0000000000d2.csv', now() - interval '3 days');
select is((select array_agg(name) from private.import_orphan_files(interval '24 hours', 100) where name like 'ebd00000-0000-4000-8000-00000000000a/e1d00000-0000-4000-8000-0000000000e%'),
  array['ebd00000-0000-4000-8000-00000000000a/e1d00000-0000-4000-8000-0000000000e1.csv'], 'orphelin ancien repéré ; objet récent et objet d''un lot connu ignorés');

-- droits : service_role seulement
select ok(has_function_privilege('service_role', 'public.import_expire_stale(interval)', 'execute') and has_function_privilege('service_role', 'public.import_files_due(integer)', 'execute')
  and has_function_privilege('service_role', 'public.import_file_purged(uuid, uuid)', 'execute') and has_function_privilege('service_role', 'public.import_orphan_files(interval, integer)', 'execute'), 'service_role exécute les quatre fonctions');
select ok(not has_function_privilege('authenticated', 'public.import_expire_stale(interval)', 'execute') and not has_function_privilege('anon', 'public.import_files_due(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.import_file_purged(uuid, uuid)', 'execute') and not has_function_privilege('authenticated', 'public.import_orphan_files(interval, integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.import_files_due(integer)', 'execute'), 'ni authenticated ni anon n''en exécutent aucune');
select throws_ok($$select private.import_expire_stale(interval '5 minutes')$$, '22023', null, 'un intervalle de moins d''une heure est refusé (on n''annule pas un envoi en cours)');

select * from finish();
rollback;
