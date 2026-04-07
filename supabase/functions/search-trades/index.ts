import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateMcpKey, corsHeaders, json } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authErr = validateMcpKey(req);
  if (authErr) return authErr;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const body = await req.json().catch(() => ({}));
  const {
    status,
    buyer_id,
    agent_id,
    product_category,
    date_from,
    date_to,
    limit = 20,
  } = body;

  let q = supabase
    .from("trades")
    .select(`
      id, status, product_name, product_category, cif_value_usd,
      quantity_mt, loading_port, discharge_port, created_at, updated_at,
      buyer:profiles!trades_buyer_id_fkey(id, name, company, country),
      agent:profiles!trades_agent_id_fkey(id, name, company),
      trade_timeline(stage, completed_at),
      trade_documents(document_type, sfr_code, issued_at)
    `)
    .order("created_at", { ascending: false })
    .limit(Math.min(Number(limit), 100));

  if (status)           q = q.eq("status", status);
  if (buyer_id)         q = q.eq("buyer_id", buyer_id);
  if (agent_id)         q = q.eq("agent_id", agent_id);
  if (product_category) q = q.eq("product_category", product_category);
  if (date_from)        q = q.gte("created_at", date_from);
  if (date_to)          q = q.lte("created_at", date_to);

  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);

  return json({
    total: data?.length ?? 0,
    trades: data?.map((t: Record<string, unknown>) => ({
      trade_id:         t.id,
      status:           t.status,
      product:          t.product_name,
      category:         t.product_category,
      cif_value_usd:    t.cif_value_usd,
      quantity_mt:      t.quantity_mt,
      loading_port:     t.loading_port,
      discharge_port:   t.discharge_port,
      buyer:            t.buyer,
      agent:            t.agent,
      current_stage:    Array.isArray(t.trade_timeline)
                          ? t.trade_timeline.length
                          : 0,
      documents_issued: Array.isArray(t.trade_documents)
                          ? t.trade_documents.length
                          : 0,
      created_at:       t.created_at,
      updated_at:       t.updated_at,
    })),
  });
});
