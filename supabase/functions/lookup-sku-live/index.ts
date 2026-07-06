const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type StockMatch = {
  office_id: number;
  office_name: string | null;
  variant_id: number | null;
  stock_id: number | null;
  sku: string | null;
  barcode: string | null;
  quantity: number;
  quantity_reserved: number;
  quantity_available: number;
};

function normalizeSku(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeBarcode(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, '');
}

function matchesQuery(query: string, sku: string | null, barcode: string | null): boolean {
  const qSku = normalizeSku(query);
  const qBarcode = normalizeBarcode(query);

  return normalizeSku(sku) === qSku || normalizeBarcode(barcode) === qBarcode;
}

async function bsaleGet(path: string, params: Record<string, string | number>) {
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

async function findStockMatches(query: string, officeIds: number[]): Promise<StockMatch[]> {
  const matches: StockMatch[] = [];
  const limit = 50;

  for (const officeId of officeIds) {
    let offset = 0;

    while (true) {
      const page = await bsaleGet('stocks.json', {
        officeid: officeId,
        expand: '[office,variant]',
        limit,
        offset,
      });

      const items = page.items ?? [];
      const count = Number(page.count ?? 0);

      for (const item of items) {
        const variant = item.variant ?? {};
        const office = item.office ?? {};

        const sku = variant.code ?? null;
        const barcode = variant.barCode ?? null;

        if (!matchesQuery(query, sku, barcode)) {
          continue;
        }

        matches.push({
          office_id: Number(office.id ?? officeId),
          office_name: office.name ?? null,
          variant_id: variant.id ? Number(variant.id) : null,
          stock_id: item.id ? Number(item.id) : null,
          sku,
          barcode,
          quantity: Number(item.quantity ?? 0),
          quantity_reserved: Number(item.quantityReserved ?? 0),
          quantity_available: Number(item.quantityAvailable ?? 0),
        });
      }

      offset += limit;

      if (!items.length || offset >= count) {
        break;
      }
    }
  }

  return matches;
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

    const stock_matches = await findStockMatches(query, officeIds);

    return new Response(
      JSON.stringify({
        query,
        source: 'BSALE_LIVE',
        stock_matches,
        found: stock_matches.length > 0,
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
