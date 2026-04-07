#!/usr/bin/env node
import 'dotenv/config';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import http from "http";

const SUPABASE_URL = process.env.SUPABASE_URL        ?? "";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const MCP_API_KEY  = process.env.MCP_API_KEY         ?? "";
const PORT         = parseInt(process.env.PORT        ?? "3000", 10);

// Debug: log what we found
process.stderr.write(`[ENV] SUPABASE_URL: ${SUPABASE_URL ? "✓ set" : "✗ missing"}\n`);
process.stderr.write(`[ENV] SUPABASE_SERVICE_KEY: ${SERVICE_KEY ? "✓ set" : "✗ missing"}\n`);
process.stderr.write(`[ENV] MCP_API_KEY: ${MCP_API_KEY ? "✓ set" : "✗ missing"}\n`);
process.stderr.write(`[ENV] PORT: ${PORT}\n`);

if (!SUPABASE_URL || !SERVICE_KEY || !MCP_API_KEY) {
  process.stderr.write("FATAL: SUPABASE_URL, SUPABASE_SERVICE_KEY and MCP_API_KEY required\n");
  process.stderr.write(`[DEBUG] Available keys: ${Object.keys(process.env).filter(k => k.includes('SUPABASE') || k.includes('MCP')).join(', ')}\n`);
  process.exit(1);
}

async function callEdge(fn: string, params: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Edge '${fn}' ${res.status}: ${await res.text()}`);
  return res.json();
}

const ok   = (d: unknown) => ({ content: [{ type: "text" as const, text: typeof d === "string" ? d : JSON.stringify(d, null, 2) }] });
const fail = (m: string)  => ({ content: [{ type: "text" as const, text: `ERROR: ${m}` }], isError: true as const });

const TOOLS = [
  {
    name: "search_trades",
    description: "Search the SFERA trade pipeline. All filters optional — omit all args to see full pipeline.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["pending","kyc_pending","fco_issued","spa_signed","tariff_invoiced","tariff_paid","apg_active","sgs_inspection","loading","in_transit","arrived","completed","cancelled"] },
        buyer_id: { type: "string" }, agent_id: { type: "string" },
        product_category: { type: "string", enum: ["fertilizers","petroleum_gas","metals","chemicals","biomaterials","agro"] },
        date_from: { type: "string" }, date_to: { type: "string" }, limit: { type: "number" },
      }, required: [],
    },
  },
  {
    name: "get_trade_apg_status",
    description: "Get APG and tariff payment details for a trade — issue date, bank, CCI arbitration ref, expiry.",
    inputSchema: { type: "object" as const, properties: { trade_id: { type: "string" } }, required: ["trade_id"] },
  },
  {
    name: "list_pending_buyer_kyc",
    description: "List buyers waiting for KYC approval — docs submitted, docs missing, days waiting.",
    inputSchema: { type: "object" as const, properties: { country: { type: "string" }, days_waiting: { type: "number" } }, required: [] },
  },
  {
    name: "verify_document",
    description: "Verify a SFERA document by SFR code (SFR-[TYPE]-[TRADEID]-[6ALPHANUM]). Returns VALID / INVALID / REVOKED.",
    inputSchema: { type: "object" as const, properties: { sfr_code: { type: "string" } }, required: ["sfr_code"] },
  },
  {
    name: "get_agent_commission_status",
    description: "Get IMFPA commission status for an agent — rate, amount, status, expected payment date.",
    inputSchema: {
      type: "object" as const,
      properties: { agent_id: { type: "string" }, status: { type: "string", enum: ["pending","protected","payable","paid"] } },
      required: ["agent_id"],
    },
  },
  {
    name: "list_products",
    description: "List SFERA product catalogue — HS codes, MOQs, GOST standards, specs, target markets.",
    inputSchema: {
      type: "object" as const,
      properties: { category: { type: "string" }, target_market: { type: "string" }, search: { type: "string" } },
      required: [],
    },
  },
  {
    name: "approve_buyer",
    description: "WRITE — Approve buyer KYC, advance to active, trigger SPA issuance workflow.",
    inputSchema: { type: "object" as const, properties: { buyer_id: { type: "string" }, notes: { type: "string" } }, required: ["buyer_id"] },
  },
  {
    name: "generate_sfr_document",
    description: "WRITE — Generate FCO, SPA, SCO, ICPO, IMFPA, APG_REQUEST or INVOICE. Returns SFR code and verify URL.",
    inputSchema: {
      type: "object" as const,
      properties: {
        template_type: { type: "string", enum: ["FCO","SPA","SCO","ICPO","IMFPA","APG_REQUEST","INVOICE"] },
        trade_id: { type: "string" },
        overrides: { type: "object", additionalProperties: true },
      },
      required: ["template_type","trade_id"],
    },
  },
  {
    name: "get_trade_document_set",
    description: "Full 13-stage document checklist — issued docs with SFR codes, missing docs, stage-gate blockers.",
    inputSchema: { type: "object" as const, properties: { trade_id: { type: "string" } }, required: ["trade_id"] },
  },
  {
    name: "get_enquiry_queue",
    description: "Get LOI/RFQ submissions from the contact form — company, country, product, quantity, discharge port.",
    inputSchema: {
      type: "object" as const,
      properties: { type: { type: "string" }, product_category: { type: "string" }, country: { type: "string" }, unread_only: { type: "boolean" }, limit: { type: "number" } },
      required: [],
    },
  },
];


async function dispatch(name: string, args: Record<string, unknown>) {
  try {
    switch (name) {
      case "search_trades":               return ok(await callEdge("search-trades",          args));
      case "get_trade_apg_status":        z.object({ trade_id: z.string().uuid() }).parse(args);          return ok(await callEdge("get-trade-apg",          args));
      case "list_pending_buyer_kyc":      return ok(await callEdge("list-pending-kyc",       args));
      case "verify_document":             z.object({ sfr_code: z.string().min(5) }).parse(args);           return ok(await callEdge("verify-document",         args));
      case "get_agent_commission_status": z.object({ agent_id: z.string().uuid() }).parse(args);          return ok(await callEdge("get-agent-commissions",    args));
      case "list_products":               return ok(await callEdge("list-products",           args));
      case "approve_buyer":               z.object({ buyer_id: z.string().uuid() }).parse(args);          return ok(await callEdge("approve-buyer",            args));
      case "generate_sfr_document":       z.object({ template_type: z.string(), trade_id: z.string().uuid() }).parse(args); return ok(await callEdge("generate-document", args));
      case "get_trade_document_set":      z.object({ trade_id: z.string().uuid() }).parse(args);          return ok(await callEdge("get-trade-documents",      args));
      case "get_enquiry_queue":           return ok(await callEdge("get-enquiry-queue",       args));
      default:                            return fail(`Unknown tool: ${name}`);
    }
  } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
}


function makeServer() {
  const s = new Server({ name: "sfera-trade-portal", version: "1.1.0" }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  s.setRequestHandler(CallToolRequestSchema,  async (req) => dispatch(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>));
  return s;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data",  (c) => chunks.push(c));
    req.on("end",   () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "sfera-mcp", version: "1.1.0" }));
    return;
  }

  const parts = new URL(req.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean);
  if (parts[0] !== "mcp" || parts[1] !== MCP_API_KEY) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorised" }));
    return;
  }

  try {
    const server    = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
    await server.close();
  } catch (e) {
    if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
  }

}).listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`SFERA MCP v1.1.0 — port ${PORT}\n`);
  process.stderr.write(`Connector URL: https://mcp.sfera-rusexport.ru/mcp/${MCP_API_KEY.slice(0,8)}...\n`);
});
