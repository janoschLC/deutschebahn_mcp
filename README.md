# deutschebahn_mcp

An MCP (Model Context Protocol) server for the **Deutsche Bahn OpenBoards + OpenStation** APIs.
It lets an LLM agent look up live German train departures/arrivals **by station name** — no
EVA numbers required, typos and umlauts tolerated.

## What it does

- **`getDepartureBoard`** — departure board for a station: time, line, destination, platform,
  delay (minutes), cancellation flag, notice count.
- **`getArrivalBoard`** — same, for arrivals (origin instead of destination).
- **`findStation`** — resolves a station name to its station record (name, EVA, DHID, StaDa).
  Returns a single match, a short list of options if the name is ambiguous (e.g. "Frankfurt" —
  Frankfurt (Main) Hbf vs. Frankfurt (Oder) are different cities), or "not found".

Station names are resolved automatically inside `getDepartureBoard`/`getArrivalBoard` too — you
never need to look up an EVA number yourself. If a name is ambiguous, the tool returns the list
of options instead of guessing, unless there's exactly one obvious main station ("Hbf") among
same-city variants.

Optional filters on the board tools: `ziel` (destination/direction, substring match), `zugart`
(`fern` / `regio` / `sbahn`), `linie` (line/train number, substring match).

Every result carries the source attribution `Daten: DB InfraGO / Deutsche Bahn (OpenBoards API)`.

## Requirements

- Node.js >= 22
- An account at the [DB API Marketplace](https://developers.deutschebahn.com) with an active
  subscription to **both**:
  - **OpenBoards** (departure/arrival boards)
  - **OpenStation** (station directory — needed for name resolution; without it you'd have to
    pass raw EVA numbers)

## Install

```bash
git clone https://github.com/janoschLC/deutschebahn_mcp.git
cd deutschebahn_mcp
npm install
npm run build
```

## Configure

Copy `.env.example` to `.env` and fill in your credentials, or set the environment variables
directly in your MCP client config:

| Variable | Required | Description |
|---|---|---|
| `DB_OPENBOARDS_CLIENT_ID` | yes | DB API Marketplace client ID |
| `DB_OPENBOARDS_CLIENT_SECRET` | yes | DB API Marketplace client secret |
| `DB_OPENBOARDS_BASE_URL` | no | Override the OpenBoards base URL |
| `DB_OPENSTATION_BASE_URL` | no | Override the OpenStation NeTEx endpoint |
| `DB_OPENBOARDS_CACHE_PATH` | no | Where the station-name cache is stored (default: `~/.cache/deutschebahn-mcp/stations.json`) |
| `DB_OPENBOARDS_DEFAULT_STATION` | no | Station used when no `station` argument is given (default: `Frankfurt Hbf`) |

The legacy variable names `DB_TIMETABLE_CLIENT_ID` / `DB_TIMETABLE_CLIENT_SECRET` are still
accepted as a fallback for backward compatibility, but the `DB_OPENBOARDS_*` names above are the
primary ones.

### Add to your MCP client

Example for a generic MCP-compatible client (`mcp_servers`-style config):

```yaml
mcp_servers:
  db_openboards:
    command: node
    args: ["/absolute/path/to/deutschebahn_mcp/dist/index.js"]
    env:
      DB_OPENBOARDS_CLIENT_ID: "your-client-id"
      DB_OPENBOARDS_CLIENT_SECRET: "your-client-secret"
      DB_OPENBOARDS_DEFAULT_STATION: "your-home-station"   # optional, see below
```

> Set `DB_OPENBOARDS_DEFAULT_STATION` to whichever station you personally use most — just be
> aware that your default station lives only in your own private config, not in this repo.
> This project ships with a neutral example (`Frankfurt Hbf`) on purpose.

## How it works

- **Station names → IDs:** on first use, the server downloads the full German station directory
  from OpenStation (NeTEx XML, paginated) and caches it locally for 30 days — this keeps you far
  under the API's daily rate limit. Matching is typo- and umlaut-tolerant (`Koeln` → `Köln`,
  `Tuebingen` → `Tübingen`, no need to type `Hbf`).
- **Ambiguity handling:** if a name matches multiple stations, the server returns the options
  unless exactly one of them is clearly *the* main station of that name (same-city satellite
  stops like `Frankfurt-Nied` or `Frankfurt (Main) Süd` don't block the automatic pick; a
  different city that happens to share the name, like `Frankfurt (Oder)`, does).
- **Known DB quirk:** a handful of large hubs (e.g. Hamburg, Frankfurt) have two valid EVA
  numbers for the same station — OpenStation and OpenBoards don't always agree on which one they
  report. The server tries both automatically when resolving destination/origin names back to
  text.
- **Known limitation:** destinations outside Germany are not in the OpenStation directory, so
  they're shown as a raw EVA number instead of a name.

## Development

```bash
npx tsc --noEmit
npm run build
```

This repository ships without a test suite.

## License

MIT
