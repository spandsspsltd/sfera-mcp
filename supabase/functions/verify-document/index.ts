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

  const { sfr_code } = await req.json();
  if (!sfr_code) return json({ error: "sfr_code required" }, 400);

  const normalized = sfr_code.trim().toUpperCase();

  const { data: doc, error } = await supabase
    .from("trade_documents")
    .select(`
      id, document_type, sfr_code, issued_at, signatory, status,
      trade:trades(id, product_name, buyer:profiles!trades_buyer_id_fkey(name, company))
    `)
    .eq("sfr_code", normalized)
    .maybeSingle();

  if (error) return json({ error: error.message }, 500);

  if (!doc) {
    return json({
      sfr_code:  normalized,
      status:    "INVALID",
      message:   "No document found with this verification code. This document may be fraudulent.",
      verified:  false,
    });
  }

  return json({
    sfr_code:        doc.sfr_code,
    status:          doc.status?.toUpperCase() ?? "VALID",
    verified:        doc.status !== "revoked",
    document_type:   doc.document_type,
    trade_reference: doc.trade?.id,
    product:         doc.trade?.product_name,
    buyer:           doc.trade?.buyer,
    issued_at:       doc.issued_at,
    signatory:       doc.signatory,
    message:         doc.status === "revoked"
                       ? "This document has been REVOKED. Do not accept."
                       : "Document verified as authentic SFERA LLC trade document.",
  });
});
