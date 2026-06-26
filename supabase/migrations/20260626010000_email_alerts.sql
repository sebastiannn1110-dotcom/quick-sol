-- Email alert rules and notification history for Quiksol.

create table if not exists public.email_alert_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  event_type text not null check (event_type in (
    'upload_completed',
    'upload_failed',
    'upload_has_many_errors',
    'low_gp_rate',
    'missing_mpn_threshold',
    'weekly_report',
    'new_dataset_published',
    'import_quality_below_threshold'
  )),
  condition_type text,
  condition_value numeric,
  recipients text[] not null default '{}',
  enabled boolean not null default true,
  frequency text not null default 'immediate' check (frequency in ('immediate', 'daily', 'weekly')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.email_notification_events (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid references public.email_alert_rules(id) on delete set null,
  event_type text not null,
  recipient text not null,
  subject text not null,
  status text not null check (status in ('sent', 'failed', 'skipped', 'pending')),
  error_message text,
  metadata jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists email_alert_rules_event_type_idx on public.email_alert_rules(event_type);
create index if not exists email_alert_rules_enabled_idx on public.email_alert_rules(enabled);
create index if not exists email_notification_events_rule_id_idx on public.email_notification_events(rule_id);
create index if not exists email_notification_events_event_type_idx on public.email_notification_events(event_type);
create index if not exists email_notification_events_created_at_idx on public.email_notification_events(created_at desc);
create index if not exists email_notification_events_status_idx on public.email_notification_events(status);

drop trigger if exists email_alert_rules_set_updated_at on public.email_alert_rules;
create trigger email_alert_rules_set_updated_at
before update on public.email_alert_rules
for each row execute function public.set_updated_at();

alter table public.email_alert_rules enable row level security;
alter table public.email_notification_events enable row level security;

drop policy if exists email_alert_rules_select_admin on public.email_alert_rules;
create policy email_alert_rules_select_admin on public.email_alert_rules
for select using (public.is_admin());

drop policy if exists email_alert_rules_insert_admin on public.email_alert_rules;
create policy email_alert_rules_insert_admin on public.email_alert_rules
for insert with check (public.is_admin());

drop policy if exists email_alert_rules_update_admin on public.email_alert_rules;
create policy email_alert_rules_update_admin on public.email_alert_rules
for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists email_alert_rules_delete_admin on public.email_alert_rules;
create policy email_alert_rules_delete_admin on public.email_alert_rules
for delete using (public.is_admin());

drop policy if exists email_notification_events_select_admin on public.email_notification_events;
create policy email_notification_events_select_admin on public.email_notification_events
for select using (public.is_admin());

-- Inserts are performed by trusted server/service role during alert evaluation.
