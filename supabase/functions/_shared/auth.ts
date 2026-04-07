// shared/auth.ts — imported by all edge functions
// Validates the x-mcp-key header against the MCP_API_KEY env var

export function validateMcpKey(req: Request): Response | null {
  const key = req.headers.get("x-mcp-key");
  const expected = Deno.env.get("MCP_API_KEY");
  if (!expected) return null; // No key configured — skip check in dev
  if (key !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorised" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-mcp-key",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
