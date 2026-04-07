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

  const { trade_id } = await req.json();
  if (!trade_id) return json({ error: "trade_id required" }, 400);

  const { data: trade, error: tErr } = await supabase
    .from("trades")
    .select("id, status, cif_value_usd, product_name, buyer:profiles!trades_buyer_id_fkey(name,company)")
    .eq("id", trade_id)
    .single();

  if (tErr || !trade) return json({ error: "Trade not found" }, 404);

  const { data: apg, error: aErr } = await supabase
    .from("trade_apg_records")
    .select("*")
    .eq("trade_id", trade_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: tariff } = await supabase
    .from("trade_tariff_payments")
    .select("*")
    .eq("trade_id", trade_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return json({
    trade_id,
    trade_status:        trade.status,
    product:             trade.product_name,
    cif_value_usd:       trade.cif_value_usd,
    buyer:               trade.buyer,
    tariff_payment: tariff
      ? {
          invoice_amount_usd: tariff.amount_usd,
          invoice_date:       tariff.invoice_date,
          payment_date:       tariff.paid_at,
          payment_method:     tariff.payment_method,
          receipt_reference:  tariff.receipt_ref,
        }
      : null,
    apg: apg
      ? {
          apg_reference:      apg.apg_reference,
          issuing_bank:       apg.issuing_bank,
          issue_date:         apg.issue_date,
          expiry_date:        apg.expiry_date,
          cci_arbitration_ref: apg.cci_reference,
          status:             apg.status,
          amount_usd:         apg.amount_usd,
          notes:              apg.notes,
        }
      : null,
    apg_active: apg?.status === "active",
  });
});
