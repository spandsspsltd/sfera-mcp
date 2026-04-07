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

  const {
    type,
    product_category,
    country,
    unread_only = false,
    limit = 20,
  } = await req.json().catch(() => ({}));

  let q = supabase
    .from("enquiries")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(Number(limit), 100));

  if (type)             q = q.eq("enquiry_type", type);
  if (product_category) q = q.eq("product_category", product_category);
  if (country)          q = q.ilike("country", `%${country}%`);
  if (unread_only)      q = q.eq("actioned", false);

  const { data: enquiries, error } = await q;
  if (error) return json({ error: error.message }, 500);

  // Counts by type
  const byType = (enquiries ?? []).reduce((acc: Record<string, number>, e: Record<string, string>) => {
    acc[e.enquiry_type] = (acc[e.enquiry_type] ?? 0) + 1;
    return acc;
  }, {});

  const byCountry = (enquiries ?? []).reduce((acc: Record<string, number>, e: Record<string, string>) => {
    acc[e.country] = (acc[e.country] ?? 0) + 1;
    return acc;
  }, {});

  return json({
    total:            enquiries?.length ?? 0,
    unread:           (enquiries ?? []).filter((e: Record<string, boolean>) => !e.actioned).length,
    breakdown_by_type:    byType,
    breakdown_by_country: byCountry,
    enquiries: (enquiries ?? []).map((e: Record<string, unknown>) => ({
      id:               e.id,
      type:             e.enquiry_type,
      company:          e.company_name,
      contact:          e.contact_person,
      email:            e.email,
      country:          e.country,
      product_category: e.product_category,
      specific_product: e.specific_product,
      quantity_mt:      e.quantity_mt,
      discharge_port:   e.discharge_port,
      delivery_term:    e.preferred_delivery_term,
      notes:            e.additional_notes,
      actioned:         e.actioned,
      submitted_at:     e.created_at,
    })),
  });
});
