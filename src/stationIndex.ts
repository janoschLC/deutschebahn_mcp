import { XMLParser } from "fast-xml-parser";
import * as fs from "node:fs";
import * as path from "node:path";
import { ApiError, errorFromResponse } from "./errorHandling.js";

export const OPENSTATION_DEFAULT_URL = "https://apis.deutschebahn.com/db-api-marketplace/apis/open-station/v1/netex";
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage

export interface StationEntry {
	name: string;
	eva?: string;
	dhid?: string;
	stada?: string;
}

export interface StationIndexConfig {
	clientId: string;
	apiKey: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	cachePath: string;
	/** Für Tests: eigene Uhrzeit statt Date.now() */
	now?: () => number;
	/** Für Tests: eigenes Dateisystem statt node:fs */
	readFile?: (path: string) => string | undefined;
	writeFile?: (path: string, content: string) => void;
	/** Seitengröße beim Abruf; die API lehnt zu große Werte ab (Default-Limit der API ist 100). */
	pageSize?: number;
	/** Harte Obergrenze an Seiten, gegen Endlosschleifen bei einer kaputten API-Antwort. */
	maxPages?: number;
}

interface CacheFile {
	fetchedAt: number;
	stations: StationEntry[];
}

function parseNetexPage(xml: string): StationEntry[] {
	const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", isArray: (name) => name === "StopPlace" || name === "KeyValue" });
	const doc = parser.parse(xml);
	const stopPlaces: unknown[] = [];
	// StopPlace-Elemente können an mehreren Stellen im Dokument liegen (verschachtelte Frames) -> rekursiv einsammeln
	const walk = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (key === "StopPlace") {
				for (const sp of Array.isArray(value) ? value : [value]) stopPlaces.push(sp);
			} else if (typeof value === "object") {
				walk(value);
			}
		}
	};
	walk(doc);

	const entries: StationEntry[] = [];
	for (const sp of stopPlaces as Record<string, unknown>[]) {
		const nameNode = sp.Name as Record<string, unknown> | undefined;
		const name = typeof nameNode === "object" && nameNode ? String((nameNode as Record<string, unknown>)["#text"] ?? "") : typeof nameNode === "string" ? nameNode : undefined;
		if (!name) continue;
		const dhid = typeof sp["@_id"] === "string" && (sp["@_id"] as string).startsWith("dhid:") ? (sp["@_id"] as string).slice("dhid:".length) : (sp["@_id"] as string | undefined);
		let eva: string | undefined;
		const keyList = sp.keyList as Record<string, unknown> | undefined;
		const keyValues = keyList?.KeyValue as Record<string, unknown>[] | undefined;
		if (Array.isArray(keyValues)) {
			for (const kv of keyValues) {
				if (kv.Key === "EVA" && kv.Value) eva = String(kv.Value);
			}
		}
		let stada: string | undefined;
		const privateCodes = sp.privateCodes as Record<string, unknown> | undefined;
		const pc = privateCodes?.PrivateCode;
		for (const p of Array.isArray(pc) ? pc : pc ? [pc] : []) {
			const pr = p as Record<string, unknown>;
			if (typeof pr["@_type"] === "string" && (pr["@_type"] as string).includes("/stada/")) stada = String(pr["#text"] ?? pr);
		}
		entries.push({ name, eva, dhid, stada });
	}
	return entries;
}

async function fetchAllPages(config: StationIndexConfig): Promise<StationEntry[]> {
	const fetchImpl = config.fetchImpl ?? fetch;
	const baseUrl = config.baseUrl ?? OPENSTATION_DEFAULT_URL;
	const pageSize = config.pageSize ?? 100;
	const maxPages = config.maxPages ?? 200;
	const all: StationEntry[] = [];
	for (let page = 1; page <= maxPages; page++) {
		const res = await fetchImpl(`${baseUrl}?page=${page}&limit=${pageSize}`, {
			headers: { "DB-Client-ID": config.clientId, "DB-Api-Key": config.apiKey },
		});
		const text = await res.text();
		if (!res.ok) throw errorFromResponse(res.status, text);
		const pageEntries = parseNetexPage(text);
		if (pageEntries.length === 0) break;
		all.push(...pageEntries);
		const link = res.headers.get("link") ?? "";
		if (!link.includes('rel="next"') || pageEntries.length < pageSize) break;
	}
	return all;
}

function normalizeName(s: string): string {
	return s
		.toLowerCase()
		.replace(/ä/g, "ae")
		.replace(/ö/g, "oe")
		.replace(/ü/g, "ue")
		.replace(/ß/g, "ss")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

export class StationIndex {
	private cache: CacheFile | undefined;
	constructor(private config: StationIndexConfig) {}

	private readCache(): CacheFile | undefined {
		if (this.cache) return this.cache;
		const read = this.config.readFile;
		let raw: string | undefined;
		if (read) {
			raw = read(this.config.cachePath);
		} else {
			try {
				raw = fs.readFileSync(this.config.cachePath, "utf-8");
			} catch {
				raw = undefined;
			}
		}
		if (!raw) return undefined;
		try {
			this.cache = JSON.parse(raw) as CacheFile;
			return this.cache;
		} catch {
			return undefined;
		}
	}

	private writeCache(data: CacheFile) {
		this.cache = data;
		const content = JSON.stringify(data);
		if (this.config.writeFile) {
			this.config.writeFile(this.config.cachePath, content);
			return;
		}
		fs.mkdirSync(path.dirname(this.config.cachePath), { recursive: true });
		fs.writeFileSync(this.config.cachePath, content, "utf-8");
	}

	private now(): number {
		return this.config.now ? this.config.now() : Date.now();
	}

	async ensureFresh(): Promise<StationEntry[]> {
		const existing = this.readCache();
		if (existing && this.now() - existing.fetchedAt < CACHE_TTL_MS) {
			return existing.stations;
		}
		const stations = await fetchAllPages(this.config);
		this.writeCache({ fetchedAt: this.now(), stations });
		return stations;
	}

	/** Liefert Treffer für einen (tippfehler-/umlauttoleranten) Namen, sortiert nach Relevanz. Wirft nie - leeres Array bei 0 Treffern. */
	async search(query: string): Promise<StationEntry[]> {
		const stations = await this.ensureFresh();
		const q = normalizeName(query);
		if (!q) return [];
		const scored = stations
			.map((s) => {
				const n = normalizeName(s.name);
				let score = -1;
				if (n === q) score = 100;
				else if (n.startsWith(q)) score = 80;
				else if (n.includes(q)) score = 60;
				else if (q.split(" ").every((w) => n.includes(w))) score = 40;
				return { s, score };
			})
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length);
		return scored.map((x) => x.s);
	}

	/**
	 * Für die Rückanzeige: EVA-Nummer -> Stationsname (z. B. um Ziel/Herkunft lesbar zu machen).
	 *
	 * DB-Eigenheit (empirisch geprüft): einige große Hauptbahnhöfe (z. B. Hamburg, Frankfurt) haben zwei
	 * gültige EVA-Nummern für dieselbe Station - eine "alte" (Präfix 8000...) und eine "neue" (Präfix 8098...).
	 * OpenStation liefert manchmal die neue, OpenBoards referenziert in journeyInfo.destination/origin manchmal
	 * die alte. Beide Formen werden deshalb als Alias probiert.
	 */
	async nameForEva(eva: string): Promise<string | undefined> {
		const stations = await this.ensureFresh();
		const direct = stations.find((s) => s.eva === eva)?.name;
		if (direct) return direct;
		const alias = eva.startsWith("8098") ? `8000${eva.slice(4)}` : eva.startsWith("8000") ? `8098${eva.slice(4)}` : undefined;
		return alias ? stations.find((s) => s.eva === alias)?.name : undefined;
	}
}

export const _internal = { parseNetexPage, normalizeName, fetchAllPages };
