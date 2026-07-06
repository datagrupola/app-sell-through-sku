const SUPABASE_URL =
  Deno.env.get('SUPABASE_URL') ?? 'https://lztornyogibsaswcviss.supabase.co';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

async function supabaseGetStockIndex(
  column: 'sku_norm' | 'barcode_norm',
  value: string,
  officeIds: number[],
): Promise<StockIndexRow[]> {
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!serviceRoleKey) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY secret');
  }

  const url = new URL(`${SUPABASE_URL}/rest/v1/bsale_stock_current`);

  url.searchParams.set(
    'select',
    'office_id,variant_id,stock_id,sku_norm,barcode_norm,quantity,quantity_reserved,quantity_available,synced_at',
  );

  url.searchParams.set(column, `eq.${value}`);

  if (officeIds.length > 0) {
    url.searchParams.set('office_id', `in.(${officeIds.join(',')})`);
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

async function findStockIndexMatches(query: string, officeIds: number[]) {
  const skuQuery = normalizeSku(query);
  const barcodeQuery = normalizeBarcode(query);

  const bySku = await supabaseGetStockIndex('sku_norm', skuQuery, officeIds);
  const byBarcode = await supabaseGetStockIndex('barcode_norm', barcodeQuery, officeIds);

  const seen = new Set<string>();
  const rows: StockIndexRow[] = [];

  for (const row of [...bySku, ...byBarcode]) {
    const key = `${row.office_id}:${row.variant_id}:${row.stock_id}`;
    if (seen.has(key)) continue;

    seen.add(key);
    rows.push(row);
  }

  return rows;
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
    throw new Error(`Bsale API error ${response.status}: ${body.slice(0, 500)}`);
  }

  return response.json();
}

async function getLiveStock(row: StockIndexRow) {
  try {
    const liveStock = await bsaleGet(`stocks/${row.stock_id}.json`, {
      expand: '[office,variant]',
    });

    const office = liveStock.office ?? {};
    const variant = liveStock.variant ?? {};

    return {
      source: 'BSALE_LIVE',
      live_ok: true,
      office_id: numeric(office.id ?? row.office_id),
      office_name: office.name ?? null,
      variant_id: numeric(variant.id ?? row.variant_id),
      stock_id: numeric(liveStock.id ?? row.stock_id),
      sku: variant.code ?? row.sku_norm,
      barcode: variant.barCode ?? row.barcode_norm,
      quantity: numeric(liveStock.quantity ?? row.quantity),
      quantity_reserved: numeric(liveStock.quantityReserved ?? row.quantity_reserved),
      quantity_available: numeric(liveStock.quantityAvailable ?? row.quantity_available),
      index_synced_at: row.synced_at,
    };
  } catch (error) {
    return {
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
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        {
          status: 405,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const body = await req.json();

    const query = String(body.query ?? '').trim();

    const officeIds = Array.isArray(body.office_ids)
      ? body.office_ids.map(Number).filter(Boolean)
      : [2, 3, 4];

    if (!query) {
      return new Response(
        JSON.stringify({ error: 'Missing query' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const indexMatches = await findStockIndexMatches(query, officeIds);
    const stockMatches = await Promise.all(indexMatches.map(getLiveStock));

    return new Response(
      JSON.stringify({
        query,
        source: 'BSALE_LIVE_BY_SUPABASE_INDEX',
        found: stockMatches.length > 0,
        index_matches: indexMatches.length,
        stock_matches: stockMatches,
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
