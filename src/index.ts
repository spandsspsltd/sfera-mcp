#!/usr/bin/env node
/**
 * SFERA LLC Trade Portal — MCP Server
 * Document: SFERA-MCP-SRV-2026-001
 *
 * Connects Claude.ai to the SFERA Supabase backend via 10 authenticated tools.
 * Deploy on Render or Railway. Register as Claude custom connector.
 *
 * Required environment variables:
 *   SUPABASE_URL          — https://iclairkjhebamzjtzncq.supabase.co
 *   SUPABASE_SERVICE_KEY  — Supabase service_role key (bypasses RLS — NEVER expose client-side)
 *   MCP_API_KEY                  — Shared secret between Claude connector and this server
 *   SUPABASE_SERVICE_ROLE_KEY    — Alias for service_role key if preferred
 */

import { createServer } from 'http';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
  ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_KEY
  ?? process.env.SUPABASE_SERVICE_ROLE
  ?? "";
const MCP_API_KEY = process.env.MCP_API_KEY ?? process.env.MCP_KEY ?? "";

process.stderr.write(
  `ENV DEBUG: PORT=${process.env.PORT ?? "<unset>"}, ` +
  `SUPABASE_URL=${Boolean(process.env.SUPABASE_URL)}, ` +
  `SUPABASE_SERVICE_KEY=${Boolean(process.env.SUPABASE_SERVICE_KEY)}, ` +
  `SUPABASE_SERVICE_ROLE_KEY=${Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)}, ` +
  `SUPABASE_KEY=${Boolean(process.env.SUPABASE_KEY)}, ` +
  `SUPABASE_SERVICE_ROLE=${Boolean(process.env.SUPABASE_SERVICE_ROLE)}, ` +
  `MCP_API_KEY=${Boolean(process.env.MCP_API_KEY)}, ` +
  `MCP_KEY=${Boolean(process.env.MCP_KEY)}\n`
);

if (!SUPABASE_URL || !SERVICE_KEY) {
  process.stderr.write(
    "FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) must be set\n"
  );
  process.exit(1);
}

// ─── SUPABASE EDGE CALLER ────────────────────────────────────────────────────

async function callEdge(fn: string, params: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "x-mcp-key":     MCP_API_KEY,
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Edge '${fn}' error ${res.status}: ${body}`);
  }
  return res.json();
}

// ─── RESPONSE HELPERS ────────────────────────────────────────────────────────

const ok  = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

const fail = (msg: string): CallToolResult => ({
  content: [{ type: "text", text: `ERROR: ${msg}` }],
  isError: true,
});

// ─── TOOL REGISTRY ───────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "search_trades",
    description:
      "Search the SFERA trade pipeline. Returns trade ID, buyer, agent, product, CIF value, " +
      "current stage (1–13 of the CIF procedure), APG status, document completeness, and timestamps. " +
      "All filters are optional — call with no arguments to see the full pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending","kyc_pending","fco_issued","spa_signed","tariff_invoiced",
                 "tariff_paid","apg_active","sgs_inspection","loading","in_transit",
                 "arrived","completed","cancelled"],
          description: "Filter by trade stage status",
        },
        buyer_id:         { type: "string", description: "Filter by buyer UUID" },
        agent_id:         { type: "string", description: "Filter by agent UUID" },
        product_category: {
          type: "string",
          enum: ["fertilizers","petroleum_gas","metals","chemicals","biomaterials","agro"],
          description: "Filter by product category",
        },
        date_from:  { type: "string", description: "ISO date — trades created on or after" },
        date_to:    { type: "string", description: "ISO date — trades created on or before" },
        limit:      { type: "number", description: "Max results (default 20, max 100)" },
      },
      required: [],
    },
  },

  {
    name: "get_trade_apg_status",
    description:
      "Get full APG (Advance Payment Guarantee) and tariff payment details for a trade. " +
      "Returns tariff invoice amount, payment date, APG issue date, expiry, issuing bank, " +
      "CCI arbitration reference, and current APG validity.",
    inputSchema: {
      type: "object",
      properties: {
        trade_id: { type: "string", description: "UUID of the trade" },
      },
      required: ["trade_id"],
    },
  },

  {
    name: "list_pending_buyer_kyc",
    description:
      "List buyers awaiting KYC verification (stage 2 of the CIF procedure). " +
      "Returns buyer name, company, country, submission date, documents submitted, and missing documents.",
    inputSchema: {
      type: "object",
      properties: {
        country:      { type: "string", description: "Filter by country name" },
        days_waiting: { type: "number", description: "Only buyers waiting longer than N days" },
      },
      required: [],
    },
  },

  {
    name: "verify_document",
    description:
      "Verify a SFERA trade document by its SFR code (format: SFR-[TYPE]-[TRADEID]-[6ALPHANUM]). " +
      "Returns document type, trade reference, issue date, signatory, and VALID / INVALID / REVOKED status.",
    inputSchema: {
      type: "object",
      properties: {
        sfr_code: { type: "string", description: "e.g. SFR-SPA1-TR001-A7X3K9" },
      },
      required: ["sfr_code"],
    },
  },

  {
    name: "get_agent_commission_status",
    description:
      "Get IMFPA-protected commission status for an agent. " +
      "Returns each trade, commission rate, amount, status (pending/protected/payable/paid), " +
      "expected payment date, and IMFPA reference.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "UUID of the agent" },
        status: {
          type: "string",
          enum: ["pending","protected","payable","paid"],
          description: "Filter by commission status",
        },
      },
      required: ["agent_id"],
    },
  },

  {
    name: "list_products",
    description:
      "List SFERA product catalogue with specs, HS codes, MOQs, standards, and target markets. " +
      "Use when building an FCO or responding to an RFQ.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["fertilizers","petroleum_gas","metals","chemicals","biomaterials"],
        },
        target_market: {
          type: "string",
          enum: ["africa","south_america","asia","middle_east","europe"],
        },
        search: { type: "string", description: "Search by product name or HS code" },
      },
      required: [],
    },
  },

  {
    name: "approve_buyer",
    description:
      "WRITE — Approve a buyer's KYC. Advances status from kyc_pending to active " +
      "and triggers the SPA issuance workflow (stage 3 of the CIF procedure).",
    inputSchema: {
      type: "object",
      properties: {
        buyer_id: { type: "string", description: "UUID of the buyer to approve" },
        notes:    { type: "string", description: "Optional admin notes on the approval" },
      },
      required: ["buyer_id"],
    },
  },

  {
    name: "generate_sfr_document",
    description:
      "WRITE — Generate a SFERA trade document from template with auto-filled tokens. " +
      "Templates: FCO, SPA, SCO, ICPO, IMFPA, APG_REQUEST, INVOICE. " +
      "Returns SFR verification code and document download URL.",
    inputSchema: {
      type: "object",
      properties: {
        template_type: {
          type: "string",
          enum: ["FCO","SPA","SCO","ICPO","IMFPA","APG_REQUEST","INVOICE"],
        },
        trade_id:  { type: "string", description: "UUID of the trade" },
        overrides: {
          type: "object",
          description: "Optional field overrides e.g. { quantity_mt: 500, discharge_port: 'Port of Lagos, Nigeria' }",
          additionalProperties: true,
        },
      },
      required: ["template_type","trade_id"],
    },
  },

  {
    name: "get_trade_document_set",
    description:
      "Get the complete document checklist for a trade across all 13 CIF stages. " +
      "Shows issued documents (with SFR code), pending, missing, and stage-gate blockers.",
    inputSchema: {
      type: "object",
      properties: {
        trade_id: { type: "string", description: "UUID of the trade" },
      },
      required: ["trade_id"],
    },
  },

  {
    name: "get_enquiry_queue",
    description:
      "Get LOI and RFQ submissions from the public contact form. " +
      "Returns enquiry type, company, country, product interest, quantity, discharge port, and date. " +
      "Filter by type, product category, or country.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["LOI","RFQ","AGENT_APPLICATION","TIER1_REQUEST","TIER2_REQUEST","GENERAL"],
        },
        product_category: {
          type: "string",
          enum: ["fertilizers","petroleum_gas","metals","chemicals","biomaterials"],
        },
        country:     { type: "string", description: "Filter by buyer country" },
        unread_only: { type: "boolean", description: "Only unactioned enquiries" },
        limit:       { type: "number", description: "Max results (default 20)" },
      },
      required: [],
    },
  },
];

// ─── TOOL HANDLERS ────────────────────────────────────────────────────────────

async function dispatch(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    switch (name) {
      case "search_trades":
        return ok(await callEdge("search-trades", args));

      case "get_trade_apg_status":
        z.object({ trade_id: z.string().uuid("trade_id must be a valid UUID") }).parse(args);
        return ok(await callEdge("get-trade-apg", args));

      case "list_pending_buyer_kyc":
        return ok(await callEdge("list-pending-kyc", args));

      case "verify_document":
        z.object({ sfr_code: z.string().min(10, "sfr_code too short") }).parse(args);
        return ok(await callEdge("verify-document", args));

      case "get_agent_commission_status":
        z.object({ agent_id: z.string().uuid("agent_id must be a valid UUID") }).parse(args);
        return ok(await callEdge("get-agent-commissions", args));

      case "list_products":
        return ok(await callEdge("list-products", args));

      case "approve_buyer":
        z.object({ buyer_id: z.string().uuid("buyer_id must be a valid UUID") }).parse(args);
        return ok(await callEdge("approve-buyer", args));

      case "generate_sfr_document":
        z.object({
          template_type: z.string(),
          trade_id: z.string().uuid("trade_id must be a valid UUID"),
        }).parse(args);
        return ok(await callEdge("generate-document", args));

      case "get_trade_document_set":
        z.object({ trade_id: z.string().uuid("trade_id must be a valid UUID") }).parse(args);
        return ok(await callEdge("get-trade-documents", args));

      case "get_enquiry_queue":
        return ok(await callEdge("get-enquiry-queue", args));

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ─── SERVER ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000');

const server = new Server(
  { name: "sfera-trade-portal", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
  const { name, arguments: args } = req.params;
  return dispatch(name, (args ?? {}) as Record<string, unknown>);
});

const httpServer = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/mcp') {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);

    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const parsedBody = JSON.parse(body);
        await transport.handleRequest(req, res, parsedBody);
      } catch (e) {
        console.error('Error handling request:', e);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('Internal server error');
        }
      }
    });
  } else {
    res.statusCode = 404;
    res.end('Not found');
  }
});

httpServer.listen(PORT, () => {
  process.stderr.write(`SFERA MCP Server v1.0.0 — running on port ${PORT}\n`);
});
