# openclaw-bahn-mcp

Kleiner MCP-Server (stdio, ohne Abhängigkeiten) für Zugauskünfte in Deutschland:
Verbindungen, Abfahrtstafeln und Zugverläufe mit Echtzeit, Gleisen und Ausfällen.
Gebaut für einen privaten [OpenClaw](https://github.com/openclaw/openclaw)-Familienassistenten.

## Datenquelle

Alle Daten kommen von **[Transitous](https://transitous.org)**, einer community-betriebenen,
offenen ÖPNV-Auskunft auf Basis von [MOTIS 2](https://github.com/motis-project/motis).
Für Deutschland stammen Fahrplan und Echtzeit aus den offenen DELFI-Daten (GTFS / GTFS-RT).

- Datenquellen und Lizenzen: <https://transitous.org/sources/>
- Ortssuche: © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende
- Nutzungsregeln der API: <https://transitous.org/api/>

Jede Anfrage geht frisch an die API (kein Cache). Jede Anfrage sendet den User-Agent
`openclaw-bahn-mcp/<version> (+https://github.com/biacz/openclaw-bahn-mcp)`.
Die Antworten weisen das Modell an, die Quelle `transitous.org/sources` zu nennen.

## Tools

| Tool | Zweck |
|---|---|
| `bahn_bahnhof_suchen` | Bahnhof/Haltestelle suchen, liefert IDs |
| `bahn_verbindungen` | Verbindungen A → B (Abfahrt oder Ankunft, nur Nahverkehr, max. Umstiege; Fernbusse nur mit `auchFernbus`) |
| `bahn_abfahrten` | Abfahrts- oder Ankunftstafel, Standard nur Züge |
| `bahn_zugverlauf` | alle Halte eines Zuges (tripId aus den anderen Tools) |

Zeiten ohne Offset werden als deutsche Ortszeit gelesen (`2026-09-27T18:00`).

## Nutzung

Node.js ≥ 18, keine Installation nötig.

```sh
node db-mcp.mjs                                  # MCP-Server auf stdio
node db-mcp.mjs --test "Köln Hbf" "Bonn Hbf"     # Verbindungen testen
node db-mcp.mjs --abfahrten "Frankfurt (Main) Hbf"       # Abfahrtstafel testen
```

OpenClaw (`openclaw.json`):

```json
"mcp": { "servers": { "db": { "command": "node", "args": ["/opt/mcp/db/db-mcp.mjs"], "requestTimeoutMs": 30000 } } }
```

Optional: `TRANSITOUS_URL` setzt eine andere MOTIS-Instanz.

## Hinweise

- Die Echtzeitdaten aus DELFI sind teils weniger vollständig als die der DB-Navigator-App.
  `echtzeit: false` an einem Zug heißt: nur Fahrplan, keine Live-Daten.
- Nicht-kommerzielles Hobbyprojekt, ohne Gewähr.

## Lizenz

MIT
