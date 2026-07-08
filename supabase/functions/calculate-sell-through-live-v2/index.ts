const SUPABASE_URL =
  Deno.env.get('SUPABASE_URL') ?? 'https://lztornyogibsaswcviss.supabase.co';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SALE_DOCUMENT_TYPES = new Set([10, 40, 44]);
const RETURN_DOCUMENT_TYPES = new Set([39, 41]);
const DEFAULT_DOCUMENT_TYPES = [10, 39, 40, 41, 44];
const RECEPTION_PAGE_LIMIT = 50;
const DETAIL_PAGE_LIMIT = 100;
const DOCUMENT_PAGE_LIMIT = 50;
const CONSUMPTION_PAGE_LIMIT = 50;

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
  count_requests: number;
  receptions_seen: number;
  details_seen: number;
  matches: number;
  lookup_windows: number[];
  stopped_after_first_match: boolean;
  assumed_reception_order: string;
  start_offsets: Array<{ office_id: number; count: number; start_offset: number }>;
  detail_errors: Array<{ reception_id: number; message: string }>;
};

type DocumentStats = {
  pages: number;
  documents_seen: number;
  details_seen: number;
  detail_requests: number;
  matches: number;
  detail_errors: Array<{ document_id: number | null; message: string }>;
};

type ConsumptionStats = {
  pages: number;
  count_requests: number;
  consumptions_seen_in_date_range: number;
  details_seen: number;
  detail_requests: number;
  matches: number;
  start_offsets: Array<{ office_id: number; count: number; start_offset: number }>;
  detail_errors: Array<{ consumption_id: number | null; message: string }>;
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
  return RETURN_DOCUMENT_TYPES.has(documentTypeId) ? -1 : 1;
}

function classifyReception(reception: Record<string, unknown>): string {
  const internalDispatch = (reception.internalDispatch ?? {}) as Record<string, unknown>;
  const internalDispatchId = intOrNull(internalDispatch.id ?? reception.internalDispatchId);
  if (internalDispatchId) return 'RECEPCION_DESPACHO_INTERNO';
  if (boolValue(reception.updateStock)) return 'ENTRADA_STOCK';
  return 'ENTRADA_IMPORTADA_AMBIGUA';
}

function betterReception(candidate: ReceptionResult, current: ReceptionResult): boolean {
  if (!candidate) return false;
  if (!current) return true;
  if (candidate.date > current.date) return true;
  if (candidate.date < current.date) return false;
  return candidate.reception_id > current.reception_id;
}

function sortedVariantIds(variantIds: Set<number>): number[] {
  return Array.from(variantIds).sort((a, b) => a - b);
}

async function supabaseGet(table: string, params: Record<string, string>) {
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceRoleKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY secret');

  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

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
  if (!token) throw new Error('Missing BSALE_ACCESS_TOKEN secret');

  const url = new URL(`https://api.bsale.com.mx/v1/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  const response = await fetch(url, {
    method: 'GET',
    headers: { access_token: token, 'Content-Type': 'application/json' },
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
  return rows.filter((row) => {
    const key = `${row.office_id}:${row.variant_id}:${row.stock_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  return rows.filter((row) => {
    const key = `${row.variant_id}:${row.sku_norm}:${row.barcode_norm}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getLiveStockMatches(stockRows: StockIndexRow[]) {
  const matches = [];
  for (const row of stockRows) {
    try {
      const live = await bsaleGet(`stocks/${row.stock_id}.json`, { expand: '[office,variant]' });
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

async function listPagedDetails(path: string, maxDetails: number) {
  const items: Record<string, unknown>[] = [];
  let offset = 0;
  let requests = 0;

  while (true) {
    const page = await bsaleGet(path, { limit: DETAIL_PAGE_LIMIT, offset });
    requests += 1;
    const pageItems = (page.items ?? []) as Record<string, unknown>[];
    items.push(...pageItems);

    const count = numeric(page.count);
    offset += DETAIL_PAGE_LIMIT;

    if (maxDetails > 0 && items.length >= maxDetails) {
      return { items: items.slice(0, maxDetails), requests };
    }

    if (!pageItems.length || offset >= count) break;
  }

  return { items, requests };
}

async function listReceptionDetails(receptionId: number, maxDetails: number) {
  const result = await listPagedDetails(`stocks/receptions/${receptionId}/details.json`, maxDetails);
  return result.items;
}

async function listDocumentDetails(documentId: number, maxDetails: number) {
  return listPagedDetails(`documents/${documentId}/details.json`, maxDetails);
}

async function listConsumptionDetails(consumptionId: number, maxDetails: number) {
  return listPagedDetails(`stocks/consumptions/${consumptionId}/details.json`, maxDetails);
}

async function getDocumentDetails(doc: Record<string, unknown>, maxDetails: number) {
  const details = (doc.details ?? {}) as Record<string, unknown>;
  const expandedItems = Array.isArray(details.items) ? (details.items as Record<string, unknown>[]) : [];
  const expandedCount = intOrNull(details.count) ?? expandedItems.length;

  if (expandedItems.length >= expandedCount) {
    return { items: expandedItems, requests: 0 };
  }

  const documentId = intOrNull(doc.id);
  if (documentId === null) return { items: expandedItems, requests: 0 };
  return listDocumentDetails(documentId, maxDetails);
}

function buildReception(params: {
  reception: Record<string, unknown>;
  officeId: number;
  admissionDate: string;
  receptionId: number;
  matchingDetails: Array<{ detail: Record<string, unknown>; variantId: number }>;
}): ReceptionResult {
  const firstMatch = params.matchingDetails[0];
  const firstDetail = firstMatch.detail;
  const quantity = params.matchingDetails.reduce((sum, item) => sum + numeric(item.detail.quantity), 0);
  const variantStock = params.matchingDetails.reduce((sum, item) => sum + numeric(item.detail.variantStock), 0);

  return {
    date: params.admissionDate,
    reception_id: params.receptionId,
    quantity,
    cost: numeric(firstDetail.cost),
    movement: {
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
      document: params.reception.document ?? null,
      document_number: params.reception.documentNumber ?? null,
      internal_dispatch_id: intOrNull(params.reception.internalDispatchId),
      note: params.reception.note || params.reception.document || null,
    },
  };
}

async function findLastReceptionInWindow(params: {
  officeIds: number[];
  variantIds: Set<number>;
  startDate: string;
  endDate: string;
  maxDetails: number;
  maxPagesPerOffice: number;
}) {
  let latest: ReceptionResult = null;
  const stats = {
    pages: 0,
    count_requests: 0,
    receptions_seen: 0,
    details_seen: 0,
    matches: 0,
    start_offsets: [] as Array<{ office_id: number; count: number; start_offset: number }>,
    detail_errors: [] as Array<{ reception_id: number; message: string }>,
  };

  for (const officeId of params.officeIds) {
    const countPage = await bsaleGet('stocks/receptions.json', {
      officeid: officeId,
      expand: '[office]',
      limit: 1,
      offset: 0,
    });

    stats.count_requests += 1;
    const count = numeric(countPage.count);
    if (count <= 0) continue;

    let offset = Math.max(0, count - RECEPTION_PAGE_LIMIT);
    let pagesInOffice = 0;
    let stopOffice = false;
    stats.start_offsets.push({ office_id: officeId, count, start_offset: offset });

    while (offset >= 0 && !stopOffice) {
      if (params.maxPagesPerOffice > 0 && pagesInOffice >= params.maxPagesPerOffice) break;

      const page = await bsaleGet('stocks/receptions.json', {
        officeid: officeId,
        expand: '[office]',
        limit: RECEPTION_PAGE_LIMIT,
        offset,
      });

      const receptions = ((page.items ?? []) as Record<string, unknown>[]).slice().reverse();
      stats.pages += 1;
      pagesInOffice += 1;

      if (!receptions.length) break;

      for (const reception of receptions) {
        stats.receptions_seen += 1;
        const admissionDate = unixToDate(reception.admissionDate);

        if (admissionDate && admissionDate > params.endDate) continue;
        if (admissionDate && admissionDate < params.startDate) {
          stopOffice = true;
          break;
        }
        if (!dateInRange(admissionDate, params.startDate, params.endDate)) continue;

        const receptionId = numeric(reception.id);
        let details: Record<string, unknown>[];

        try {
          details = await listReceptionDetails(receptionId, params.maxDetails);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          if (message.includes('Bsale API error 403')) {
            stats.detail_errors.push({
              reception_id: receptionId,
              message: message.slice(0, 220),
            });
            continue;
          }

          throw error;
        }

        const matchingDetails: Array<{ detail: Record<string, unknown>; variantId: number }> = [];

        for (const detail of details) {
          stats.details_seen += 1;
          const variant = (detail.variant ?? {}) as Record<string, unknown>;
          const variantId = intOrNull(variant.id);
          if (variantId === null || !params.variantIds.has(variantId)) continue;
          matchingDetails.push({ detail, variantId });
        }

        if (!matchingDetails.length) continue;

        stats.matches += matchingDetails.length;
        const candidate = buildReception({
          reception,
          officeId,
          admissionDate: String(admissionDate),
          receptionId,
          matchingDetails,
        });

        if (betterReception(candidate, latest)) latest = candidate;
        stopOffice = true;
        break;
      }

      offset -= RECEPTION_PAGE_LIMIT;
    }
  }

  return { last_reception: latest, stats };
}

async function findLastReceptionProgressive(params: {
  officeIds: number[];
  variantIds: Set<number>;
  lookbackDays: number;
  endDate: string;
  maxDetails: number;
  maxPagesPerOffice: number;
}) {
  const requestedLookback = Math.max(1, Math.trunc(params.lookbackDays || 365));
  const startDate = dateDaysAgo(requestedLookback);

  const stats: ReceptionStats = {
    pages: 0,
    count_requests: 0,
    receptions_seen: 0,
    details_seen: 0,
    matches: 0,
    lookup_windows: [requestedLookback],
    stopped_after_first_match: false,
    assumed_reception_order: 'oldest_first_reverse_scan',
    start_offsets: [],
    detail_errors: [],
  };

  const windowResult = await findLastReceptionInWindow({
    officeIds: params.officeIds,
    variantIds: params.variantIds,
    startDate,
    endDate: params.endDate,
    maxDetails: params.maxDetails,
    maxPagesPerOffice: params.maxPagesPerOffice,
  });

  stats.pages += windowResult.stats.pages;
  stats.count_requests += windowResult.stats.count_requests;
  stats.receptions_seen += windowResult.stats.receptions_seen;
  stats.details_seen += windowResult.stats.details_seen;
  stats.matches += windowResult.stats.matches;
  stats.start_offsets.push(...windowResult.stats.start_offsets);
  stats.detail_errors.push(...(windowResult.stats.detail_errors ?? []));

  if (windowResult.last_reception) {
    stats.stopped_after_first_match = true;
    return {
      last_reception: windowResult.last_reception,
      stats,
      start_date_used: startDate,
    };
  }

  return {
    last_reception: null,
    stats,
    start_date_used: startDate,
  };
}

async function scanDocumentsSince(params: {
  officeIds: number[];
  variantIds: Set<number>;
  startDate: string;
  endDate: string;
  maxPagesPerDayType: number;
  maxDetails: number;
}) {
  const movements: Movement[] = [];
  const stats: DocumentStats = {
    pages: 0,
    documents_seen: 0,
    details_seen: 0,
    detail_requests: 0,
    matches: 0,
    detail_errors: [],
  };

  for (const officeId of params.officeIds) {
    let day = params.startDate;
    while (day <= params.endDate) {
      const startUnix = dateToUnixUtc(day, false);
      const endUnix = dateToUnixUtc(day, true);

      for (const documentTypeId of DEFAULT_DOCUMENT_TYPES) {
        let offset = 0;
        let pageNumber = 0;
        while (true) {
          if (params.maxPagesPerDayType > 0 && pageNumber >= params.maxPagesPerDayType) break;

          const page = await bsaleGet('documents.json', {
            officeid: officeId,
            state: 0,
            documenttypeid: documentTypeId,
            emissiondaterange: `[${startUnix},${endUnix}]`,
            expand: '[office,document_type,details]',
            limit: DOCUMENT_PAGE_LIMIT,
            offset,
          });

          const documents = (page.items ?? []) as Record<string, unknown>[];
          const count = numeric(page.count);
          stats.pages += 1;
          pageNumber += 1;

          if (!documents.length) break;

          for (const doc of documents) {
            stats.documents_seen += 1;

            let details: Record<string, unknown>[] = [];
            try {
              const detailResult = await getDocumentDetails(doc, params.maxDetails);
              details = detailResult.items;
              stats.detail_requests += detailResult.requests;
            } catch (error) {
              stats.detail_errors.push({
                document_id: intOrNull(doc.id),
                message: error instanceof Error ? error.message.slice(0, 220) : String(error).slice(0, 220),
              });
              continue;
            }

            for (const detail of details) {
              stats.details_seen += 1;
              const variant = (detail.variant ?? {}) as Record<string, unknown>;
              const variantId = intOrNull(variant.id);
              if (variantId === null || !params.variantIds.has(variantId)) continue;

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
                document_number: doc.number ?? doc.documentNumber ?? null,
                variant_id: variantId,
                quantity,
                quantity_signed: quantity * sign,
                total_amount: amount,
                total_amount_signed: amount * sign,
                note: `Documento ${doc.number ?? doc.id ?? ''}`.trim(),
              });
              stats.matches += 1;
            }
          }

          offset += DOCUMENT_PAGE_LIMIT;
          if (offset >= count) break;
        }
      }
      day = addDays(day, 1);
    }
  }

  return { movements, stats };
}

async function scanConsumptionsSince(params: {
  officeIds: number[];
  variantIds: Set<number>;
  startDate: string;
  endDate: string;
  maxPagesPerOffice: number;
  maxDetails: number;
}) {
  const startUnix = dateToUnixUtc(params.startDate, false);
  const endUnix = dateToUnixUtc(params.endDate, true);
  const movements: Movement[] = [];
  const stats: ConsumptionStats = {
    pages: 0,
    count_requests: 0,
    consumptions_seen_in_date_range: 0,
    details_seen: 0,
    detail_requests: 0,
    matches: 0,
    start_offsets: [],
    detail_errors: [],
  };

  for (const officeId of params.officeIds) {
    const countPage = await bsaleGet('stocks/consumptions.json', {
      officeid: officeId,
      limit: 1,
      offset: 0,
    });

    stats.count_requests += 1;
    const count = numeric(countPage.count);
    if (count <= 0) continue;

    let offset = Math.max(0, count - CONSUMPTION_PAGE_LIMIT);
    let pagesInOffice = 0;
    let stopOffice = false;
    stats.start_offsets.push({ office_id: officeId, count, start_offset: offset });

    while (offset >= 0 && !stopOffice) {
      if (params.maxPagesPerOffice > 0 && pagesInOffice >= params.maxPagesPerOffice) break;

      const page = await bsaleGet('stocks/consumptions.json', {
        officeid: officeId,
        limit: CONSUMPTION_PAGE_LIMIT,
        offset,
      });

      const consumptions = ((page.items ?? []) as Record<string, unknown>[]).slice().reverse();
      stats.pages += 1;
      pagesInOffice += 1;

      if (!consumptions.length) break;

      for (const consumption of consumptions) {
        const consumptionUnix = intOrNull(consumption.consumptionDate);
        if (consumptionUnix === null) continue;

        if (consumptionUnix > endUnix) continue;
        if (consumptionUnix < startUnix) continue;

        stats.consumptions_seen_in_date_range += 1;
        const consumptionId = intOrNull(consumption.id);
        if (consumptionId === null) continue;

        let details: Record<string, unknown>[] = [];
        try {
          const detailResult = await listConsumptionDetails(consumptionId, params.maxDetails);
          details = detailResult.items;
          stats.detail_requests += detailResult.requests;
        } catch (error) {
          stats.detail_errors.push({
            consumption_id: consumptionId,
            message: error instanceof Error ? error.message.slice(0, 220) : String(error).slice(0, 220),
          });
          continue;
        }

        for (const detail of details) {
          stats.details_seen += 1;
          const variant = (detail.variant ?? {}) as Record<string, unknown>;
          const variantId = intOrNull(variant.id);
          if (variantId === null || !params.variantIds.has(variantId)) continue;

          const quantity = numeric(detail.quantity);
          const updateStock = boolValue(consumption.updateStock);
          const movementType = updateStock ? 'CONSUMO_AJUSTE_STOCK' : 'CONSUMO_SIN_AFECTAR_STOCK';

          movements.push({
            source: 'consumptions',
            movement_group: 'CONSUMO_AJUSTE',
            movement_type: movementType,
            office_id: officeId,
            movement_date: unixToDate(consumptionUnix),
            consumption_id: consumptionId,
            consumption_detail_id: intOrNull(detail.id),
            consumption_type_id: intOrNull(consumption.consumptionTypeId),
            variant_id: variantId,
            quantity,
            quantity_signed: -quantity,
            cost: numeric(detail.cost),
            variant_stock: numeric(detail.variantStock),
            update_stock: updateStock,
            note: consumption.note ?? null,
          });
          stats.matches += 1;
        }
      }

      const oldestInPage = consumptions
        .map((item) => intOrNull(item.consumptionDate))
        .filter((value): value is number => value !== null)
        .reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);

      if (Number.isFinite(oldestInPage) && oldestInPage < startUnix) break;
      offset -= CONSUMPTION_PAGE_LIMIT;
    }
  }

  return { movements, stats };
}

function buildSummary(params: {
  stockMatches: Record<string, unknown>[];
  lastReception: ReceptionResult;
  documentMovements: Movement[];
  consumptionMovements: Movement[];
}) {
  const received = numeric(params.lastReception?.quantity);
  const sold = params.documentMovements
    .filter((item) => item.movement_group === 'VENTA')
    .reduce((sum, item) => sum + numeric(item.quantity), 0);
  const returned = params.documentMovements
    .filter((item) => item.movement_group === 'DEVOLUCION')
    .reduce((sum, item) => sum + numeric(item.quantity), 0);
  const consumed = params.consumptionMovements.reduce((sum, item) => sum + numeric(item.quantity), 0);
  const consumedStockAffecting = params.consumptionMovements
    .filter((item) => item.update_stock === true)
    .reduce((sum, item) => sum + numeric(item.quantity), 0);
  const consumedNonStockAffecting = consumed - consumedStockAffecting;
  const stockActual = params.stockMatches.reduce((sum, item) => sum + numeric(item.quantity), 0);
  const stockDisponible = params.stockMatches.reduce((sum, item) => sum + numeric(item.quantity_available), 0);
  const netSold = sold - returned;
  const stockOutflow = netSold + consumedStockAffecting;
  const outflowExceedsReception = received > 0 && stockOutflow > received;

  return {
    piezas_recibidas_ultima_recepcion: received,
    piezas_vendidas_desde_ultima_recepcion: sold,
    piezas_devueltas_desde_ultima_recepcion: returned,
    piezas_netas_venta_desde_ultima_recepcion: netSold,
    piezas_consumidas_ajuste_desde_ultima_recepcion: consumed,
    piezas_consumidas_ajuste_stock_desde_ultima_recepcion: consumedStockAffecting,
    piezas_consumidas_sin_afectar_stock_desde_ultima_recepcion: consumedNonStockAffecting,
    piezas_salidas_stock_desde_ultima_recepcion: stockOutflow,
    stock_actual: stockActual,
    stock_disponible: stockDisponible,
    sell_through_pct: received > 0 ? Math.round((netSold / received) * 10000) / 100 : null,
    salidas_vs_recepcion_pct: received > 0 ? Math.round((stockOutflow / received) * 10000) / 100 : null,
    advertencia_salidas_superan_ultima_recepcion: outflowExceedsReception,
    nota_trazabilidad: outflowExceedsReception
      ? 'Las salidas de stock desde la última recepción superan la cantidad recibida; no se puede atribuir todo a ese lote sin una regla FIFO explícita.'
      : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

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
    const lookbackDays = numeric(body.lookback_days ?? 365);
    const maxDocumentPagesPerDayType = numeric(body.max_document_pages_per_day_type ?? 0);
    const maxReceptionPagesPerOffice = numeric(body.max_reception_pages_per_office ?? 0);
    const maxConsumptionPagesPerOffice = numeric(body.max_consumption_pages_per_office ?? 0);
    const maxReceptionDetails = Math.max(1000, numeric(body.max_reception_details ?? 1000));
    const maxDocumentDetails = Math.max(1000, numeric(body.max_document_details ?? 1000));
    const maxConsumptionDetails = Math.max(1000, numeric(body.max_consumption_details ?? 1000));

    if (!query) {
      return new Response(JSON.stringify({ error: 'Missing query' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const endDate = todayUtc();
    const stockIndexRows = await findStockIndex(query, officeIds);
    const aliasRows = await findAliasIndex(query);
    const variantIds = new Set<number>();
    for (const row of stockIndexRows) if (row.variant_id) variantIds.add(Number(row.variant_id));
    for (const row of aliasRows) if (row.variant_id) variantIds.add(Number(row.variant_id));

    const stockMatches = await getLiveStockMatches(stockIndexRows);

    if (!variantIds.size) {
      return new Response(
        JSON.stringify({
          found: false,
          function_version: 'v2.1-reverse-receptions-consumptions',
          query,
          office_ids: officeIds,
          message: 'No se encontró variant_id en bsale_stock_current ni bsale_sku_aliases.',
          stock_matches: stockMatches,
          alias_matches: aliasRows.length,
          index_matches: stockIndexRows.length,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const receptionResult = await findLastReceptionProgressive({
      officeIds,
      variantIds,
      lookbackDays,
      endDate,
      maxDetails: maxReceptionDetails,
      maxPagesPerOffice: maxReceptionPagesPerOffice,
    });

    if (!receptionResult.last_reception) {
      const summary = buildSummary({
        stockMatches,
        lastReception: null,
        documentMovements: [],
        consumptionMovements: [],
      });
      return new Response(
        JSON.stringify({
          found: true,
          sell_through_found: false,
          function_version: 'v2.1-reverse-receptions-consumptions',
          query,
          office_ids: officeIds,
          variant_ids: sortedVariantIds(variantIds),
          start_date: receptionResult.start_date_used,
          end_date: endDate,
          stock_matches: stockMatches,
          last_reception: null,
          summary,
          movements: [],
          scan_stats: { receptions: receptionResult.stats, documents: null, consumptions: null },
          diagnostic: {
            phase: 'reception_scan',
            lookup_windows_used: receptionResult.stats.lookup_windows,
            reception_order_strategy: receptionResult.stats.assumed_reception_order,
            document_scan_start: null,
            consumption_scan_start: null,
          },
          message: 'SKU encontrado, pero no se encontró recepción dentro del rango consultado.',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const scanStartDate = receptionResult.last_reception.date;

    const documentResult = await scanDocumentsSince({
      officeIds,
      variantIds,
      startDate: scanStartDate,
      endDate,
      maxPagesPerDayType: maxDocumentPagesPerDayType,
      maxDetails: maxDocumentDetails,
    });

    const consumptionResult = await scanConsumptionsSince({
      officeIds,
      variantIds,
      startDate: scanStartDate,
      endDate,
      maxPagesPerOffice: maxConsumptionPagesPerOffice,
      maxDetails: maxConsumptionDetails,
    });

    const movements = [
      receptionResult.last_reception.movement,
      ...documentResult.movements,
      ...consumptionResult.movements,
    ].sort((a, b) => {
      const dateCompare = String(b.movement_date).localeCompare(String(a.movement_date));
      if (dateCompare !== 0) return dateCompare;
      return String(b.source).localeCompare(String(a.source));
    });

    const summary = buildSummary({
      stockMatches,
      lastReception: receptionResult.last_reception,
      documentMovements: documentResult.movements,
      consumptionMovements: consumptionResult.movements,
    });

    return new Response(
      JSON.stringify({
        found: true,
        sell_through_found: true,
        function_version: 'v2.1-reverse-receptions-consumptions',
        query,
        office_ids: officeIds,
        variant_ids: sortedVariantIds(variantIds),
        start_date: receptionResult.start_date_used,
        scan_start_date: scanStartDate,
        end_date: endDate,
        stock_matches: stockMatches,
        last_reception: receptionResult.last_reception.movement,
        summary,
        movements,
        scan_stats: {
          receptions: receptionResult.stats,
          documents: documentResult.stats,
          consumptions: consumptionResult.stats,
        },
        diagnostic: {
          phase: 'complete',
          lookup_windows_used: receptionResult.stats.lookup_windows,
          reception_order_strategy: receptionResult.stats.assumed_reception_order,
          last_reception_date: receptionResult.last_reception.date,
          document_scan_start: scanStartDate,
          consumption_scan_start: scanStartDate,
        },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        function_version: 'v2.1-reverse-receptions-consumptions',
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
