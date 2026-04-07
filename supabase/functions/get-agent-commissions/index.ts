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

  const { agent_id, status } = await req.json();
  if (!agent_id) return json({ error: "agent_id required" }, 400);

  // Get agent profile
  const { data: agent } = await supabase
    .from("profiles")
    .select("id, name, company, country")
    .eq("id", agent_id)
    .single();

  if (!agent) return json({ error: "Agent not found" }, 404);

  let q = supabase
    .from("agent_commissions")
    .select(`
      id, trade_id, commission_rate_pct, commission_amount_usd,
      status, imfpa_reference, expected_payment_date, paid_at, notes,
      trade:trades(product_name, product_category, cif_value_usd,
        buyer:profiles!trades_buyer_id_fkey(name, company))
    `)
    .eq("agent_id", agent_id)
    .order("created_at", { ascending: false });

  if (status) q = q.eq("status", status);

  const { data: commissions, error } = await q;
  if (error) return json({ error: error.message }, 500);

  const summary = {
    total_commissions:     commissions?.length ?? 0,
    total_pending_usd:     commissions?.filter((c: Record<string, unknown>) => c.status === "pending")
                             .reduce((s: number, c: Record<string, unknown>) => s + Number(c.commission_amount_usd ?? 0), 0) ?? 0,
    total_payable_usd:     commissions?.filter((c: Record<string, unknown>) => c.status === "payable")
                             .reduce((s: number, c: Record<string, unknown>) => s + Number(c.commission_amount_usd ?? 0), 0) ?? 0,
    total_paid_usd:        commissions?.filter((c: Record<string, unknown>) => c.status === "paid")
                             .reduce((s: number, c: Record<string, unknown>) => s + Number(c.commission_amount_usd ?? 0), 0) ?? 0,
  };

  return json({
    agent,
    summary,
    commissions: commissions?.map((c: Record<string, unknown>) => ({
      commission_id:         c.id,
      trade_id:              c.trade_id,
      product:               (c.trade as Record<string, unknown>)?.product_name,
      category:              (c.trade as Record<string, unknown>)?.product_category,
      cif_value_usd:         (c.trade as Record<string, unknown>)?.cif_value_usd,
      buyer:                 (c.trade as Record<string, unknown>)?.buyer,
      commission_rate_pct:   c.commission_rate_pct,
      commission_amount_usd: c.commission_amount_usd,
      status:                c.status,
      imfpa_reference:       c.imfpa_reference,
      expected_payment_date: c.expected_payment_date,
      paid_at:               c.paid_at,
      notes:                 c.notes,
    })),
  });
});
