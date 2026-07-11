const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") ??
  "https://lztornyogibsaswcviss.supabase.co";

const GITHUB_OWNER = "datagrupola";
const GITHUB_REPO = "app-sell-through-sku";
const GITHUB_WORKFLOW_FILE =
  "run_sell_through_chunks.yml";
const GITHUB_REF = "main";

const ALLOWED_OFFICES = new Set([2, 3, 4]);
const MAX_PERIOD_DAYS = 366;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Action = "start" | "check";

type RequestBody = {
  action?: Action;
  query?: unknown;
  office_id?: unknown;
  office_ids?: unknown;
  period_start_date?: unknown;
  period_end_date?: unknown;
};

type CacheRow = {
  result: Record<string, unknown>;
  computed_at: string;
  expires_at: string;
  source_run_id: number | null;
};

function jsonResponse(
  payload: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(
    JSON.stringify(payload),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    },
  );
}

function parseOfficeId(body: RequestBody): number {
  const firstOffice = Array.isArray(body.office_ids)
    ? body.office_ids[0]
    : undefined;

  const officeId = Number(
    body.office_id ?? firstOffice,
  );

  if (
    !Number.isInteger(officeId) ||
    !ALLOWED_OFFICES.has(officeId)
  ) {
    throw new Error(
      "office_id debe ser 2, 3 o 4",
    );
  }

  return officeId;
}

function parseDate(
  value: unknown,
  field: string,
): string {
  const text = String(value ?? "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(
      `${field} debe usar formato YYYY-MM-DD`,
    );
  }

  const parsed = Date.parse(`${text}T00:00:00Z`);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} no es una fecha válida`);
  }

  return text;
}

function validatePeriod(
  startDate: string,
  endDate: string,
): void {
  const startMs = Date.parse(
    `${startDate}T00:00:00Z`,
  );
  const endMs = Date.parse(
    `${endDate}T00:00:00Z`,
  );

  if (endMs < startMs) {
    throw new Error(
      "La fecha inicial no puede ser mayor que la final",
    );
  }

  const periodDays =
    Math.floor((endMs - startMs) / 86_400_000) + 1;

  if (periodDays > MAX_PERIOD_DAYS) {
    throw new Error(
      `El periodo no puede superar ${MAX_PERIOD_DAYS} días`,
    );
  }

  const now = new Date();
  const yesterday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 1,
  );

  if (endMs > yesterday) {
    throw new Error(
      "La fecha final no puede ser posterior a ayer",
    );
  }
}

function serviceRoleKey(): string {
  const key = Deno.env.get(
    "SUPABASE_SERVICE_ROLE_KEY",
  );

  if (!key) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY secret",
    );
  }

  return key;
}

async function findCache(params: {
  queryNorm: string;
  officeId: number;
  startDate: string;
  endDate: string;
}): Promise<CacheRow | null> {
  const key = serviceRoleKey();

  const search = new URLSearchParams({
    select:
      "result,computed_at,expires_at,source_run_id",
    query_norm: `eq.${params.queryNorm}`,
    office_id: `eq.${params.officeId}`,
    analysis_mode: "eq.period",
    start_date: `eq.${params.startDate}`,
    end_date: `eq.${params.endDate}`,
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1",
  });

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/sell_through_cache?${search}`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `Supabase cache lookup error ${response.status}: ` +
        text.slice(0, 500),
    );
  }

  const rows = await response.json();

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return rows[0] as CacheRow;
}

async function dispatchWorkflow(params: {
  query: string;
  officeId: number;
  startDate: string;
  endDate: string;
}): Promise<void> {
  const token = Deno.env.get(
    "WORKFLOW_DISPATCH_TOKEN",
  );

  if (!token) {
    throw new Error(
      "Missing WORKFLOW_DISPATCH_TOKEN secret",
    );
  }

  const url =
    `https://api.github.com/repos/` +
    `${GITHUB_OWNER}/${GITHUB_REPO}/actions/` +
    `workflows/${GITHUB_WORKFLOW_FILE}/dispatches`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "app-sell-through-sku",
    },
    body: JSON.stringify({
      ref: GITHUB_REF,
      inputs: {
        query: params.query,
        office_id: String(params.officeId),
        start_date: params.startDate,
        end_date: params.endDate,
      },
    }),
  });

  if (response.status !== 204) {
    const text = await response.text();

    throw new Error(
      `GitHub workflow dispatch error ` +
        `${response.status}: ${text.slice(0, 500)}`,
    );
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "Method not allowed",
      },
      405,
    );
  }

  try {
    const body = await req.json() as RequestBody;

    const action = body.action ?? "start";

    if (action !== "start" && action !== "check") {
      return jsonResponse(
        {
          ok: false,
          error: "action debe ser start o check",
        },
        400,
      );
    }

    const query = String(
      body.query ?? "",
    ).trim();

    if (!query) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing query",
        },
        400,
      );
    }

    const queryNorm = query.toUpperCase();
    const officeId = parseOfficeId(body);

    const startDate = parseDate(
      body.period_start_date,
      "period_start_date",
    );

    const endDate = parseDate(
      body.period_end_date,
      "period_end_date",
    );

    validatePeriod(startDate, endDate);

    const cache = await findCache({
      queryNorm,
      officeId,
      startDate,
      endDate,
    });

    if (cache) {
      return jsonResponse({
        ok: true,
        status: "ready",
        cache_hit: true,
        computed_at: cache.computed_at,
        expires_at: cache.expires_at,
        source_run_id: cache.source_run_id,
        result: cache.result,
      });
    }

    if (action === "check") {
      return jsonResponse(
        {
          ok: true,
          status: "processing",
          cache_hit: false,
          dispatched: false,
        },
        202,
      );
    }

    await dispatchWorkflow({
      query,
      officeId,
      startDate,
      endDate,
    });

    return jsonResponse(
      {
        ok: true,
        status: "processing",
        cache_hit: false,
        dispatched: true,
        message:
          "El cálculo fue enviado a GitHub Actions",
      },
      202,
    );
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500,
    );
  }
});
