alter table public.opportunity_finder_results
  add column if not exists usable_availability_match boolean not null default false,
  add column if not exists exact_quantity_match boolean not null default false;

comment on column public.opportunity_finder_results.usable_availability_match is
  'True when valid positive availability remained and passed compatibility checks immediately before this allocation.';

comment on column public.opportunity_finder_results.exact_quantity_match is
  'True when usable availability immediately before allocation exactly equaled the required quantity.';
