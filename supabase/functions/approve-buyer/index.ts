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

  const { buyer_id, notes } = await req.json();
  if (!buyer_id) return json({ error: "buyer_id required" }, 400);

  // Verify buyer exists and is in kyc_pending state
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, name, company, country, email")
    .eq("id", buyer_id)
    .single();

  if (!profile) return json({ error: "Buyer profile not found" }, 404);

  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role, kyc_status")
    .eq("user_id", buyer_id)
    .single();

  if (roleRow?.role !== "buyer") {
    return json({ error: "User is not a buyer" }, 400);
  }
  if (roleRow?.kyc_status === "approved") {
    return json({ error: "Buyer is already approved" }, 400);
  }

  // Update KYC status to approved
  const { error: roleErr } = await supabase
    .from("user_roles")
    .update({ kyc_status: "approved", approved_at: new Date().toISOString() })
    .eq("user_id", buyer_id);

  if (roleErr) return json({ error: roleErr.message }, 500);

  // Log the approval action
  await supabase.from("admin_audit_log").insert({
    action:      "buyer_kyc_approved",
    target_id:   buyer_id,
    target_type: "buyer",
    notes:       notes ?? null,
    performed_by: "mcp_agent",
    performed_at: new Date().toISOString(),
  });

  // Create a notification for the buyer
  await supabase.from("notifications").insert({
    user_id:    buyer_id,
    type:       "kyc_approved",
    title:      "KYC Verification Approved",
    message:    "Your identity verification has been approved. You may now proceed with submitting your LOI.",
    created_at: new Date().toISOString(),
    read:       false,
  });

  return json({
    success:         true,
    buyer_id,
    buyer_name:      profile.name,
    company:         profile.company,
    country:         profile.country,
    email:           profile.email,
    new_status:      "approved",
    approved_at:     new Date().toISOString(),
    notes:           notes ?? null,
    message:         `Buyer ${profile.name} (${profile.company}) KYC approved. SPA issuance workflow triggered.`,
  });
});
