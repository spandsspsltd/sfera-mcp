import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateMcpKey, corsHeaders, json } from "../_shared/auth.ts";

// CIF 13-stage document requirements
const STAGE_REQUIREMENTS: Record<string, { stage: number; docs: string[] }> = {
  pending:         { stage: 1,  docs: ["LOI","ICPO"] },
  kyc_pending:     { stage: 2,  docs: ["KYC_PASSPORT","KYC_COMPANY_REG","KYC_POA","KYC_DIRECTOR_ID","KYC_BANK_REF"] },
  fco_issued:      { stage: 3,  docs: ["FCO","SPA"] },
  spa_signed:      { stage: 4,  docs: ["IMFPA"] },
  tariff_invoiced: { stage: 6,  docs: ["TARIFF_INVOICE"] },
  tariff_paid:     { stage: 7,  docs: ["APG_REQUEST","APG"] },
  sgs_inspection:  { stage: 9,  docs: ["SGS_CERTIFICATE"] },
  loading:         { stage: 10, docs: ["BILL_OF_LADING","PACKING_LIST"] },
  in_transit:      { stage: 11, docs: [] },
  arrived:         { stage: 12, docs: ["ARRIVAL_NOTICE"] },
  completed:       { stage: 13, docs: ["FINAL_SETTLEMENT","ORIGINAL_BL","COMMERCIAL_INVOICE","CERT_OF_ORIGIN"] },
};

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

  const { data: trade } = await supabase
    .from("trades")
    .select("id, status, product_name, buyer:profiles!trades_buyer_id_fkey(name, company)")
    .eq("id", trade_id)
    .single();

  if (!trade) return json({ error: "Trade not found" }, 404);

  const { data: docs } = await supabase
    .from("trade_documents")
    .select("document_type, sfr_code, issued_at, status, signatory")
    .eq("trade_id", trade_id)
    .order("issued_at");

  const issuedTypes = new Set((docs ?? []).map((d: Record<string, string>) => d.document_type));

  // Build full document checklist
  const checklist = Object.entries(STAGE_REQUIREMENTS).map(([statusKey, req]) => {
    const required = req.docs;
    const stageIssued   = required.filter((d) => issuedTypes.has(d));
    const stageMissing  = required.filter((d) => !issuedTypes.has(d));
    const isCurrentStage = trade.status === statusKey;

    return {
      stage_number:    req.stage,
      stage_name:      statusKey.replace(/_/g, " "),
      is_current_stage: isCurrentStage,
      required_docs:   required,
      issued_docs:     stageIssued,
      missing_docs:    stageMissing,
      stage_complete:  stageMissing.length === 0 || required.length === 0,
      is_gate_blocker: isCurrentStage && stageMissing.length > 0,
    };
  });

  const blockers = checklist.filter((s) => s.is_gate_blocker);
  const totalIssued  = (docs ?? []).length;
  const allDocuments = (docs ?? []).map((d: Record<string, unknown>) => ({
    type:      d.document_type,
    sfr_code:  d.sfr_code,
    issued_at: d.issued_at,
    status:    d.status,
    signatory: d.signatory,
  }));

  return json({
    trade_id,
    trade_status:    trade.status,
    product:         trade.product_name,
    buyer:           trade.buyer,
    documents_issued: totalIssued,
    gate_blockers:   blockers.length,
    gate_blocker_docs: blockers.flatMap((b) => b.missing_docs),
    checklist,
    all_issued_documents: allDocuments,
    can_advance: blockers.length === 0,
  });
});
