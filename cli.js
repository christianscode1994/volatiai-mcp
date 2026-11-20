#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = "https://sector-slow.fourieranalys.workers.dev";

const server = new Server(
  { name: "volatiai", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_sectors",
      description:
        "Returns all sector IDs with density classification (slow/fast). Deterministic: same output for same input, no LLM in path. Call this once, then use search_sectors or get_sector.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "search_sectors",
      description:
        "Keyword search over sector IDs. Use when you know the topic (e.g. 'downloads', 'quakes', 'treasuries') but not the exact sector ID. Returns ranked matches with scores. Deterministic keyword matching — no embeddings, no LLM.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to match, e.g. 'npm downloads'" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_sector",
      description:
        "Returns the latest deterministic snapshot for one sector: has_signal, severity, confidence, delta. No LLM in path — output is byte-identical for identical inputs. Get the sector ID from list_sectors or search_sectors first.",
      inputSchema: {
        type: "object",
        properties: { sector: { type: "string", description: "Exact sector ID, e.g. npm-react-weekly-downloads" } },
        required: ["sector"],
      },
    },
    {
      name: "get_latest",
      description:
        "Returns the latest published snapshot across all sectors. Deterministic, no LLM in path.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_status",
      description:
        "Returns worker health status and last publish hash. Deterministic, no LLM in path.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function tokenize(s) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function scoreSector(sector, queryTokens) {
  const sectorLower = sector.toLowerCase();
  const sectorTokens = tokenize(sector);
  let score = 0;
  for (const qt of queryTokens) {
    if (sectorLower.includes(qt)) score += 3;
    if (sectorTokens.some((st) => st.startsWith(qt))) score += 2;
    if (sectorTokens.some((st) => st.includes(qt))) score += 1;
  }
  return score;
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "list_sectors") {
      const { json } = await fetchJson("/");
      return { content: [{ type: "text", text: JSON.stringify(json.sectors ?? json, null, 2) }] };
    }

    if (name === "search_sectors") {
      const queryTokens = tokenize(args?.query ?? "");
      if (queryTokens.length === 0) {
        return { content: [{ type: "text", text: "Empty query." }], isError: true };
      }
      const limit = Math.min(Math.max(args?.limit ?? 10, 1), 50);
      const { json } = await fetchJson("/");
      const sectors = json.sectors ?? [];
      const ranked = sectors
        .map((s) => ({ sector: s, score: scoreSector(s, queryTokens) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return { content: [{ type: "text", text: JSON.stringify(ranked, null, 2) }] };
    }

    if (name === "get_sector") {
      const sector = args?.sector ?? "";
      if (!sector) return { content: [{ type: "text", text: "Missing 'sector' argument." }], isError: true };
      const { json } = await fetchJson(`/${encodeURIComponent(sector)}`);
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    }

    if (name === "get_latest") {
      const { json } = await fetchJson("/latest");
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    }

    if (name === "get_status") {
      const { json } = await fetchJson("/status");
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    }

    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: `Fetch failed: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
