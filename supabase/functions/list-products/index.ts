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

  const { category, target_market, search } = await req.json().catch(() => ({}));

  let q = supabase
    .from("products")
    .select("*")
    .eq("active", true)
    .order("category")
    .order("name");

  if (category)      q = q.eq("category", category);
  if (target_market) q = q.contains("target_markets", [target_market]);
  if (search)        q = q.or(`name.ilike.%${search}%,hs_code.ilike.%${search}%`);

  const { data: products, error } = await q;
  if (error) return json({ error: error.message }, 500);

  return json({
    total: products?.length ?? 0,
    products: products?.map((p: Record<string, unknown>) => ({
      id:                  p.id,
      name:                p.name,
      category:            p.category,
      hs_code:             p.hs_code,
      standard:            p.standard,
      moq_mt:              p.moq_mt,
      specifications:      p.specifications,
      target_markets:      p.target_markets,
      featured:            p.featured,
    })),
  });
});
