const SUPABASE_URL =
  Deno.env.get('SUPABASE_URL') ?? 'https://lztornyogibsaswcviss.supabase.co';

const GITHUB_OWNER = 'datagrupola';
const GITHUB_REPO = 'app-sell-through-sku';
const GITHUB_WORKFLOW_FILE = 'run_live_traceability_job.yml';
const GITHUB_REF = 'main';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [2, 3, 4];

  const parsed = value
    .map(Number)
    .filter((item) => Number.isFinite(item) && item > 0);

  return parsed.length ? parsed : [2, 3, 4];
}

async function createJob(query: string, officeIds: number[]) {
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!serviceRoleKey) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY secret');
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/bsale_live_traceability_jobs`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      query_text: query,
      office_ids: officeIds,
      status: 'queued',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase create job error ${response.status}: ${body.slice(0, 500)}`);
  }

  const rows = await response.json();

  if (!rows?.[0]?.id) {
    throw new Error('Supabase did not return a job id');
  }

  return rows[0];
}

async function dispatchWorkflow(jobId: string, options: {
  lookbackDays: number;
  maxDocumentPagesPerDayType: number;
  maxReceptionPagesPerOffice: number;
  maxConsumptionPagesPerOffice: number;
}) {
  const token = Deno.env.get('WORKFLOW_DISPATCH_TOKEN');

  if (!token) {
    throw new Error('Missing WORKFLOW_DISPATCH_TOKEN secret');
  }

  const url =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
    `/actions/workflows/${GITHUB_WORKFLOW_FILE}/dispatches`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'app-sell-through-sku',
    },
    body: JSON.stringify({
      ref: GITHUB_REF,
      inputs: {
        job_id: jobId,
        lookback_days: String(options.lookbackDays),
        max_document_pages_per_day_type: String(options.maxDocumentPagesPerDayType),
        max_reception_pages_per_office: String(options.maxReceptionPagesPerOffice),
        max_consumption_pages_per_office: String(options.maxConsumptionPagesPerOffice),
      },
    }),
  });

  if (response.status !== 204) {
    const body = await response.text();
    throw new Error(`GitHub workflow dispatch error ${response.status}: ${body.slice(0, 500)}`);
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
    const officeIds = asNumberArray(body.office_ids);

    if (!query) {
      return new Response(
        JSON.stringify({ error: 'Missing query' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const lookbackDays = Number(body.lookback_days ?? 10);
    const maxDocumentPagesPerDayType = Number(body.max_document_pages_per_day_type ?? 0);
    const maxReceptionPagesPerOffice = Number(body.max_reception_pages_per_office ?? 0);
    const maxConsumptionPagesPerOffice = Number(body.max_consumption_pages_per_office ?? 0);

    const job = await createJob(query, officeIds);

    await dispatchWorkflow(job.id, {
      lookbackDays,
      maxDocumentPagesPerDayType,
      maxReceptionPagesPerOffice,
      maxConsumptionPagesPerOffice,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        job_id: job.id,
        status: job.status,
        query_text: job.query_text,
        office_ids: job.office_ids,
        message: 'Live traceability job created and workflow dispatched',
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});
