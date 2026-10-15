#!/usr/bin/env node
/**
 * openclaw-bahn-mcp - Bahn-Auskunft als MCP-Server (stdio), ohne Abhaengigkeiten.
 *
 * Datenquelle: Transitous (https://transitous.org), eine community-betriebene,
 * offene OePNV-Auskunft auf Basis von MOTIS 2. Fuer Deutschland stammen
 * Fahrplan und Echtzeit aus den offenen DELFI-Daten (GTFS / GTFS-RT).
 * Quellen und Lizenzen: https://transitous.org/sources/
 * Ortssuche: (c) OpenStreetMap-Mitwirkende, https://www.openstreetmap.org/copyright
 *
 * Jede Anfrage geht frisch an Transitous - kein Cache, kein Fallback.
 * Wenn die API nicht antwortet, kommt ein Fehler zurueck, nie alte Daten.
 *
 * Start als MCP-Server:  node db-mcp.mjs
 * Test als CLI:          node db-mcp.mjs --test "Köln Hbf" "Bonn Hbf"
 *                        node db-mcp.mjs --abfahrten "Frankfurt (Main) Hbf"
 *
 * Umgebung (optional):
 *   TRANSITOUS_URL  Basis-URL der API (Standard https://api.transitous.org)
 */

const VERSION = "2.1.0";
const REPO = "https://github.com/biacz/openclaw-bahn-mcp";
const USER_AGENT = `openclaw-bahn-mcp/${VERSION} (+${REPO})`;
const API = (process.env.TRANSITOUS_URL || "https://api.transitous.org").replace(/\/+$/, "");
const TIMEOUT_MS = 20000;
const TZ = "Europe/Berlin";
const LANG = "de";
const SOURCE = "Transitous (offene Fahrplan- und Echtzeitdaten, transitous.org/sources)";

// Explizit aufzaehlen: "RAIL" ist bei MOTIS ein Sammelbegriff und schliesst U-Bahn/Metro ein.
const RAIL_MODES = ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "REGIONAL_FAST_RAIL", "REGIONAL_RAIL", "SUBURBAN"];
// Standard fuer Verbindungen: Zuege plus Nahverkehr, aber keine Fernbusse (FlixBus, BlaBlaCar = COACH).
const DEFAULT_MODES = [...RAIL_MODES, "SUBWAY", "TRAM", "BUS", "FERRY"];
// Alles ausser Fernverkehr = mit Deutschlandticket nutzbar (Flixtrain laeuft als LONG_DISTANCE).
const LOCAL_MODES = ["REGIONAL_FAST_RAIL", "REGIONAL_RAIL", "SUBURBAN", "SUBWAY", "TRAM", "BUS", "FERRY"];

/* ------------------------------------------------------------- Hilfen */

const fmtTime = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fmtDate = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" });

const hhmm = (iso) => (iso ? fmtTime.format(new Date(iso)) : null);
const day = (iso) => (iso ? fmtDate.format(new Date(iso)) : null);
const now = () => `${day(new Date().toISOString())} ${fmtTime.format(new Date())}`;
const minutesBetween = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null);

/** "2026-09-27T18:00" ohne Offset = deutsche Ortszeit. */
function parseWhen(input) {
  if (!input) return undefined;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(input)) return new Date(input);
  const asUtc = new Date(input + "Z");
  if (Number.isNaN(asUtc.getTime())) throw new Error(`Zeit nicht lesbar: ${input} (Format 2026-09-27T18:00)`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(asUtc).find((p) => p.type === "timeZoneName").value; // GMT+02:00
  const m = parts.match(/GMT([+-])(\d\d):(\d\d)/);
  const offMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(asUtc.getTime() - offMin * 60000);
}

async function api(path, params) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

const looksLikeId = (s) => /^[a-z]{2}-[^\s]+_/i.test(s) || /^[^\s]+:[^\s]+:/.test(s);

/**
 * Reihenfolge der API beibehalten - sie ist bereits nach Relevanz sortiert.
 * Grosse Bahnhoefe (Koeln, Bonn, Berlin Hbf) haben oft IDs aus auslaendischen
 * Datensaetzen (be-sncb_..., at-...); Routing und Abfahrten liefern damit
 * trotzdem alle deutschen Zuege, weil MOTIS die Halte zusammenfuehrt.
 */
async function searchStops(name, n) {
  const res = await api("/api/v1/geocode", { text: name, type: "STOP", language: LANG, numResults: Math.max(n, 5) });
  return res.filter((m) => m.id).slice(0, n);
}

async function resolveStation(input) {
  const s = String(input).trim();
  if (looksLikeId(s)) return { id: s, name: null };
  const [hit] = await searchStops(s, 1);
  if (!hit) throw new Error(`Kein Bahnhof gefunden fuer "${s}"`);
  return { id: hit.id, name: hit.name };
}

function alertTexts(alerts, limit = 5) {
  const seen = new Set();
  return (alerts || [])
    .map((a) => {
      const head = (a.headerText || "").replace(/\s+/g, " ").trim();
      const desc = (a.descriptionText || "").replace(/\s+/g, " ").trim();
      const s = head && desc && !desc.startsWith(head) ? `${head}: ${desc}` : desc || head;
      return s.length > 400 ? s.slice(0, 400) + " …" : s;
    })
    .filter((s) => s && !seen.has(s) && seen.add(s))
    .slice(0, limit);
}

/** Zeitpunkt an einem Halt: geplant, Prognose, Verspaetung. */
function stopTime(scheduled, actual, realTime) {
  return {
    soll: hhmm(scheduled),
    ist: realTime && actual ? hhmm(actual) : null,
    verspaetungMin: realTime ? minutesBetween(scheduled, actual) : null,
    echtzeit: realTime === true,
  };
}

const track = (p) => p?.track ?? p?.scheduledTrack ?? null;
const trainNo = (s) => (s ? s.replace(/^0+(?=\d)/, "") : null);

/** NS/SNCB liefern nur "Intercity"/"Sprinter" - dann die Zugnummer anhaengen. */
function trainName(x) {
  const name = x.displayName || x.routeShortName || "";
  const no = trainNo(x.tripShortName);
  return no && !/\d/.test(name) ? `${name} ${no}`.trim() : name;
}

function leg(l) {
  if (l.mode === "WALK" || !l.tripId) {
    return { fussweg: true, von: l.from?.name, nach: l.to?.name, minuten: Math.round((l.duration ?? 0) / 60) };
  }
  return {
    zug: trainName(l),
    zugnummer: trainNo(l.tripShortName),
    richtung: l.headsign,
    ausgefallen: l.cancelled === true,
    von: l.from?.name,
    ab: stopTime(l.from?.scheduledDeparture ?? l.scheduledStartTime, l.from?.departure ?? l.startTime, l.realTime),
    gleisAb: track(l.from),
    gleisAbGeplant: l.from?.scheduledTrack ?? null,
    nach: l.to?.name,
    an: stopTime(l.to?.scheduledArrival ?? l.scheduledEndTime, l.to?.arrival ?? l.endTime, l.realTime),
    gleisAn: track(l.to),
    gleisAnGeplant: l.to?.scheduledTrack ?? null,
    betreiber: l.agencyName ?? null,
    hinweise: alertTexts([...(l.alerts || []), ...(l.from?.alerts || []), ...(l.to?.alerts || [])]),
    tripId: l.tripId,
  };
}

function itinerary(it) {
  const legs = it.legs.map(leg);
  const rides = it.legs.filter((l) => l.mode !== "WALK" && l.tripId);
  const first = rides[0] ?? it.legs[0];
  const last = rides[rides.length - 1] ?? it.legs[it.legs.length - 1];
  return {
    datum: day(first.scheduledStartTime || first.startTime),
    ab: stopTime(first.scheduledStartTime, first.startTime, first.realTime),
    an: stopTime(last.scheduledEndTime, last.endTime, last.realTime),
    dauerMin: Math.round(it.duration / 60),
    umstiege: it.transfers ?? Math.max(0, rides.length - 1),
    ausgefallen: rides.some((l) => l.cancelled === true),
    abschnitte: legs,
  };
}

function envelope(data) {
  return {
    quelle: SOURCE,
    abgefragtUm: now(),
    hinweisFuerAssistent:
      "Nur diese Daten verwenden. 'ist' = aktuelle Prognose, 'soll' = Fahrplan; echtzeit=false heisst: keine Live-Daten fuer diesen Zug, nur Fahrplan. " +
      "Bei jeder Rueckfrage neu abfragen. Antwort mit 'Stand HH:MM · transitous.org/sources' beenden.",
    ...data,
  };
}

/* ------------------------------------------------------------- Tools */

async function bahnhofSuchen({ name }) {
  const res = await searchStops(name, 5);
  return envelope({ treffer: res.map((m) => ({ id: m.id, name: m.name })) });
}

async function verbindungen(args) {
  const von = await resolveStation(args.von);
  const nach = await resolveStation(args.nach);
  const n = Math.min(Math.max(args.anzahl ?? 4, 1), 6);
  const when = parseWhen(args.ankunft || args.abfahrt);
  const res = await api("/api/v6/plan", {
    fromPlace: von.id,
    toPlace: nach.id,
    time: when?.toISOString(),
    arriveBy: args.ankunft ? true : undefined,
    transitModes: args.nurNahverkehr ? LOCAL_MODES : args.auchFernbus ? undefined : DEFAULT_MODES,
    maxTransfers: typeof args.maxUmstiege === "number" ? args.maxUmstiege : undefined,
    numItineraries: n,
    maxItineraries: n,
    detailedLegs: false,
    detailedTransfers: false,
    language: LANG,
  });
  return envelope({
    von: von.name ?? res.from?.name ?? von.id,
    nach: nach.name ?? res.to?.name ?? nach.id,
    verbindungen: (res.itineraries || []).map(itinerary),
  });
}

async function abfahrten(args) {
  const st = await resolveStation(args.bahnhof);
  const ank = args.ankuenfte === true;
  const n = Math.min(Math.max(args.anzahl ?? 10, 1), 20);
  const res = await api("/api/v6/stoptimes", {
    stopId: st.id,
    time: parseWhen(args.zeit)?.toISOString(),
    arriveBy: ank ? true : undefined,
    window: Math.min(args.minuten ?? 30, 120) * 60,
    n,
    mode: args.auchBusUndTram ? undefined : RAIL_MODES,
    language: LANG,
  });
  // Doppelte Eintraege zusammenfassen: gekoppelte Zuege (RE19 mit zwei Zugnummern) und Zuege,
  // die in zwei Datensaetzen stehen (NJ 403 in DELFI und OpenOV). Echtzeit gewinnt, dann Gleisangabe.
  const byKey = new Map();
  for (const s of res.stopTimes || []) {
    const line = (s.displayName || s.routeShortName || "").split(/[\s(]/)[0].toLowerCase();
    const dest = (s.headsign || "").toLowerCase().split(/[\s,(/]/)[0];
    const key = [line, dest, s.place?.scheduledDeparture ?? s.place?.scheduledArrival].join("|");
    const prev = byKey.get(key);
    const score = (x) => (x.realTime ? 2 : 0) + (track(x.place) ? 1 : 0);
    if (!prev || score(s) > score(prev)) byKey.set(key, s);
  }
  const list = [...byKey.values()];
  return envelope({
    bahnhof: st.name ?? res.place?.name ?? st.id,
    art: ank ? "Ankuenfte" : "Abfahrten",
    zuege: list.slice(0, n).map((s) => {
      const p = s.place || {};
      return {
        zug: trainName(s),
        zugnummer: trainNo(s.tripShortName),
        [ank ? "von" : "richtung"]: ank ? s.tripFrom?.name : s.headsign,
        zeit: ank ? stopTime(p.scheduledArrival, p.arrival, s.realTime) : stopTime(p.scheduledDeparture, p.departure, s.realTime),
        gleis: track(p),
        gleisGeplant: p.scheduledTrack ?? null,
        ausgefallen: s.cancelled === true || s.tripCancelled === true,
        hinweise: alertTexts(p.alerts, 3),
        tripId: s.tripId,
      };
    }),
  });
}

async function zugverlauf({ tripId }) {
  const res = await api("/api/v6/trip", { tripId, detailedLegs: false, language: LANG });
  const legs = (res.legs || []).filter((l) => l.tripId);
  const l = legs[0];
  if (!l) throw new Error("Zug nicht gefunden");
  const halte = [];
  for (const x of legs) {
    const stops = [x.from, ...(x.intermediateStops || []), x.to];
    for (const s of stops) {
      if (halte.length && halte[halte.length - 1].halt === s.name) continue; // Zugteil-Wechsel
      halte.push({
        halt: s.name,
        an: stopTime(s.scheduledArrival, s.arrival, x.realTime),
        ab: stopTime(s.scheduledDeparture, s.departure, x.realTime),
        gleis: track(s),
        gleisGeplant: s.scheduledTrack ?? null,
        entfaellt: s.cancelled === true,
      });
    }
  }
  return envelope({
    zug: trainName(l),
    zugnummer: trainNo(l.tripShortName),
    richtung: l.headsign,
    ausgefallen: legs.some((x) => x.cancelled === true),
    halte,
    hinweise: alertTexts(legs.flatMap((x) => x.alerts || []), 8),
  });
}

const TIME_HINT = "Deutsche Ortszeit, Format 2026-09-27T18:00. Leer = jetzt.";

const TOOLS = [
  {
    name: "bahn_bahnhof_suchen",
    description: "Bahnhof/Haltestelle suchen. Liefert IDs und offizielle Namen.",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    run: bahnhofSuchen,
  },
  {
    name: "bahn_verbindungen",
    description:
      "Zugverbindungen von A nach B mit Live-Verspaetungen, Gleisen, Ausfaellen und Stoerungshinweisen (wo Echtzeit verfuegbar). Bahnhofsnamen oder IDs.",
    inputSchema: {
      type: "object",
      required: ["von", "nach"],
      properties: {
        von: { type: "string" },
        nach: { type: "string" },
        abfahrt: { type: "string", description: "Abfahrt ab. " + TIME_HINT },
        ankunft: { type: "string", description: "Ankunft spaetestens (statt abfahrt). " + TIME_HINT },
        nurNahverkehr: { type: "boolean", description: "Nur Nahverkehr ohne Fernzuege (z.B. Deutschlandticket)." },
        auchFernbus: { type: "boolean", description: "true = auch Fernbusse (FlixBus, BlaBlaCar) einbeziehen. Standard nur Bahn und Nahverkehr." },
        maxUmstiege: { type: "number" },
        anzahl: { type: "number", description: "Anzahl Verbindungen, Standard 4, max 6." },
      },
    },
    run: verbindungen,
  },
  {
    name: "bahn_abfahrten",
    description: "Live-Abfahrtstafel (oder Ankuenfte) eines Bahnhofs mit Verspaetung, Gleis und Ausfaellen. Standard nur Zuege.",
    inputSchema: {
      type: "object",
      required: ["bahnhof"],
      properties: {
        bahnhof: { type: "string" },
        zeit: { type: "string", description: TIME_HINT },
        minuten: { type: "number", description: "Zeitfenster, Standard 30, max 120." },
        anzahl: { type: "number", description: "Standard 10, max 20." },
        ankuenfte: { type: "boolean", description: "true = Ankunftstafel." },
        auchBusUndTram: { type: "boolean", description: "true = auch Bus, Tram, U-Bahn anzeigen." },
      },
    },
    run: abfahrten,
  },
  {
    name: "bahn_zugverlauf",
    description:
      "Live-Verlauf eines Zuges: alle Halte mit aktueller Verspaetung und Gleis. tripId aus bahn_verbindungen oder bahn_abfahrten.",
    inputSchema: { type: "object", required: ["tripId"], properties: { tripId: { type: "string" } } },
    run: zugverlauf,
  },
];

/* ----------------------------------------------------------- MCP (stdio) */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function describeError(err) {
  return `Fahrplanabfrage fehlgeschlagen (${err.message}). Keine Live-Daten verfuegbar - keine Zeiten nennen, auf bahn.de oder die DB-Navigator-App verweisen.`;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // Notification

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "db", version: VERSION },
    });
  }
  if (method === "tools/list") {
    const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    return ok(id, { tools: TOOLS.map(({ run, ...t }) => ({ ...t, annotations })) });
  }
  if (method === "ping") return ok(id, {});

  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(id, -32602, `Unbekanntes Tool: ${params?.name}`);
    try {
      const result = await tool.run(params?.arguments ?? {});
      return ok(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch (err) {
      return ok(id, { isError: true, content: [{ type: "text", text: describeError(err) }] });
    }
  }

  return fail(id, -32601, `Unbekannte Methode: ${method}`);
}

async function main() {
  const argv = process.argv;
  const i = argv.indexOf("--test");
  if (i >= 0) {
    const [von = "Köln Hbf", nach = "Bonn Hbf"] = argv.slice(i + 1);
    console.log(JSON.stringify(await verbindungen({ von, nach, anzahl: 2 }), null, 2));
    return;
  }
  const j = argv.indexOf("--abfahrten");
  if (j >= 0) {
    console.log(JSON.stringify(await abfahrten({ bahnhof: argv[j + 1] || "Köln Hbf", anzahl: 6 }), null, 2));
    return;
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      handle(msg).catch((err) => {
        if (msg?.id !== undefined) fail(msg.id, -32603, err.message);
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
