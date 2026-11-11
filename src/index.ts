#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, DEFAULT_STATION_NAME, DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES } from "./client.js";
import { ApiError } from "./errorHandling.js";
import { StationIndex } from "./stationIndex.js";
import * as path from "node:path";
import * as os from "node:os";

// Generische Namen sind der primäre Weg; DB_TIMETABLE_* bleibt als Alias erhalten,
// damit bestehende Installationen (die den Vorgänger-Namen noch in ihrer Config haben) weiterlaufen.
const clientId = process.env.DB_OPENBOARDS_CLIENT_ID ?? process.env.DB_TIMETABLE_CLIENT_ID ?? "";
const apiKey = process.env.DB_OPENBOARDS_CLIENT_SECRET ?? process.env.DB_TIMETABLE_CLIENT_SECRET ?? "";
const baseUrl = process.env.DB_OPENBOARDS_BASE_URL;
const cachePath =
	process.env.DB_OPENBOARDS_CACHE_PATH ?? path.join(os.homedir(), ".cache", "deutschebahn-mcp", "stations.json");
const defaultStation = process.env.DB_OPENBOARDS_DEFAULT_STATION || undefined;

if (!clientId || !apiKey) {
	console.error(
		"deutschebahn-mcp: DB_OPENBOARDS_CLIENT_ID / DB_OPENBOARDS_CLIENT_SECRET fehlen. " +
			"Zugangsdaten für die DB OpenBoards API unter https://developers.deutschebahn.com beantragen " +
			"(Produkte 'OpenBoards' UND 'OpenStation' abonnieren) und als Umgebungsvariablen setzen.",
	);
	process.exit(1);
}

const stationIndex = new StationIndex({
	clientId,
	apiKey,
	baseUrl: process.env.DB_OPENSTATION_BASE_URL,
	cachePath,
});

const client = createClient({ clientId, apiKey, baseUrl, stationIndex, defaultStation });

const server = new McpServer({ name: "deutschebahn-mcp", version: "1.0.0" });

function errorResult(e: unknown) {
	if (e instanceof ApiError) {
		return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code: e.code, message: e.message } }) }], isError: true };
	}
	const message = e instanceof Error ? e.message : String(e);
	return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "UNKNOWN_ERROR", message } }) }], isError: true };
}

const boardShape = {
	station: z
		.string()
		.optional()
		.describe(`Bahnhofsname (wird automatisch ueber OpenStation aufgeloest, Tippfehler/Umlaute tolerant) ODER EVA-Nummer. Default: '${DEFAULT_STATION_NAME}'.`),
	timeStart: z.string().optional().describe("ISO-8601 Startzeit, Default: jetzt"),
	windowMinutes: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(`Fensterlaenge in Minuten, Default ${DEFAULT_WINDOW_MINUTES}, Maximum ${MAX_WINDOW_MINUTES}`),
	ziel: z.string().optional().describe("Filter: Ziel/Richtung, z. B. the destination city name"),
	zugart: z.enum(["fern", "regio", "sbahn"]).optional().describe("Filter: Zugart (Fernverkehr/Regio/S-Bahn)"),
	linie: z.string().optional().describe("Filter: Linie/Zugnummer, z. B. 'ICE', 'RE5'"),
};

server.registerTool(
	"getDepartureBoard",
	{
		title: "Abfahrtstafel (DB OpenBoards)",
		description:
			"Liefert die Abfahrtstafel einer deutschen Bahnstation (Zeit, Linie, Ziel, Gleis, Verspaetung, Ausfall, Hinweise) ueber die DB OpenBoards API. Bahnhofsname wird automatisch aufgeloest - keine EVA-Nummer noetig. Bei mehreren Treffern (z. B. 'Frankfurt') kommen stattdessen Auswahl-Optionen zurueck.",
		inputSchema: boardShape,
	},
	async (args) => {
		try {
			const result = await client.getDepartureBoard(args);
			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		} catch (e) {
			return errorResult(e);
		}
	},
);

server.registerTool(
	"getArrivalBoard",
	{
		title: "Ankunftstafel (DB OpenBoards)",
		description:
			"Liefert die Ankunftstafel einer deutschen Bahnstation (Zeit, Linie, Herkunft, Gleis, Verspaetung, Ausfall, Hinweise) ueber die DB OpenBoards API. Bahnhofsname wird automatisch aufgeloest - keine EVA-Nummer noetig. Bei mehreren Treffern kommen stattdessen Auswahl-Optionen zurueck.",
		inputSchema: boardShape,
	},
	async (args) => {
		try {
			const result = await client.getArrivalBoard(args);
			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		} catch (e) {
			return errorResult(e);
		}
	},
);

server.registerTool(
	"findStation",
	{
		title: "Bahnhof finden (OpenStation)",
		description:
			"Loest einen Bahnhofsnamen zu seiner Stationskennung auf (ueber die lokal gecachte OpenStation-Liste, tippfehler-/umlauttolerant). Liefert entweder eine eindeutige Station, eine Liste von Optionen bei Mehrdeutigkeit, oder 'nicht gefunden'.",
		inputSchema: { name: z.string().describe("Bahnhofsname, z. B. 'Koeln', 'Frankfurt', 'Tuebingen'") },
	},
	async ({ name }) => {
		try {
			const result = await client.findStation(name);
			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		} catch (e) {
			return errorResult(e);
		}
	},
);

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((e) => {
	console.error("deutschebahn-mcp konnte nicht starten:", e);
	process.exit(1);
});
