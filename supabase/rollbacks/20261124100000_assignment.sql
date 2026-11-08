-- Retour arrière de 20261124100000_assignment.sql
-- ATTENTION : supprime TOUTES les règles d'assignation et TOUTES les notifications. Les leads déjà assignés restent assignés ;
-- les jobs `lead.assign` en attente seront traités par le handler provisoire (sans effet) du worker précédent.

drop function if exists public.flag_lead_unassigned(uuid, uuid);
drop function if exists public.auto_assign_lead(uuid, uuid);
drop function if exists public.mark_notification_read(uuid, uuid);
drop function if exists public.delete_assignment_rule(uuid, uuid);
drop function if exists public.update_assignment_rule(uuid, uuid, text, uuid[], boolean);
drop function if exists public.create_assignment_rule(uuid, uuid, text, uuid[]);

drop function if exists private.flag_lead_unassigned(uuid, uuid);
drop function if exists private.auto_assign_lead(uuid, uuid);
drop function if exists private.mark_notification_read(uuid, uuid);
drop function if exists private.notify_lead_unassigned(uuid, uuid, text);
drop function if exists private.delete_assignment_rule(uuid, uuid);
drop function if exists private.update_assignment_rule(uuid, uuid, text, uuid[], boolean);
drop function if exists private.create_assignment_rule(uuid, uuid, text, uuid[]);
drop function if exists private.assert_rule_members(uuid, text, uuid[]);

drop table if exists public.notifications;
drop table if exists public.assignment_rules;

drop function if exists private.audit_assignment_rules();
