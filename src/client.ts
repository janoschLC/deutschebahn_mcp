import { errorFromResponse, ValidationError } from "./errorHandling.js";
import type { StationEntry, StationIndex } from "./stationIndex.js";

export const DEFAULT_API_URL = "https://apis.deutschebahn.com/db-api-marketplace/apis/open-boards/v1";
export const DEFAULT_WINDOW_MINUTES = 60;
export const MAX_WINDOW_MINUTES = 240;
export const DEFAULT_STATION_NAME = "Frankfurt Hbf"; // neutraler Fallback für das öffentliche Repo; echte Nutzer setzen DB_OPENBOARDS_DEFAULT_STATION
export const MAX_ENTRIES_PER_TRANSPORT_TYPE = 50; // von der API erzwungenes Maximum (empirisch geprueft: 80 wird mit 400 abgelehnt)

export interface ClientConfig {
	clientId: string;
	apiKey: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	stationIndex: StationIndex;
	/** Überschreibt den Standardbahnhof (sonst DEFAULT_STATION_NAME = "Frankfurt Hbf"). */
	defaultStation?: string;
}

const EVA_RE = /^\d{6,8}$/;

export type ResolveResult =
	| { kind: "resolved"; station: StationEntry }
	| { kind: "ambiguous"; query: string; options: StationEntry[] }
	| { kind: "not_found"; query: string };

function isLikelyHauptbahnhof(name: string): boolean {
	const n = name.toLowerCase();
	return n.includes("hbf") || n.includes("hauptbahnhof");
}

/** Text in der ersten Klammer (z. B. "Frankfurt (Oder)" -> "oder"), sonst "am main"/"am rhein" u. ä. als Alias, sonst null. */
function qualifierOf(name: string): string | null {
	const bracket = name.match(/\(([^)]+)\)/);
	if (bracket) return bracket[1].trim().toLowerCase();
	const n = name.toLowerCase();
	const amMatch = n.match(/\bam\s+(\w+)/);
	if (amMatch) return amMatch[1];
	return null;
}

/** "Frankfurt-Nied" ist ein Satelliten-Haltepunkt von "Frankfurt" und blockiert eine automatische Hbf-Auswahl nicht. */
function isHyphenSubordinate(name: string, query: string): boolean {
	return name.toLowerCase().startsWith(`${query.toLowerCase()}-`);
}

export async function resolveStationInput(input: string, index: StationIndex): Promise<ResolveResult> {
	const trimmed = input.trim();
	if (EVA_RE.test(trimmed)) {
		const name = await index.nameForEva(trimmed);
		return { kind: "resolved", station: { name: name ?? trimmed, eva: trimmed } };
	}
	if (/^de:\d+:\d+/.test(trimmed) || trimmed.startsWith("dhid:")) {
		return { kind: "resolved", station: { name: trimmed, dhid: trimmed.replace(/^dhid:/, "") } };
	}
	const matches = await index.search(trimmed);
	if (matches.length === 0) return { kind: "not_found", query: trimmed };
	if (matches.length === 1) return { kind: "resolved", station: matches[0] };

	const hbfMatches = matches.filter((m) => isLikelyHauptbahnhof(m.name));
	if (hbfMatches.length === 1) {
		const hbf = hbfMatches[0];
		const hbfQualifier = qualifierOf(hbf.name);
		// Ein anderer Treffer mit abweichendem Klammerzusatz (z. B. "Frankfurt (Oder)" vs. Hbf-Treffer "Frankfurt (Main) Hbf")
		// ist eine komplett andere Stadt, keine Nebenstation desselben Bahnhofs -> dann NICHT automatisch raten.
		const conflicting = matches.filter(
			(m) => m !== hbf && !isHyphenSubordinate(m.name, trimmed) && qualifierOf(m.name) !== hbfQualifier,
		);
		if (conflicting.length === 0) return { kind: "resolved", station: hbf };
	}
	// Für die Anzeige: Satelliten-Haltepunkte (Bindestrich-Namen) ausblenden, die eigentliche Mehrdeutigkeit zeigen.
	const relevant = matches.filter((m) => !isHyphenSubordinate(m.name, trimmed));
	return { kind: "ambiguous", query: trimmed, options: (relevant.length ? relevant : matches).slice(0, 8) };
}

export interface BoardQuery {
	/** Name ODER evaNumber/dhid als String. Default: DEFAULT_STATION_NAME (Frankfurt Hbf). */
	station?: string;
	timeStart?: string;
	windowMinutes?: number;
	/** Filter: Ziel/Richtung, Substring-Match auf den aufgeloesten Stationsnamen (case-insensitive). */
	ziel?: string;
	/** Filter: Zugart. */
	zugart?: "fern" | "regio" | "sbahn";
	/** Filter: Linie/Zugnummer, Substring-Match. */
	linie?: string;
	languages?: string[];
}

export interface BoardEntryCompact {
	zeit: string;
	linie: string;
	ziel: string;
	gleis: string | null;
	gleis_geaendert: boolean;
	verspaetung_min: number;
	ausfall: boolean;
	hinweise: string;
}

export interface BoardResult {
	source: string;
	retrievedAt: string;
	station: StationEntry;
	fenster: { von: string; bis: string };
	eintraege: BoardEntryCompact[];
}

const TYPE_FOR_ZUGART: Record<NonNullable<BoardQuery["zugart"]>, string[]> = {
	fern: ["HIGH_SPEED_TRAIN", "INTERCITY_TRAIN"],
	regio: ["REGIONAL_TRAIN"],
	sbahn: ["CITY_TRAIN", "SUBURBAN_TRAIN"],
};

function minutesBetween(a: string, b: string): number {
	return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 60_000);
}

export function createClient(config: ClientConfig) {
	const baseUrl = config.baseUrl ?? DEFAULT_API_URL;
	const fetchImpl = config.fetchImpl ?? fetch;
	if (!config.clientId || !config.apiKey) {
		throw new ValidationError("clientId und apiKey sind erforderlich (DB_TIMETABLE_CLIENT_ID / DB_TIMETABLE_CLIENT_SECRET).");
	}
	const index = config.stationIndex;
	const defaultStation = config.defaultStation || DEFAULT_STATION_NAME;

	async function rawCall(endpoint: "/departures" | "/arrivals", evaNumbers: string[], timeStart: string, timeEnd: string, languages: string[]) {
		const body = {
			stopPlaceOrStation: { evaNumbers },
			timeWindow: { timeStart, timeEnd },
			maxEntriesPerTransportType: MAX_ENTRIES_PER_TRANSPORT_TYPE,
			languages,
		};
		const res = await fetchImpl(`${baseUrl}${endpoint}`, {
			method: "POST",
			headers: { "DB-Client-Id": config.clientId, "DB-Api-Key": config.apiKey, "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(body),
		});
		const text = await res.text();
		if (!res.ok) throw errorFromResponse(res.status, text);
		try {
			return JSON.parse(text);
		} catch {
			throw new ValidationError("Antwort der DB OpenBoards API war kein gueltiges JSON.");
		}
	}

	async function compact(raw: Record<string, unknown>, key: "departures" | "arrivals", query: BoardQuery): Promise<BoardEntryCompact[]> {
		const list = (raw[key] as Record<string, unknown>[]) ?? [];
		const out: BoardEntryCompact[] = [];
		for (const e of list) {
			const transport = e.transport as Record<string, unknown>;
			const linie = ((transport?.line as Record<string, unknown>)?.name as string) ?? (transport?.journeyDescription as string) ?? "?";
			const type = transport?.type as string;
			if (query.zugart && !TYPE_FOR_ZUGART[query.zugart].includes(type)) continue;
			if (query.linie && !linie.toLowerCase().includes(query.linie.toLowerCase())) continue;

			const journeyInfo = (e.journeyInfo ?? {}) as Record<string, unknown>;
			const destEva = ((key === "departures" ? journeyInfo.destination : journeyInfo.origin) as Record<string, unknown> | undefined)?.evaNumber as
				| string
				| undefined;
			const zielName = destEva ? ((await index.nameForEva(destEva)) ?? destEva) : "?";
			if (query.ziel && !zielName.toLowerCase().includes(query.ziel.toLowerCase())) continue;

			const time = e.time as string | undefined;
			const timeSchedule = e.timeSchedule as string | undefined;
			const platform = e.platform as Record<string, unknown> | undefined;
			const platformSchedule = e.platformSchedule as Record<string, unknown> | undefined;
			const gleis = (platform?.name as string) ?? null;
			const gleisSchedule = (platformSchedule?.name as string) ?? null;
			const verspaetung = time && timeSchedule ? Math.max(0, minutesBetween(time, timeSchedule)) : 0;
			const ausfall = !time && !!timeSchedule; // best effort: keine Echtzeit, obwohl ein Sollwert existiert (kein bestaetigtes Ausfall-Flag in der Doku gefunden)
			const hinweisTeile: string[] = [];
			if ((e.messages as unknown[] | undefined)?.length) hinweisTeile.push(`${(e.messages as unknown[]).length} Hinweis(e)`);
			out.push({
				zeit: time ?? timeSchedule ?? "?",
				linie,
				ziel: zielName,
				gleis,
				gleis_geaendert: !!(gleis && gleisSchedule && gleis !== gleisSchedule),
				verspaetung_min: verspaetung,
				ausfall,
				hinweise: hinweisTeile.join(", "),
			});
		}
		return out;
	}

	async function board(endpoint: "/departures" | "/arrivals", key: "departures" | "arrivals", query: BoardQuery): Promise<BoardResult | ResolveResult> {
		const stationInput = query.station?.trim() || defaultStation;
		const resolved = await resolveStationInput(stationInput, index);
		if (resolved.kind !== "resolved") return resolved;
		if (!resolved.station.eva) {
			throw new ValidationError(`Station '${resolved.station.name}' hat keine bekannte EVA-Nummer in OpenStation - kann nicht abgefragt werden.`);
		}
		const windowMinutes = Math.min(query.windowMinutes ?? DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES);
		if (windowMinutes <= 0) throw new ValidationError("windowMinutes muss groesser als 0 sein.");
		const timeStart = query.timeStart ?? new Date().toISOString();
		const timeEnd = new Date(new Date(timeStart).getTime() + windowMinutes * 60_000).toISOString();
		const raw = await rawCall(endpoint, [resolved.station.eva], timeStart, timeEnd, query.languages ?? ["deu"]);
		const eintraege = await compact(raw, key, query);
		return {
			source: "Daten: DB InfraGO / Deutsche Bahn (OpenBoards API)",
			retrievedAt: new Date().toISOString(),
			station: resolved.station,
			fenster: { von: timeStart, bis: timeEnd },
			eintraege,
		};
	}

	return {
		getDepartureBoard: (query: BoardQuery) => board("/departures", "departures", query),
		getArrivalBoard: (query: BoardQuery) => board("/arrivals", "arrivals", query),
		findStation: (name: string) => resolveStationInput(name, index),
	};
}

export type Client = ReturnType<typeof createClient>;
