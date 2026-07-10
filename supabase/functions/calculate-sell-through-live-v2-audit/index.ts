const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://lztornyogibsaswcviss.supabase.co';
const FUNCTION_VERSION = 'v2.5-audit-timings';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SALE_TYPES = new Set([10, 40, 44]);
const RETURN_TYPES = new Set([39, 41]);
const RECEPTION_LIMIT = 50;
const DETAIL_LIMIT = 100;
const DOC_INDEX_LIMIT = 1000;
const CONSUMPTION_LIMIT = 50;

type Row = Record<string, unknown>;
type ReceptionResult = { movement: Row; date: string; reception_id: number; quantity: number; cost: number };
type AuditTimings = Record<string, number>;

const elapsedMs = (startedAt: number): number =>
  Math.round((performance.now() - startedAt) * 100) / 100;

async function timed<T>(
  timings: AuditTimings,
  stage: string,
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();

  try {
    return await task();
  } finally {
    const durationMs = elapsedMs(startedAt);
    timings[stage] = durationMs;

    console.log(JSON.stringify({
      event: 'sell_through_audit_stage',
      stage,
      duration_ms: durationMs,
    }));
  }
}

const n = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const i = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

const b = (value: unknown): boolean => String(value) === '1' || value === true;
const sku = (value: unknown): string => String(value ?? '').trim().toUpperCase();
const barcode = (value: unknown): string => String(value ?? '').trim().replace(/\s+/g, '');
const officeName = (officeId: number): string => {
  if (officeId === 2) return 'CHINO LAS AMERICAS';
  if (officeId === 3) return 'CHINO LA HUERTA';
  if (officeId === 4) return 'CHINO LEON CENTRO';
  return `OFFICE ${officeId}`;
};
const ymd = (unix: unknown): string | null => {
  const parsed = i(unix);
  return parsed === null ? null : new Date(parsed * 1000).toISOString().slice(0, 10);
};
const yesterdayUtc = (): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};
const daysAgo = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};
const unixUtc = (dateText: string, end = false): number =>
  Math.floor(new Date(`${dateText}${end ? 'T23:59:59Z' : 'T00:00:00Z'}`).getTime() / 1000);
const validDate = (value: unknown): boolean => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));
const minDate = (a: string, bb: string): string => a <= bb ? a : bb;
const inFilter = (values: Array<string | number>): string => `in.(${values.join(',')})`;
const sortedIds = (set: Set<number>): number[] => Array.from(set).sort((a, b) => a - b);
const docType = (typeId: number): string => SALE_TYPES.has(typeId) ? 'VENTA' : RETURN_TYPES.has(typeId) ? 'DEVOLUCION' : 'OTRO_DOCUMENTO';
const docSign = (typeId: number): number => RETURN_TYPES.has(typeId) ? -1 : 1;

async function sb(table: string, params: Record<string, string>) {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY secret');
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`Supabase index error ${res.status}: ${(await res.text()).slice(0, 500)} | table=${table}`);
  return res.json();
}

async function bsale(path: string, params: Record<string, string | number> = {}) {
  const token = Deno.env.get('BSALE_ACCESS_TOKEN');
  if (!token) throw new Error('Missing BSALE_ACCESS_TOKEN secret');
  const url = new URL(`https://api.bsale.com.mx/v1/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, { headers: { access_token: token, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`Bsale API error ${res.status}: ${(await res.text()).slice(0, 500)} | url=${url.toString()}`);
  return res.json();
}

async function findStockRows(query: string, officeIds: number[]) {
  const rows: Row[] = [];
  for (const [column, value] of [['sku_norm', sku(query)], ['barcode_norm', barcode(query)]]) {
    if (!value) continue;
    rows.push(...await sb('bsale_stock_current', {
      select: 'office_id,variant_id,stock_id,sku_norm,barcode_norm,quantity,quantity_reserved,quantity_available,synced_at',
      [column]: `eq.${value}`,
      office_id: inFilter(officeIds),
    }));
  }
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.office_id}:${row.variant_id}:${row.stock_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function findAliasRows(query: string) {
  const rows: Row[] = [];
  for (const [column, value] of [['sku_norm', sku(query)], ['barcode_norm', barcode(query)]]) {
    if (!value) continue;
    rows.push(...await sb('bsale_sku_aliases', {
      select: 'variant_id,sku_norm,barcode_norm,product_id,description,last_seen_at',
      [column]: `eq.${value}`,
    }));
  }
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.variant_id}:${row.sku_norm}:${row.barcode_norm}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function liveStocks(rows: Row[]) {
  const out: Row[] = [];
  for (const row of rows) {
    try {
      const live = await bsale(`stocks/${row.stock_id}.json`, { expand: '[office,variant]' });
      const office = live.office ?? {};
      const variant = live.variant ?? {};
      const officeId = n(office.id ?? row.office_id);
      out.push({
        source: 'BSALE_LIVE_STOCK_ID', live_ok: true,
        office_id: officeId, office_name: office.name ?? officeName(officeId),
        variant_id: n(variant.id ?? row.variant_id), stock_id: n(live.id ?? row.stock_id),
        sku: variant.code ?? row.sku_norm, barcode: variant.barCode ?? row.barcode_norm,
        quantity: n(live.quantity ?? row.quantity), quantity_reserved: n(live.quantityReserved ?? row.quantity_reserved),
        quantity_available: n(live.quantityAvailable ?? row.quantity_available), index_synced_at: row.synced_at,
      });
    } catch (err) {
      const officeId = n(row.office_id);
      out.push({
        source: 'SUPABASE_INDEX_FALLBACK', live_ok: false,
        live_error: err instanceof Error ? err.message : String(err),
        office_id: officeId, office_name: officeName(officeId), variant_id: row.variant_id, stock_id: row.stock_id,
        sku: row.sku_norm, barcode: row.barcode_norm,
        quantity: n(row.quantity), quantity_reserved: n(row.quantity_reserved), quantity_available: n(row.quantity_available),
        index_synced_at: row.synced_at,
      });
    }
  }
  return out;
}

async function liveStocksByVariantOffice(officeIds: number[], variantIds: Set<number>, query: string, indexRows: Row[]) {
  const out: Row[] = [];
  const indexByOfficeVariant = new Map<string, Row>();
  for (const row of indexRows) {
    indexByOfficeVariant.set(`${n(row.office_id)}:${n(row.variant_id)}`, row);
  }

  for (const officeId of officeIds) {
    for (const variantId of sortedIds(variantIds)) {
      const indexRow = indexByOfficeVariant.get(`${officeId}:${variantId}`) ?? {};
      try {
        const page = await bsale('stocks.json', { officeid: officeId, variantid: variantId, limit: 10, offset: 0 });
        const items = (page.items ?? []) as Row[];
        for (const live of items) {
          const office = (live.office ?? {}) as Row;
          const variant = (live.variant ?? {}) as Row;
          const liveOfficeId = n(office.id ?? officeId);
          const liveVariantId = n(variant.id ?? variantId);
          if (liveOfficeId !== officeId || liveVariantId !== variantId) continue;
          out.push({
            source: 'BSALE_LIVE_VARIANT_OFFICE', live_ok: true,
            office_id: liveOfficeId, office_name: String(office.name ?? officeName(liveOfficeId)),
            variant_id: liveVariantId, stock_id: n(live.id),
            sku: variant.code ?? indexRow.sku_norm ?? sku(query),
            barcode: variant.barCode ?? indexRow.barcode_norm ?? barcode(query),
            quantity: n(live.quantity), quantity_reserved: n(live.quantityReserved), quantity_available: n(live.quantityAvailable),
            index_synced_at: indexRow.synced_at ?? null,
          });
        }
      } catch (err) {
        out.push({
          source: 'BSALE_LIVE_VARIANT_OFFICE_ERROR', live_ok: false,
          live_error: err instanceof Error ? err.message : String(err),
          office_id: officeId, office_name: officeName(officeId), variant_id: variantId, stock_id: null,
          sku: indexRow.sku_norm ?? sku(query), barcode: indexRow.barcode_norm ?? barcode(query),
          quantity: 0, quantity_reserved: 0, quantity_available: 0,
          index_synced_at: indexRow.synced_at ?? null,
        });
      }
    }
  }

  const seen = new Set<string>();
  return out.filter((row) => {
    const key = `${row.office_id}:${row.variant_id}:${row.stock_id ?? 'no-stock'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fallbackStockMatches(officeIds: number[], variantIds: Set<number>, query: string) {
  const firstVariantId = sortedIds(variantIds)[0] ?? null;
  return officeIds.map((officeId) => ({
    source: 'OFFICE_SELECTION_FALLBACK', live_ok: false,
    office_id: officeId, office_name: officeName(officeId),
    variant_id: firstVariantId, stock_id: null,
    sku: sku(query), barcode: barcode(query),
    quantity: 0, quantity_reserved: 0, quantity_available: 0,
    index_synced_at: null,
  }));
}

async function details(path: string, maxDetails: number) {
  const items: Row[] = [];
  let offset = 0;
  let requests = 0;
  while (true) {
    const page = await bsale(path, { limit: DETAIL_LIMIT, offset });
    requests += 1;
    const pageItems = (page.items ?? []) as Row[];
    items.push(...pageItems);
    if (maxDetails > 0 && items.length >= maxDetails) return { items: items.slice(0, maxDetails), requests };
    offset += DETAIL_LIMIT;
    if (!pageItems.length || offset >= n(page.count)) break;
  }
  return { items, requests };
}

function classifyReception(reception: Row): string {
  const internalDispatch = (reception.internalDispatch ?? {}) as Row;
  const internalDispatchId = i(internalDispatch.id ?? reception.internalDispatchId);
  if (internalDispatchId) return 'RECEPCION_DESPACHO_INTERNO';
  if (b(reception.updateStock)) return 'ENTRADA_STOCK';
  return 'ENTRADA_IMPORTADA_AMBIGUA';
}

function buildReception(reception: Row, officeId: number, date: string, receptionId: number, matches: Array<{ detail: Row; variantId: number }>): ReceptionResult {
  const first = matches[0];
  const qty = matches.reduce((sum, item) => sum + n(item.detail.quantity), 0);
  const variantStock = matches.reduce((sum, item) => sum + n(item.detail.variantStock), 0);
  return {
    date, reception_id: receptionId, quantity: qty, cost: n(first.detail.cost),
    movement: {
      source: 'receptions', movement_group: 'ENTRADA', movement_type: classifyReception(reception), office_id: officeId,
      movement_date: date, reception_id: receptionId, reception_detail_id: i(first.detail.id), variant_id: first.variantId,
      quantity: qty, quantity_signed: qty, cost: n(first.detail.cost), variant_stock: variantStock,
      document: reception.document ?? null, document_number: reception.documentNumber ?? null,
      internal_dispatch_id: i(reception.internalDispatchId), note: reception.note || reception.document || null,
    },
  };
}

async function scanReceptions(officeIds: number[], variantIds: Set<number>, startDate: string, endDate: string, maxDetails: number, maxPages: number, stopAfterFirstMatch: boolean) {
  const receptionsFound: ReceptionResult[] = [];
  const stats = { pages: 0, count_requests: 0, receptions_seen: 0, details_seen: 0, detail_requests: 0, matches: 0, lookup_windows: [] as number[], stopped_after_first_match: false, assumed_reception_order: 'oldest_first_reverse_scan', start_offsets: [] as Row[], detail_errors: [] as Row[] };
  const admissionDate = unixUtc(endDate);

  for (const officeId of officeIds) {
    const countPage = await bsale('stocks/receptions.json', {
      officeid: officeId,
      admissiondate: admissionDate,
      expand: '[office]',
      limit: 1,
      offset: 0,
    });
    stats.count_requests += 1;
    const count = n(countPage.count);
    if (!count) continue;
    let offset = Math.max(
      0,
      Math.floor((count - 1) / RECEPTION_LIMIT) * RECEPTION_LIMIT,
    );
    let pages = 0;
    let stopOffice = false;
    stats.start_offsets.push({ office_id: officeId, count, start_offset: offset });

    while (offset >= 0 && !stopOffice) {
      if (maxPages > 0 && pages >= maxPages) break;
      const page = await bsale('stocks/receptions.json', {
        officeid: officeId,
        admissiondate: admissionDate,
        expand: '[office]',
        limit: RECEPTION_LIMIT,
        offset,
      });
      const receptions = ((page.items ?? []) as Row[]).slice().reverse();
      stats.pages += 1;
      pages += 1;
      if (!receptions.length) break;

      for (const reception of receptions) {
        stats.receptions_seen += 1;
        const date = ymd(reception.admissionDate);
        if (date && date > endDate) continue;
        if (date && date < startDate) { stopOffice = true; break; }
        if (!date || date < startDate || date > endDate) continue;
        const receptionId = n(reception.id);
        let dets: Row[] = [];
        try {
          const result = await details(
            `stocks/receptions/${receptionId}/details.json`,
            maxDetails,
          );
          dets = result.items;
          stats.detail_requests += result.requests;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('Bsale API error 403')) {
            stats.detail_errors.push({ reception_id: receptionId, message: msg.slice(0, 220) });
            continue;
          }
          throw err;
        }
        const matches: Array<{ detail: Row; variantId: number }> = [];
        for (const detail of dets) {
          stats.details_seen += 1;
          const variantId = i((detail.variant as Row | undefined)?.id);
          if (variantId !== null && variantIds.has(variantId)) matches.push({ detail, variantId });
        }
        if (!matches.length) continue;
        stats.matches += matches.length;
        receptionsFound.push(buildReception(reception, officeId, date, receptionId, matches));
        if (stopAfterFirstMatch) {
          stats.stopped_after_first_match = true;
          stopOffice = true;
          break;
        }
      }
      offset -= RECEPTION_LIMIT;
    }
  }

  receptionsFound.sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.reception_id - a.reception_id);
  return { receptions: receptionsFound, stats };
}

async function scanDocuments(officeIds: number[], variantIds: Set<number>, startDate: string, endDate: string) {
  const movements: Row[] = [];
  const stats = { pages: 0, documents_seen: 0, details_seen: 0, detail_requests: 0, matches: 0, source: 'SUPABASE_BSALE_DOCUMENT_DETAILS', detail_errors: [] as Row[] };
  const documentIds = new Set<number>();
  let offset = 0;

  while (true) {
    const rows = await sb('bsale_document_details', {
      select: 'document_detail_id,document_id,emission_date,office_id,document_type_id,movement_type,variant_id,quantity,quantity_signed,total_amount,total_amount_signed,unit_value,synced_at',
      office_id: inFilter(officeIds), variant_id: inFilter(sortedIds(variantIds)),
      emission_date: `gte.${startDate}`, and: `(emission_date.lte.${endDate})`,
      order: 'emission_date.asc,document_id.asc', limit: String(DOC_INDEX_LIMIT), offset: String(offset),
    });
    stats.pages += 1;
    const pageRows = (rows ?? []) as Row[];
    if (!pageRows.length) break;

    for (const row of pageRows) {
      const documentId = i(row.document_id);
      if (documentId !== null) documentIds.add(documentId);
      stats.details_seen += 1;
      stats.matches += 1;
      const typeId = n(row.document_type_id);
      const movementType = String(row.movement_type || docType(typeId));
      const group = movementType === 'DEVOLUCION' ? 'DEVOLUCION' : 'VENTA';
      const qty = n(row.quantity);
      const amount = n(row.total_amount);
      movements.push({
        source: 'documents_index', movement_group: group, movement_type: movementType, office_id: n(row.office_id),
        movement_date: row.emission_date ?? null, document_id: documentId, document_detail_id: i(row.document_detail_id),
        document_type_id: typeId, document_number: documentId, variant_id: i(row.variant_id), quantity: qty,
        quantity_signed: row.quantity_signed === null || row.quantity_signed === undefined ? qty * docSign(typeId) : n(row.quantity_signed),
        total_amount: amount,
        total_amount_signed: row.total_amount_signed === null || row.total_amount_signed === undefined ? amount * docSign(typeId) : n(row.total_amount_signed),
        note: `Documento ${documentId ?? ''}`.trim(), index_synced_at: row.synced_at ?? null,
      });
    }
    if (pageRows.length < DOC_INDEX_LIMIT) break;
    offset += DOC_INDEX_LIMIT;
  }
  stats.documents_seen = documentIds.size;
  return { movements, stats };
}

async function scanConsumptions(officeIds: number[], variantIds: Set<number>, startDate: string, endDate: string, maxPages: number, maxDetails: number) {
  const startUnix = unixUtc(startDate);
  const endUnix = unixUtc(endDate, true);
  const movements: Row[] = [];
  const stats = { pages: 0, count_requests: 0, consumptions_seen_in_date_range: 0, details_seen: 0, detail_requests: 0, matches: 0, start_offsets: [] as Row[], detail_errors: [] as Row[] };

  for (const officeId of officeIds) {
    const countPage = await bsale('stocks/consumptions.json', { officeid: officeId, limit: 1, offset: 0 });
    stats.count_requests += 1;
    const count = n(countPage.count);
    if (!count) continue;
    let offset = Math.max(0, count - CONSUMPTION_LIMIT);
    let pages = 0;
    let stop = false;
    stats.start_offsets.push({ office_id: officeId, count, start_offset: offset });

    while (offset >= 0 && !stop) {
      if (maxPages > 0 && pages >= maxPages) break;
      const page = await bsale('stocks/consumptions.json', { officeid: officeId, limit: CONSUMPTION_LIMIT, offset });
      const consumptions = ((page.items ?? []) as Row[]).slice().reverse();
      stats.pages += 1;
      pages += 1;
      if (!consumptions.length) break;

      for (const consumption of consumptions) {
        const consumptionUnix = i(consumption.consumptionDate);
        if (consumptionUnix === null || consumptionUnix > endUnix || consumptionUnix < startUnix) continue;
        stats.consumptions_seen_in_date_range += 1;
        const consumptionId = i(consumption.id);
        if (consumptionId === null) continue;
        let dets: Row[] = [];
        try {
          const result = await details(`stocks/consumptions/${consumptionId}/details.json`, maxDetails);
          dets = result.items;
          stats.detail_requests += result.requests;
        } catch (err) {
          stats.detail_errors.push({ consumption_id: consumptionId, message: err instanceof Error ? err.message.slice(0, 220) : String(err).slice(0, 220) });
          continue;
        }
        for (const detail of dets) {
          stats.details_seen += 1;
          const variantId = i((detail.variant as Row | undefined)?.id);
          if (variantId === null || !variantIds.has(variantId)) continue;
          const qty = n(detail.quantity);
          const updateStock = b(consumption.updateStock);
          movements.push({
            source: 'consumptions', movement_group: 'CONSUMO_AJUSTE', movement_type: updateStock ? 'CONSUMO_AJUSTE_STOCK' : 'CONSUMO_SIN_AFECTAR_STOCK',
            office_id: officeId, movement_date: ymd(consumptionUnix), consumption_id: consumptionId, consumption_detail_id: i(detail.id),
            consumption_type_id: i(consumption.consumptionTypeId), variant_id: variantId, quantity: qty, quantity_signed: -qty,
            cost: n(detail.cost), variant_stock: n(detail.variantStock), update_stock: updateStock, note: consumption.note ?? null,
          });
          stats.matches += 1;
        }
      }

      const oldest = consumptions.map((x) => i(x.consumptionDate)).filter((x): x is number => x !== null).reduce((min, x) => Math.min(min, x), Number.POSITIVE_INFINITY);
      if (Number.isFinite(oldest) && oldest < startUnix) stop = true;
      offset -= CONSUMPTION_LIMIT;
    }
  }
  return { movements, stats };
}

function summary(stockMatches: Row[], received: number, docMovements: Row[], consumptionMovements: Row[]) {
  const sold = docMovements.filter((x) => x.movement_group === 'VENTA').reduce((sum, x) => sum + n(x.quantity), 0);
  const returned = docMovements.filter((x) => x.movement_group === 'DEVOLUCION').reduce((sum, x) => sum + n(x.quantity), 0);
  const consumed = consumptionMovements.reduce((sum, x) => sum + n(x.quantity), 0);
  const consumedStock = consumptionMovements.filter((x) => x.update_stock === true).reduce((sum, x) => sum + n(x.quantity), 0);
  const netSold = sold - returned;
  const stockOutflow = netSold + consumedStock;
  const stockActual = stockMatches.reduce((sum, x) => sum + n(x.quantity), 0);
  const stockDisponible = stockMatches.reduce((sum, x) => sum + n(x.quantity_available), 0);
  const outflowExceedsReception = received > 0 && stockOutflow > received;
  return {
    piezas_recibidas_ultima_recepcion: received,
    piezas_recibidas_periodo: received,
    piezas_vendidas_desde_ultima_recepcion: sold,
    piezas_devueltas_desde_ultima_recepcion: returned,
    piezas_netas_venta_desde_ultima_recepcion: netSold,
    piezas_consumidas_ajuste_desde_ultima_recepcion: consumed,
    piezas_consumidas_ajuste_stock_desde_ultima_recepcion: consumedStock,
    piezas_consumidas_sin_afectar_stock_desde_ultima_recepcion: consumed - consumedStock,
    piezas_salidas_stock_desde_ultima_recepcion: stockOutflow,
    stock_actual: stockActual,
    stock_disponible: stockDisponible,
    sell_through_pct: received > 0 ? Math.round((netSold / received) * 10000) / 100 : null,
    salidas_vs_recepcion_pct: received > 0 ? Math.round((stockOutflow / received) * 10000) / 100 : null,
    advertencia_salidas_superan_ultima_recepcion: outflowExceedsReception,
    nota_trazabilidad: outflowExceedsReception ? 'Las salidas de stock superan las entradas del rango analizado; no se puede atribuir todo a ese lote/periodo sin una regla FIFO explícita.' : null,
  };
}

function sortMovements(items: Row[]) {
  return items.sort((a, bb) => String(bb.movement_date).localeCompare(String(a.movement_date)) || String(bb.source).localeCompare(String(a.source)));
}

Deno.serve(async (req) => {
  const requestStartedAt = performance.now();
  const timings: AuditTimings = {};

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const body = await req.json();
    const query = String(body.query ?? '').trim();
    const officeIds = Array.isArray(body.office_ids) ? body.office_ids.map(Number).filter(Boolean) : [2, 3, 4];
    const mode = String(body.analysis_mode ?? body.search_mode ?? 'last_reception') === 'period' ? 'period' : 'last_reception';
    const lookbackDays = n(body.lookback_days ?? 365);
    const maxReceptionPages = n(body.max_reception_pages_per_office ?? 0);
    const maxConsumptionPages = n(body.max_consumption_pages_per_office ?? 0);
    const maxReceptionDetails = Math.max(1000, n(body.max_reception_details ?? 1000));
    const maxConsumptionDetails = Math.max(1000, n(body.max_consumption_details ?? 1000));
    if (!query) return new Response(JSON.stringify({ error: 'Missing query' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const closedEndDate = yesterdayUtc();
    let startDate = daysAgo(Math.max(1, Math.trunc(lookbackDays || 365)));
    let endDate = closedEndDate;

    if (mode === 'period') {
      const requestedStart = String(body.period_start_date ?? body.start_date ?? '').trim();
      const requestedEnd = String(body.period_end_date ?? body.end_date ?? '').trim();
      if (!validDate(requestedStart) || !validDate(requestedEnd)) {
        return new Response(JSON.stringify({ function_version: FUNCTION_VERSION, error: 'Periodo inválido. Usa period_start_date y period_end_date en formato YYYY-MM-DD.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      startDate = requestedStart;
      endDate = minDate(requestedEnd, closedEndDate);
      if (startDate > endDate) {
        return new Response(JSON.stringify({ function_version: FUNCTION_VERSION, error: `Periodo inválido para la regla hasta ayer. start_date=${startDate}, end_date=${endDate}` }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    console.log(JSON.stringify({
      event: 'sell_through_audit_start',
      query,
      office_ids: officeIds,
      analysis_mode: mode,
      start_date: startDate,
      end_date: endDate,
    }));

    const stockRows = await timed(
      timings,
      'stock_index_lookup_ms',
      () => findStockRows(query, officeIds),
    );

    const aliasRows = await timed(
      timings,
      'alias_lookup_ms',
      () => findAliasRows(query),
    );
    const variantIds = new Set<number>();
    stockRows.forEach((row) => { if (row.variant_id) variantIds.add(Number(row.variant_id)); });
    aliasRows.forEach((row) => { if (row.variant_id) variantIds.add(Number(row.variant_id)); });
    let stockMatches: Row[] = [];

    if (!variantIds.size) {
      stockMatches = await liveStocks(stockRows);
      return new Response(JSON.stringify({
        found: false, function_version: FUNCTION_VERSION, analysis_mode: mode, query, office_ids: officeIds, start_date: startDate, end_date: endDate,
        data_policy: 'closed_through_yesterday_utc', message: 'No se encontró variant_id en bsale_stock_current ni bsale_sku_aliases.',
        stock_matches: stockMatches, alias_matches: aliasRows.length, index_matches: stockRows.length,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    stockMatches = await timed(
      timings,
      'live_stock_lookup_ms',
      () => liveStocksByVariantOffice(
        officeIds,
        variantIds,
        query,
        stockRows,
      ),
    );

    if (!stockMatches.length) {
      stockMatches = await timed(
        timings,
        'live_stock_fallback_ms',
        () => liveStocks(stockRows),
      );
    }
    if (!stockMatches.length) stockMatches = fallbackStockMatches(officeIds, variantIds, query);

    if (mode === 'period') {
      const receptionScan = await timed(
        timings,
        'receptions_scan_ms',
        () => scanReceptions(
          officeIds,
          variantIds,
          startDate,
          endDate,
          maxReceptionDetails,
          maxReceptionPages,
          false,
        ),
      );

      const docResult = await timed(
        timings,
        'documents_scan_ms',
        () => scanDocuments(
          officeIds,
          variantIds,
          startDate,
          endDate,
        ),
      );

      const consumptionResult = await timed(
        timings,
        'consumptions_scan_ms',
        () => scanConsumptions(
          officeIds,
          variantIds,
          startDate,
          endDate,
          maxConsumptionPages,
          maxConsumptionDetails,
        ),
      );
      const receptionMovements = receptionScan.receptions.map((item) => item.movement);
      const received = receptionScan.receptions.reduce((sum, item) => sum + n(item.quantity), 0);
      const sortStartedAt = performance.now();

      const movements = sortMovements([
        ...receptionMovements,
        ...docResult.movements,
        ...consumptionResult.movements,
      ]);

      timings.sort_movements_ms = elapsedMs(sortStartedAt);

      console.log(JSON.stringify({
        event: 'sell_through_audit_stage',
        stage: 'sort_movements_ms',
        duration_ms: timings.sort_movements_ms,
      }));

      return new Response(JSON.stringify({
        found: true, sell_through_found: true, function_version: FUNCTION_VERSION, analysis_mode: mode, query, office_ids: officeIds,
        variant_ids: sortedIds(variantIds), start_date: startDate, scan_start_date: startDate, end_date: endDate,
        data_policy: 'closed_through_yesterday_utc', stock_matches: stockMatches,
        last_reception: receptionScan.receptions[0]?.movement ?? null,
        period_receptions: receptionMovements,
        summary: summary(stockMatches, received, docResult.movements, consumptionResult.movements), movements,
        scan_stats: {
          receptions: receptionScan.stats,
          documents: docResult.stats,
          consumptions: consumptionResult.stats,
        },
        audit: {
          timings_ms: {
            ...timings,
            total_before_response_ms: elapsedMs(requestStartedAt),
          },
          counts: {
            reception_movements: receptionMovements.length,
            document_movements: docResult.movements.length,
            consumption_movements: consumptionResult.movements.length,
            total_movements: movements.length,
          },
        },
        diagnostic: {
          phase: 'complete', analysis_mode: mode, reception_order_strategy: receptionScan.stats.assumed_reception_order,
          document_scan_start: startDate, document_scan_source: docResult.stats.source,
          stock_scan_source: stockMatches.map((x) => x.source), consumption_scan_start: startDate, data_policy: 'closed_through_yesterday_utc',
        },
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const receptionScan = await scanReceptions(officeIds, variantIds, startDate, endDate, maxReceptionDetails, maxReceptionPages, true);
    receptionScan.stats.lookup_windows = [Math.max(1, Math.trunc(lookbackDays || 365))];
    const lastReception = receptionScan.receptions[0] ?? null;

    if (!lastReception) {
      return new Response(JSON.stringify({
        found: true, sell_through_found: false, function_version: FUNCTION_VERSION, analysis_mode: mode, query, office_ids: officeIds,
        variant_ids: sortedIds(variantIds), start_date: startDate, end_date: endDate, data_policy: 'closed_through_yesterday_utc',
        stock_matches: stockMatches, last_reception: null, summary: summary(stockMatches, 0, [], []), movements: [],
        scan_stats: { receptions: receptionScan.stats, documents: null, consumptions: null },
        diagnostic: { phase: 'reception_scan', analysis_mode: mode, lookup_windows_used: receptionScan.stats.lookup_windows, reception_order_strategy: receptionScan.stats.assumed_reception_order, document_scan_start: null, stock_scan_source: stockMatches.map((x) => x.source), consumption_scan_start: null, data_policy: 'closed_through_yesterday_utc' },
        message: 'SKU encontrado, pero no se encontró recepción dentro del rango consultado hasta ayer.',
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const scanStartDate = lastReception.date;
    const docResult = await scanDocuments(officeIds, variantIds, scanStartDate, endDate);
    const consumptionResult = await scanConsumptions(officeIds, variantIds, scanStartDate, endDate, maxConsumptionPages, maxConsumptionDetails);
    const movements = sortMovements([lastReception.movement, ...docResult.movements, ...consumptionResult.movements]);

    return new Response(JSON.stringify({
      found: true, sell_through_found: true, function_version: FUNCTION_VERSION, analysis_mode: mode, query, office_ids: officeIds,
      variant_ids: sortedIds(variantIds), start_date: startDate, scan_start_date: scanStartDate, end_date: endDate,
      data_policy: 'closed_through_yesterday_utc', stock_matches: stockMatches, last_reception: lastReception.movement,
      period_receptions: [lastReception.movement],
      summary: summary(stockMatches, lastReception.quantity, docResult.movements, consumptionResult.movements), movements,
      scan_stats: { receptions: receptionScan.stats, documents: docResult.stats, consumptions: consumptionResult.stats },
      diagnostic: {
        phase: 'complete', analysis_mode: mode, lookup_windows_used: receptionScan.stats.lookup_windows, reception_order_strategy: receptionScan.stats.assumed_reception_order,
        last_reception_date: lastReception.date, document_scan_start: scanStartDate, document_scan_source: docResult.stats.source,
        stock_scan_source: stockMatches.map((x) => x.source), consumption_scan_start: scanStartDate, data_policy: 'closed_through_yesterday_utc',
      },
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    const errorMessage = err instanceof Error
      ? err.message
      : String(err);

    console.error(JSON.stringify({
      event: 'sell_through_audit_error',
      error: errorMessage,
      timings_ms: timings,
      total_ms: elapsedMs(requestStartedAt),
    }));

    return new Response(JSON.stringify({
      function_version: FUNCTION_VERSION,
      error: errorMessage,
      audit: {
        timings_ms: timings,
        total_ms: elapsedMs(requestStartedAt),
      },
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  }
});