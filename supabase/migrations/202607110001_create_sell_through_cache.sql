begin;

drop table if exists public.sell_through_results cascade;

drop function if exists
  public.touch_sell_through_results_updated_at();

create table if not exists public.sell_through_cache (
  id uuid primary key default gen_random_uuid(),

  query text not null,

  query_norm text
    generated always as (upper(btrim(query))) stored,

  office_id bigint not null
    check (office_id > 0),

  analysis_mode text not null default 'period'
    check (analysis_mode = 'period'),

  start_date date not null,
  end_date date not null,

  function_version text,

  source text not null default 'github_actions',
  source_run_id bigint,

  piezas_recibidas numeric not null default 0,
  piezas_netas_vendidas numeric not null default 0,
  sell_through_pct numeric not null default 0,

  stock_actual numeric not null default 0,
  stock_reservado numeric not null default 0,
  stock_disponible numeric not null default 0,

  ultima_recepcion_fecha date,

  summary jsonb not null default '{}'::jsonb,
  result jsonb not null,

  computed_at timestamptz not null default now(),

  expires_at timestamptz not null
    default (now() + interval '24 hours'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sell_through_cache_valid_period
    check (end_date >= start_date),

  constraint sell_through_cache_valid_expiration
    check (expires_at > computed_at)
);

create unique index if not exists
  sell_through_cache_key_uidx
on public.sell_through_cache (
  query_norm,
  office_id,
  analysis_mode,
  start_date,
  end_date
);

create index if not exists
  sell_through_cache_expiration_idx
on public.sell_through_cache (expires_at);

create index if not exists
  sell_through_cache_lookup_idx
on public.sell_through_cache (
  query_norm,
  office_id,
  start_date,
  end_date,
  expires_at
);

create or replace function
  public.touch_sell_through_cache_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists
  trg_sell_through_cache_updated_at
on public.sell_through_cache;

create trigger trg_sell_through_cache_updated_at
before update on public.sell_through_cache
for each row
execute function public.touch_sell_through_cache_updated_at();

create or replace function
  public.purge_expired_sell_through_cache()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  delete from public.sell_through_cache
  where expires_at <= now();

  get diagnostics deleted_count = row_count;

  return deleted_count;
end;
$$;

alter table public.sell_through_cache
  enable row level security;

revoke all
on table public.sell_through_cache
from anon, authenticated;

grant select, insert, update, delete
on table public.sell_through_cache
to service_role;

revoke all
on function public.purge_expired_sell_through_cache()
from public, anon, authenticated;

grant execute
on function public.purge_expired_sell_through_cache()
to service_role;

comment on table public.sell_through_cache is
  'Caché temporal de resultados consolidados de sell-through. No almacena histórico.';

commit;
