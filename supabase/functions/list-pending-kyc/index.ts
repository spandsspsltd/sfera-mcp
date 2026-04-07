import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateMcpKey, corsHeaders, json } from "../_shared/auth.ts";

const REQUIRED_DOCS = [
  "passport_national_id",
  "company_registration",
  "proof_of_address",
  "director_id",
  "bank_reference_letter",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const authErr = validateMcpKey(req);
  if (authErr) return authErr;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { country, days_waiting } = await req.json().catch(() => ({}));

  let q = supabase
    .from("profiles")
    .select("id, name, company, country, email, created_at")
    .eq("role", "buyer");

  // Query user_roles for kyc_pending status
  const { data: pendingRoles } = await supabase
    .from("user_roles")
    .select("user_id")
    .eq("role", "buyer")
    .eq("kyc_status", "pending");

  const pendingIds = (pendingRoles ?? []).map((r: Record<string, string>) => r.user_id);
  if (pendingIds.length === 0) return json({ total: 0, buyers: [] });

  q = q.in("id", pendingIds);
  if (country) q = q.ilike("country", `%${country}%`);

  const { data: buyers, error } = await q.order("created_at");
  if (error) return json({ error: error.message }, 500);

  const now = new Date();
  const enriched = await Promise.all(
    (buyers ?? []).map(async (b: Record<string, unknown>) => {
      const { data: docs } = await supabase
        .from("kyc_documents")
        .select("document_type, uploaded_at, status")
        .eq("user_id", b.id);

      const submitted = (docs ?? []).map((d: Record<string, string>) => d.document_type);
      const missing   = REQUIRED_DOCS.filter((d) => !submitted.includes(d));
      const created   = new Date(b.created_at as string);
      const daysWaiting = Math.floor((now.getTime() - created.getTime()) / 86400000);

      return {
        buyer_id:      b.id,
        name:          b.name,
        company:       b.company,
        country:       b.country,
        email:         b.email,
        submitted_at:  b.created_at,
        days_waiting:  daysWaiting,
        docs_submitted: submitted,
        docs_missing:   missing,
        kyc_complete:   missing.length === 0,
      };
    })
  );

  const filtered = days_waiting
    ? enriched.filter((b) => b.days_waiting > Number(days_waiting))
    : enriched;

  return json({ total: filtered.length, buyers: filtered });
});
