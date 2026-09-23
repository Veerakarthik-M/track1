# ANAVANDI — Technical Architecture Document

> **PS-02 | Track 1 — Public Transport | FutureBuild 2026**  
> Multilingual, Offline-First Bus Route & Fare Assistant for Kerala

---

## 1. What database is currently used?

**JSON flat files** stored in the `data/` directory, loaded via `fetch()` into memory on app startup.

| File | Purpose | Records |
|---|---|---|
| `stops.json` | Stop coordinates, multilingual names, landmarks | 31 stops |
| `routes.json` | Route definitions, stop sequences, distances, frequencies | 32 routes |
| `fare_stages.json` | Fare lookup matrix by route + stop pair | 16 route matrices |
| `aliases.json` | Tourist/colloquial name → stop_id mappings | ~30 aliases |
| `entities.json` | Higher-level place entities with disambiguation | ~25 entities |
| `dataset_meta.json` | Dataset version, sources, provenance metadata | 1 document |

All data is cached offline by the Service Worker on first visit.

---

## 2. What database is planned?

**SQLite/WASM** via `sql.js` or `wa-sqlite` — a full relational database running inside the browser.

### Why not yet?
The `sql.js` WASM binary is ~2MB. Our current JSON dataset totals <50KB. Adding SQLite now would:
- Increase load time 40x
- Add complexity without proportional benefit at 31 stops

### Migration readiness
The `DataLayer` module already provides a clean abstraction. All consumers call `DataLayer.getStop()`, `DataLayer.getAllRoutes()`, etc. — never accessing JSON directly. Swapping the storage backend requires changing only the `DataLayer` internals.

### Planned schema

```
PLACES(place_id, canonical_name, type, lat, lon)
ALIASES(alias_id, place_id, language, alias)
STOPS(stop_id, place_id, stop_name, lat, lon)
ROUTES(route_id, route_name, direction)
ROUTE_STOPS(route_id, stop_id, sequence)
FARE_STAGES(route_id, from_stage, to_stage, fare)
DATA_SOURCES(source_id, source_name, type, url, version, collected_at, validation_status)
```

---

## 3. Why SQLite/WASM?

> Our transport data is inherently relational. Routes contain ordered stops, stops have geographic coordinates and multilingual aliases, and fare rules relate to specific route segments. When scaling to Kerala's full 14-district network (~3,000+ stops), JSON-in-memory becomes impractical. SQLite allows complex relational queries (e.g., "find all routes passing through stop X toward destination Y") to execute locally while keeping the application fully offline.

Current dataset size does not require it. The abstraction layer is ready for it.

---

## 4. Where does transport data come from?

| Source | Type | Validation |
|---|---|---|
| KochiTransport GTFS (Jungle Bus / OSM) | GTFS feed | Cross-referenced for coordinates |
| kbuses.in KSRTC Schedules | Web scrape | Manual spot-check |
| Kerala Private Bus Timing (RTI via amith-vp) | Government RTI data | Unverified reference (2023 data) |
| Manual curation | Hand-verified | Verified |

See `data/dataset_meta.json` for full provenance details.

**IMPORTANT**: No external dataset is treated as ground truth. Each source is tagged with validation status. Route and fare data labeling in the UI distinguishes between "looked-up" and "estimated" values.

---

## 5. How is data validated?

```
External Sources
  ↓
Data Collection (GTFS, web scrape, RTI)
  ↓
Format Normalization → canonical JSON
  ↓
Duplicate Removal
  ↓
Canonical Place/Stop Mapping
  ↓
Cross-Validation (coordinates checked against GTFS)
  ↓
Manual Verification (critical routes)
  ↓
Version Tag + Provenance Metadata
  ↓
Verified Local Dataset
  ↓
DataLayer → RouteEngine / FareEngine
```

Critical transport information (route sequences, boarding stops, fare calculations) has stronger validation than non-critical metadata.

---

## 6. How does microphone input become a route?

```
User taps 🎤
  ↓
Browser requests microphone permission
  ↓
SpeechRecognition API (webkitSpeechRecognition)
  ↓
Speech transcript (text string)
  ↓
User confirms: "I heard: <transcript>. Correct?"
  ↓
IntentParser.parse(transcript)
  ↓
Keyword matching (FROM/TO in EN/ML/HI)
  ↓
fuzzyMatchStop() with Levenshtein distance
  ↓
EntityResolver.resolve() for alias lookup
  ↓
Canonical stop IDs: { fromStop, toStop }
  ↓
RouteEngine.findJourney(fromStop, toStop)   ← SAME as text input
  ↓
FareEngine.estimateFare(routeId, from, to)  ← SAME as text input
  ↓
renderResult() → display route cards
  ↓
SpeechSynthesis reads the directions aloud
```

**Voice and text input converge into the same structured query format.** There is no separate routing logic for voice.

---

## 7. How does speaker output work?

```
RouteEngine result (structured object)
  ↓
Language template (LANG[lang].speakDirect / speakTransfer)
  ↓
Variable substitution: {bus}, {from}, {to}, {fare}
  ↓
Human-readable sentence
  ↓
new SpeechSynthesisUtterance(sentence)
  ↓
utterance.lang = 'en-IN' / 'ml-IN' / 'hi-IN'
  ↓
speechSynthesis.speak(utterance)
  ↓
Device speaker
```

**Limitation**: TTS quality and offline availability depends on the device OS voice packs. Most Android devices include Hindi and English voices. Malayalam voices require Google TTS or a similar engine to be installed.

---

## 8. Why BFS?

The bus network is modeled as a **directed graph**:
- **Nodes** = stops
- **Edges** = bus connections (a route connecting stop A → B → C creates edges A→B, B→C, A→C)

BFS (Breadth-First Search) finds paths with **minimum transfers**:
1. First: direct routes (0 transfers)
2. Then: 1-transfer routes (2 buses)
3. Then: 2-transfer routes (3 buses)

**What BFS optimizes**: fewest transfers.

**What BFS does NOT optimize**: travel time, walking distance, fare, waiting time.

Future improvement: Dijkstra/A* with weighted edges (travel time + walking + waiting) would give truly optimal routes. For the current 31-stop network, BFS produces correct results.

---

## 9. What is actually offline?

| Feature | Offline Status |
|---|---|
| Application shell (HTML/CSS/JS) | ✅ Fully offline (Service Worker cache) |
| Route calculation (BFS) | ✅ Fully offline (local JSON) |
| Fare estimation | ✅ Fully offline (local JSON) |
| Place/alias resolution | ✅ Fully offline (local JSON) |
| Intent parsing (NLP) | ✅ Fully offline (rule-based, no AI model) |
| Autocomplete | ✅ Fully offline (local data) |
| Journey tracking (GPS) | ✅ Fully offline (Geolocation API) |
| Destination alerts | ✅ Fully offline (Haversine math) |
| Text-to-Speech (TTS) | ⚠️ Device dependent (works if OS voices installed) |
| Speech-to-Text (STT) | ❌ Internet required (Chrome's SpeechRecognition uses cloud) |
| Google Fonts | ⚠️ Cached on first load, then offline |

---

## 10. What is browser/device dependent?

- **SpeechRecognition**: Chrome/Edge only. Requires internet. Firefox/Safari: not supported.
- **SpeechSynthesis**: Available on most modern browsers. Voice quality depends on installed OS voices.
- **Geolocation**: Requires device GPS chip for outdoor accuracy. Desktop browsers use Wi-Fi/IP triangulation (poor accuracy).
- **Vibration API**: Mobile only. Used for destination approach alerts.

---

## 11. How does the application work on mobile/laptop?

**Responsive design** with three breakpoints:

| Device | Breakpoint | Layout |
|---|---|---|
| Mobile | < 640px | Single column, large touch targets, stacked cards |
| Tablet | 640–1024px | Wider cards, centered content, more padding |
| Desktop | > 1024px | Max 960px width, 2-column journey mode grid |

The same application URL works across all devices. No separate mobile/desktop versions.

---

## 12. How are incorrect/outdated datasets handled?

1. **Provenance tagging**: Every data source in `dataset_meta.json` has a `validation` status and `collected` date.
2. **Fare honesty**: When fare is calculated from distance (not looked up from matrix), the UI shows "≈ ₹X–₹Y (distance estimate)" instead of presenting it as exact.
3. **Version footer**: The home screen shows "Dataset v1.3.0 · Updated 2026-09-24 · 31 stops · 32 routes" so users and evaluators know the data vintage.
4. **Update architecture**: When internet is available, a newer `dataset_meta.json` could trigger a dataset refresh via the Service Worker. The current implementation caches data on first load; newer versions are fetched on subsequent visits when online.
5. **Graceful degradation**: If `DataLayer.loadAll()` fails, the app shows an error but does not crash — it continues in degraded mode.

---

## File Structure

```
CODE_ROAD/
├── index.html          # Main 4-screen PWA
├── app.js              # All application logic (10 modules)
├── style.css           # Responsive CSS with 3 breakpoints
├── sw.js               # Service Worker (cache-first strategy)
├── manifest.json       # PWA manifest
├── evaluate.html       # NLP/routing test dashboard
├── debug.html          # Offline diagnostics page
├── ARCHITECTURE.md     # This document
├── assets/
│   └── bg.jpg          # KSRTC bus watermark background
└── data/
    ├── stops.json
    ├── routes.json
    ├── fare_stages.json
    ├── aliases.json
    ├── entities.json
    ├── dataset_meta.json
    └── sample_queries.json
```

---

## Module Architecture (app.js)

```
┌─────────────────────────────────────────────────────┐
│                    UI Controller                      │
│  (4-screen flow, event handlers, DOM manipulation)    │
├──────────┬──────────┬──────────┬──────────┬──────────┤
│ Speech   │ Journey  │ Route    │ Fare     │ Intent   │
│ Module   │ Tracker  │ Engine   │ Engine   │ Parser   │
│ (STT+TTS)│ (GPS)    │ (BFS)   │ (Stage+  │ (NLP)    │
│          │          │          │  Fallback)│          │
├──────────┴──────────┼──────────┴──────────┼──────────┤
│    GeoEngine        │  EntityResolver     │ Alias    │
│    (Haversine)      │  (Disambiguation)   │ Resolver │
├─────────────────────┴─────────────────────┴──────────┤
│                    DataLayer                           │
│  (JSON loader, metadata, stop/route/fare/alias APIs)  │
└─────────────────────────────────────────────────────┘
```

---

## Known Limitations

1. **Speech-to-Text requires internet** — Chrome's SpeechRecognition API sends audio to Google servers. We do not claim offline STT.
2. **GPS accuracy on desktop** — Desktop browsers lack GPS chips; location is approximate via Wi-Fi/IP triangulation.
3. **Dataset coverage** — Currently 6 districts with 31 stops and 32 routes. Not full Kerala coverage.
4. **BFS routing** — Finds minimum-transfer paths, not time-optimal paths.
5. **Fare estimation** — Distance-based fallback when exact fare matrix is unavailable. Clearly labeled in UI.
6. **Private bus data** — RTI dataset is from 2023 and may be outdated. Labeled as "unverified reference."

---

*Generated: 2026-09-24 | ANAVANDI v1.3.0*
