const SUPABASE_URL =
  Deno.env.get('SUPABASE_URL') ?? 'https://lztornyogibsaswcviss.supabase.co';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SALE_DOCUMENT_TYPES = new Set([10, 40, 44]);
const RETURN_DOCUMENT_TYPES = new Set([39, 41]);
const LOOKBACK_STEPS = [10, 30, 90, 180, 365];

type StockIndexRow = {
  office_id: number;
  variant_id: number;
  stock_id: number;
  sku_norm: string | null;
  barcode_norm: string | null;
  quantity: number;
  quantity_reserved: number;
  quantity_available: number;
  synced_at: string | null;
};

type AliasRow = {
  variant_id: number;
  sku_norm: string | null;
  barcode_norm: string | null;
  product_id: number | null;
  description: string | null;
  last_seen_at: string | null;
};

type Movement = Record<string, unknown>;

type ReceptionResult = null | {
  movement: Movement;
  date: string;
  reception_id: number;
  quantity: number;
  cost: number;
};

type ReceptionStats = {
  pages: number;
  receptions_seen: number;
  details_seen: number;
  matches: number;
};

function normalizeSku(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeBarcode(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, '');
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function boolValue(value: unknown): boolean {
  return String(value) === '1' || value === true;
}

function unixToDate(value: unknown): string | null {
  const parsed = intOrNull(value);
  if (parsed === null) return null;
  return new Date(parsed * 1000).toISOString().slice(0, 10);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateDaysAgo(days: number): string {
  const current = new Date();
  current.setUTCDate(current.getUTCDate() - days);
  return current.toISOString().slice(0, 10);
}

function addDays(dateText: string, days: number): string {
  const current = new Date(`${dateText}T00:00:00Z`);
  current.setUTCDate(current.getUTCDate() + days);
  return current.toISOString().slice(0, 10);
}

function dateToUnixUtc(dateText: string, endOfDay = false): number {
  const suffix = endOfDay ? 'T23:59:59Z' : 'T00:00:00Z';
  return Math.floor(new Date(`${dateText}${suffix}`).getTime() / 1000);
}

function dateInRange(dateText: string | null, startDate: string, endDate: string): boolean {
  if (!dateText) return false;
  return dateText >= startDate && dateText <= endDate;
}

function movementTypeForDocument(documentTypeId: number): string {
  if (SALE_DOCUMENT_TYPES.has(documentTypeId)) return 'VENTA';
  if (RETURN_DOCUMENT_TYPES.has(documentTypeId)) return 'DEVOLUCION';
  return 'OTRO_DOCUMENTO';
}

function signForDocument(documentTypeId: number): number {
  if (RETURN_DOCUMENT_TYPES.has(documentTypeId)) return -1;
  return 1;
}

function classifyReception(reception: Record<string, unknown>): string {
  const internalDispatch = (reception.internalDispatch ?? {}) as Record<string, unknown>;
  const internalDispatchId = intOrNull(internalDispatch.id);

  if (internalDispatchId) return 'RECEPCION_DESPACHO_INTERNO';
  if (boolValue(reception.updateStock)) return 'ENTRADA_STOCK';

  return 'ENTRADA_IMPORTADA_AMBIGUA';
}

function mergeReceptionStats(target: ReceptionStats, source: ReceptionStats) {
  target.pages += source.pages;
  target.receptions_seen += source.receptions_seen;
  target.details_seen += source.details_seen;
  target.matches += source.matches;
}

function isBetterReception(candidate: ReceptionResult, current: ReceptionResult): boolean {
  if (!candidate) return false;
  if (!current) return true;
  if (candidate.date > current.date) return true;
  if (candidate.date < current.date) return false;
  return candidate.reception_id > current.reception_id;
}

async function supabaseGet(table: string, params: Record<string, string>) {
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!serviceRoleKey) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY secret');
  }

  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase index error ${response.status}: ${body.slice(0, 500)}`);
  }

  return response.json();
}

async function bsaleGet(path: string, params: Record<string, string | number> = {}) {
  const token = Deno.env.get('BSALE_ACCESS_TOKEN');

  if (!token) {
    throw new Error('Missing BSALE_ACCESS_TOKEN secret');
  }

  const url = new URL(`https://api.bsale.com.mx/v1/${path}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      access_token: token,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Bsale API error ${response.status}: ${body.slice(0, 500)} | url=${url.toString()}`);
  }

  return response.json();
}

async function findStockIndex(query: string, officeIds: number[]): Promise<StockIndexRow[]> {
  const skuQuery = normalizeSku(query);
  const barcodeQuery = normalizeBarcode(query);
  const officeFilter = `in.(${officeIds.join(',')})`;

  const rows: StockIndexRow[] = [];

  for (const [column, value] of [
    ['sku_norm', skuQuery],
    ['barcode_norm', barcodeQuery],
  ]) {
    if (!value) continue;

    const found = await supabaseGet('bsale_stock_current', {
      select:
        'office_id,variant_id,stock_id,sku_norm,barcode_norm,quantity,quantity_reserved,quantity_available,synced_at',
      [column]: `eq.${value}`,
      office_id: officeFilter,
    });

    rows.push(...found);
  }

  const seen = new Set<string>();
  const deduped: StockIndexRow[] = [];

  for (const row of rows) {
    const key = `${row.office_id}:${row.variant_id}:${row.stock_id}`;
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push(row);
  }

  return deduped;
}

async function findAliasIndex(query: string): Promise<AliasRow[]> {
  const skuQuery = normalizeSku(query);
  const barcodeQuery = normalizeBarcode(query);

  const rows: AliasRow[] = [];

  for (const [column, value] of [
    ['sku_norm', skuQuery],
    ['barcode_norm', barcodeQuery],
  ]) {
    if (!value) continue;

    const found = await supabaseGet('bsale_sku_aliases', {
      select: 'variant_id,sku_norm,barcode_norm,product_id,description,last_seen_at',
      [column]: `eq.${value}`,
    });

    rows.push(...found);
  }

  const seen = new Set<string>();
  const deduped: AliasRow[] = [];

  for (const row of rows) {
    const key = `${row.variant_id}:${row.sku_norm}:${row.barcode_norm}`;
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push(row);
  }

  return deduped;
}

async function getLiveStockMatches(stockRows: StockIndexRow[]) {
  const matches = [];

  for (const row of stockRows) {
    try {
      const live = await bsaleGet(`stocks/${row.stock_id}.json`, {
        expand: '[office,variant]',
      });

      const office = live.office ?? {};
      const variant = live.variant ?? {};

      matches.push({
        source: 'BSALE_LIVE',
        live_ok: true,
        office_id: numeric(office.id ?? row.office_id),
        office_name: office.name ?? null,
        variant_id: numeric(variant.id ?? row.variant_id),
        stock_id: numeric(live.id ?? row.stock_id),
        sku: variant.code ?? row.sku_norm,
        barcode: variant.barCode ?? row.barcode_norm,
        quantity: numeric(live.quantity ?? row.quantity),
        quantity_reserved: numeric(live.quantityReserved ?? row.quantity_reserved),
        quantity_available: numeric(live.quantityAvailable ?? row.quantity_available),
        index_synced_at: row.synced_at,
      });
    } catch (error) {
      matches.push({
        source: 'SUPABASE_INDEX_FALLBACK',
        live_ok: false,
        live_error: error instanceof Error ? error.message : String(error),
        office_id: row.office_id,
        office_name: null,
        variant_id: row.variant_id,
        stock_id: row.stock_id,
        sku: row.sku_norm,
        barcode: row.barcode_norm,
        quantity: numeric(row.quantity),
        quantity_reserved: numeric(row.quantity_reserved),
        quantity_available: numeric(row.quantity_available),
        index_synced_at: row.synced_at,
      });
    }
  }

  return matches;
}

async function listReceptionDetails(receptionId: number, maxDetails: number) {
  const limit = 50;
  let offset = 0;
  const items = [];

  while (true) {
    const page = await bsaleGet(`stocks/receptions/${receptionId}/details.json`, {
      limit,
      offset,
    });

    const pageItems = page.items ?? [];
    items.push(...pageItems);

    const count = numeric(page.count);
    offset += limit;

    if (maxDetails > 0 && items.length >= maxDetails) {
      return items.slice(0, maxDetails);
    }

    if (!pageItems.length || offset >= count) {
      break;
    }
  }

  return items;
}

function buildReceptionResult(params: {
  reception: Record<string, unknown>;
  officeId: number;
  admissionDate: string;
  receptionId: number;
  matchingDetails: Array<{ detail: Record<string, unknown>; variantId: number }>;
}): ReceptionResult {
  const firstMatch = params.matchingDetails[0];
  const firstDetail = firstMatch.detail;
  const quantity = params.matchingDetails.reduce(
    (sum, item) => sum + numeric(item.detail.quantity),
    0,
  );
  const variantStock = params.matchingDetails.reduce(
    (sum, item) => sum + numeric(item.detail.variantStock),
    0,
  );

  const movement = {
    source: 'receptions',
    movement_group: 'ENTRADA',
    movement_type: classifyReception(params.reception),
    office_id: params.officeId,
    movement_date: params.admissionDate,
    reception_id: params.receptionId,
    reception_detail_id: intOrNull(firstDetail.id),
    variant_id: firstMatch.variantId,
    quantity,
    quantity_signed: quantity,
    cost: numeric(firstDetail.cost),
    variant_stock: variantStock,
    note: params.reception.note || params.reception.document || null,
  };

  return {
    movement,
    date: params.admissionDate,
    reception_id: params.receptionId,
    quantity,
    cost: numeric(firstDetail.cost),
  };
}

async function findLastReceptionInWindow(params: {
  officeIds: number[];
  variantIds: Set<number>;
  startDate: string;
  endDate: string;
  maxDetails: number;
}) {
  const limit = 50;
  let latest: ReceptionResult = null;

  const stats: ReceptionStats = {
    pages: 0,
    receptions_seen: 0,
    details_seen: 0,
    matches: 0,
  };

  for (const officeId of params.officeIds) {
    let offset = 0;

    while (true) {
      const page = await bsaleGet('stocks/receptions.json', {
        officeid: officeId,
        expand: '[office,details]',
        limit,
        offset,
      });

      const receptions = page.items ?? [];
      const count = numeric(page.count);
      stats.pages += 1;

      if (!receptions.length) break;

      let sawOlderThanWindow = false;

      for (const reception of receptions) {
        stats.receptions_seen += 1;

        const admissionDate = unixToDate(reception.admissionDate);

        if (admissionDate && admissionDate < params.startDate) {
          sawOlderThanWindow = true;
          continue;
        }

        if (!dateInRange(admissionDate, params.startDate, params.endDate)) {
          continue;
        }

        const receptionId = numeric(reception.id);
        const details = await listReceptionDetails(receptionId, params.maxDetails);
        const matchingDetails: Array<{ detail: Record<string, unknown>; variantId: number }> = [];

        for (const rawDetail of details) {
          const detail = rawDetail as Record<string, unknown>;
          stats.details_seen += 1;

          const variant = (detail.variant ?? {}) as Record<string, unknown>;
          const variantId = intOrNull(variant.id);

          if (variantId === null || !params.variantIds.has(variantId)) {
            continue;
          }

          matchingDetails.push({ detail, variantId });
        }

        if (!matchingDetails.length) {
          continue;
        }

        stats.matches += matchingDetails.length;

        const candidate = buildReceptionResult({
          reception,
          officeId,
          admissionDate: String(admissionDate),
          receptionId,
          matchingDetails,
        });

        if (isBetterReception(candidate, latest)) {
          latest = candidate;
        } else if (latest && candidate && latest.reception_id === candidate.reception_id) {
          latest.quantity += candidate.quantity;
          latest.movement = {
            ...latest.movement,
            quantity: latest.quantity,
            quantity_signed: latest.quantity,
          };
        }
      }

      offset += limit;

      if (offset >= count || sawOlderThanWindow) {
        break;
      }
    }
  }

  return {
    last_reception: latest,
    stats,
  };
}

async function findLastReception(params: {
  officeIds: number[];
  variantIds: Set<number>;
  lookbackDays: number;
  endDate: string;
  maxDetails: number;
}) {
  const requestedLookback = Math.max(1, Math.trunc(params.lookbackDays || 30));
  const steps = Array.from(
    new Set([...LOOKBACK_STEPS.filter((days) => days < requestedLookback), requestedLookback]),
  ).sort((a, b) => a - b);

  const stats: ReceptionStats & { lookup_windows: number[] } = {
    pages: 0,
    receptions_seen: 0,
    details_seen: 0,
    matches: 0,
    lookup_windows: [],
  };

  for (const days of steps) {
    const windowResult = await findLastReceptionInWindow({
      officeIds: params.officeIds,
      variantIds: params.variantIds,
      startDate: dateDaysAgo(days),
      endDate: params.endDate,
      maxDetails: params.maxDetails,
    });

    stats.lookup_windows.push(days);
    mergeReceptionStats(stats, windowResult.stats);

    if (windowResult.last_reception) {
      return {
        last_reception: windowResult.last_reception,
        stats,
        start_date_used: dateDaysAgo(days),
      };
    }
  }

  return {
    last_reception: null,
    stats,
    start_date_used: dateDaysAgo(requestedLookback),
  };
}

async function scanDocumentsSince(params: {
  officeIds: number[];
  variantIds: Set<number>;
  startDate: string;
  endDate: string;
  maxPagesPerDayType: number;
}) {
  const documentTypeIds = [10, 39, 40, 41, 44];
  const limit = 50;
  const movements: Movement[] = [];

  const stats = {
    pages: 0,
    documents_seen: 0,
    details_seen: 0,
    matches: 0,
  };

  for (const officeId of params.officeIds) {
    let day = params.startDate;

    while (day <= params.endDate) {
      const startUnix = dateToUnixUtc(day, false);
      const endUnix = dateToUnixUtc(day, true);

      for (const documentTypeId of documentTypeIds) {
        let offset = 0;
        let pageNumber = 0;

        while (true) {
          if (params.maxPagesPerDayType > 0 && pageNumber >= params.maxPagesPerDayType) {
            break;
          }

          const page = await bsaleGet('documents.json', {
            officeid: officeId,
            state: 0,
            documenttypeid: documentTypeId,
            emissiondaterange: `[${startUnix},${endUnix}]`,
            expand: '[office,document_type,details]',
            limit,
            offset,
          });

          const documents = page.items ?? [];
          const count = numeric(page.count);
          stats.pages += 1;

          if (!documents.length) {
            break;
          }

          for (const doc of documents) {
            stats.documents_seen += 1;

            const details = doc.details?.items ?? [];

            for (const detail of details) {
              stats.details_seen += 1;

              const variant = detail.variant ?? {};
              const variantId = intOrNull(variant.id);

              if (variantId === null || !params.variantIds.has(variantId)) {
                continue;
              }

              const quantity = numeric(detail.quantity);
              const amount = numeric(detail.totalAmount);
              const sign = signForDocument(documentTypeId);
              const movementType = movementTypeForDocument(documentTypeId);

              movements.push({
                source: 'documents',
                movement_group: movementType === 'VENTA' ? 'VENTA' : 'DEVOLUCION',
                movement_type: movementType,
                office_id: officeId,
                movement_date: unixToDate(doc.emissionDate),
                document_id: intOrNull(doc.id),
                document_detail_id: intOrNull(detail.id),
                document_type_id: documentTypeId,
                variant_id: variantId,
                quantity,
                quantity_signed: quantity * sign,
                total_amount: amount,
                total_amount_signed: amount * sign,
                note: `Documento ${doc.number}`,
              });

              stats.matches += 1;
            }
          }

          offset += limit;
          pageNumber += 1;

          if (offset >= count) {
            break;
          }
        }
      }

      day = addDays(day, 1);
    }
  }

  return {
    movements,
    stats,
  };
}

function buildSummary(params: {
  stockMatches: Record<string, unknown>[];
  lastReception: ReceptionResult;
  documentMovements: Movement[];
}) {
  const received = numeric(params.lastReception?.quantity);
  const sold = params.documentMovements
    .filter((item) => item.movement_group === 'VENTA')
    .reduce((sum, item) => sum + numeric(item.quantity), 0);

  const returned = params.documentMovements
    .filter((item) => item.movement_group === 'DEVOLUCION')
    .reduce((sum, item) => sum + numeric(item.quantity), 0);

  const stockActual = params.stockMatches.reduce((sum, item) => sum + numeric(item.quantity), 0);
  const stockDisponible = params.stockMatches.reduce(
    (sum, item) => sum + numeric(item.quantity_available),
    0,
  );

  const netSold = sold - returned;
  const sellThroughPct = received > 0 ? Math.round((netSold / received) * 10000) / 100 : null;

  return {
    piezas_recibidas_ultima_recepcion: received,
    piezas_vendidas_desde_ultima_recepcion: sold,
    piezas_devueltas_desde_ultima_recepcion: returned,
    piezas_netas_venta_desde_ultima_recepcion: netSold,
    stock_actual: stockActual,
    stock_disponible: stockDisponible,
    sell_through_pct: sellThroughPct,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();

    const query = String(body.query ?? '').trim();
    const officeIds = Array.isArray(body.office_ids)
      ? body.office_ids.map(Number).filter(Boolean)
      : [2, 3, 4];

    const lookbackDays = numeric(body.lookback_days ?? 30);
    const maxReceptionDetails = numeric(body.max_reception_details ?? 1000);

    // Keep document scan complete by default. Older frontend versions may send a
    // temporary cap; ignore it for audit correctness.
    const maxDocumentPagesPerDayType = 0;

    if (!query) {
      return new Response(JSON.stringify({ error: 'Missing query' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const endDate = todayUtc();
    const requestedStartDate = dateDaysAgo(lookbackDays);

    const stockIndexRows = await findStockIndex(query, officeIds);
    const aliasRows = await findAliasIndex(query);

    const variantIds = new Set<number>();

    for (const row of stockIndexRows) {
      if (row.variant_id) variantIds.add(Number(row.variant_id));
    }

    for (const row of aliasRows) {
      if (row.variant_id) variantIds.add(Number(row.variant_id));
    }

    const stockMatches = await getLiveStockMatches(stockIndexRows);

    if (!variantIds.size) {
      return new Response(
        JSON.stringify({
          found: false,
          query,
          office_ids: officeIds,
          message: 'No se encontró variant_id en bsale_stock_current ni bsale_sku_aliases.',
          stock_matches: stockMatches,
          alias_matches: aliasRows.length,
          index_matches: stockIndexRows.length,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const receptionResult = await findLastReception({
      officeIds,
      variantIds,
      lookbackDays,
      endDate,
      maxDetails: maxReceptionDetails,
    });

    if (!receptionResult.last_reception) {
      const summary = buildSummary({
        stockMatches,
        lastReception: null,
        documentMovements: [],
      });

      return new Response(
        JSON.stringify({
          found: true,
          sell_through_found: false,
          query,
          office_ids: officeIds,
          variant_ids: Array.from(variantIds).sort(),
          start_date: requestedStartDate,
          end_date: endDate,
          stock_matches: stockMatches,
          last_reception: null,
          summary,
          movements: [],
          scan_stats: {
            receptions: receptionResult.stats,
            documents: null,
          },
          message: 'SKU encontrado, pero no se encontró recepción dentro del rango consultado.',
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const documentResult = await scanDocumentsSince({
      officeIds,
      variantIds,
      startDate: receptionResult.last_reception.date,
      endDate,
      maxPagesPerDayType: maxDocumentPagesPerDayType,
    });

    const movements = [
      receptionResult.last_reception.movement,
      ...documentResult.movements,
    ].sort((a, b) => String(b.movement_date).localeCompare(String(a.movement_date)));

    const summary = buildSummary({
      stockMatches,
      lastReception: receptionResult.last_reception,
      documentMovements: documentResult.movements,
    });

    return new Response(
      JSON.stringify({
        found: true,
        sell_through_found: true,
        query,
        office_ids: officeIds,
        variant_ids: Array.from(variantIds).sort(),
        start_date: receptionResult.start_date_used,
        end_date: endDate,
        stock_matches: stockMatches,
        last_reception: receptionResult.last_reception.movement,
        summary,
        movements,
        scan_stats: {
          receptions: receptionResult.stats,
          documents: documentResult.stats,
        },
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});
