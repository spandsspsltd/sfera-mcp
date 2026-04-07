import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateMcpKey, corsHeaders, json } from "../_shared/auth.ts";

const VALID_TEMPLATES = ["FCO","SPA","SCO","ICPO","IMFPA","APG_REQUEST","INVOICE"];

function generateSfrCode(templateType: string, tradeId: string): string {
  const typeCode = templateType.substring(0, 4).padEnd(4, "0");
  const tradeShort = tradeId.replace(/-/g, "").substring(0, 8).toUpperCase();
  const alphanum = Array.from({ length: 6 }, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 36)]
  ).join("");
  return `SFR-${typeCode}-${tradeShort}-${alphanum}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const authErr = validateMcpKey(req);
  if (authErr) return authErr;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { template_type, trade_id, overrides } = await req.json();

  if (!template_type || !trade_id) {
    return json({ error: "template_type and trade_id are required" }, 400);
  }
  if (!VALID_TEMPLATES.includes(template_type.toUpperCase())) {
    return json({ error: `Invalid template_type. Must be one of: ${VALID_TEMPLATES.join(", ")}` }, 400);
  }

  // Fetch trade with related data for token filling
  const { data: trade, error: tErr } = await supabase
    .from("trades")
    .select(`
      id, product_name, product_category, cif_value_usd, quantity_mt,
      loading_port, discharge_port, incoterm, status,
      buyer:profiles!trades_buyer_id_fkey(id, name, company, country, email),
      agent:profiles!trades_agent_id_fkey(id, name, company)
    `)
    .eq("id", trade_id)
    .single();

  if (tErr || !trade) return json({ error: "Trade not found" }, 404);

  const sfrCode   = generateSfrCode(template_type.toUpperCase(), trade_id);
  const issuedAt  = new Date().toISOString();

  // Build document token map
  const tokens: Record<string, unknown> = {
    document_ref:      sfrCode,
    issue_date:        new Date().toLocaleDateString("en-GB"),
    trade_id:          trade_id,
    product_name:      trade.product_name,
    product_category:  trade.product_category,
    cif_value_usd:     trade.cif_value_usd,
    quantity_mt:       trade.quantity_mt,
    loading_port:      trade.loading_port,
    discharge_port:    trade.discharge_port,
    incoterm:          trade.incoterm ?? "CIF",
    buyer_name:        (trade.buyer as Record<string, string>)?.name,
    buyer_company:     (trade.buyer as Record<string, string>)?.company,
    buyer_country:     (trade.buyer as Record<string, string>)?.country,
    agent_name:        (trade.agent as Record<string, string>)?.name,
    agent_company:     (trade.agent as Record<string, string>)?.company,
    seller_name:       "SFERA LLC (ООО «СФЕРА»)",
    seller_inn:        "9715479324",
    seller_ogrn:       "1247700281685",
    seller_address:    "127081, Moscow, Russian Federation, Dezhnev Passage 1/2-1",
    seller_director:   "Zhang Qingshui",
    seller_email:      "sales@sfera-rusexport.ru",
    verify_url:        `https://sfera-rusexport.ru/verify?code=${sfrCode}`,
    ...overrides,
  };

  // Save document record
  const { data: docRecord, error: dErr } = await supabase
    .from("trade_documents")
    .insert({
      trade_id,
      document_type: template_type.toUpperCase(),
      sfr_code:      sfrCode,
      tokens:        tokens,
      status:        "issued",
      issued_at:     issuedAt,
      signatory:     "Zhang Qingshui, Director, SFERA LLC",
    })
    .select("id, sfr_code, issued_at")
    .single();

  if (dErr) return json({ error: dErr.message }, 500);

  // Add to trade timeline
  await supabase.from("trade_timeline").insert({
    trade_id,
    stage:      `document_generated`,
    note:       `${template_type} issued — ${sfrCode}`,
    completed_at: issuedAt,
  });

  return json({
    success:       true,
    sfr_code:      sfrCode,
    document_type: template_type.toUpperCase(),
    trade_id,
    issued_at:     issuedAt,
    document_id:   docRecord?.id,
    signatory:     "Zhang Qingshui, Director, SFERA LLC",
    verify_url:    tokens.verify_url,
    tokens_applied: Object.keys(tokens).length,
    message:       `${template_type} document generated. SFR code: ${sfrCode}. Verify at ${tokens.verify_url}`,
  });
});
