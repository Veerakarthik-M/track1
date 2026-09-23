# ANAVANDI — Multilingual Route & Fare Assistant
### PS-02 | Track 1: Public Transport | ANAVANDI FutureBuild 2026 Grand Finale

---

## 🚌 What This Is

A **voice-first, offline-capable, multilingual** bus route and fare assistant for first-time passengers in Kerala.  
Designed for migrant workers, tourists, elderly passengers, and people with limited literacy.

**Target corridor:** Ernakulam / Thrissur District, Kerala

---

## ✅ Minimum Prototype Scope — Checklist

| Requirement | Status |
|---|---|
| ≥ 3 languages (Malayalam, English, Hindi) | ✅ |
| Accept typed AND voice input | ✅ |
| Return route, boarding stop, destination stop | ✅ |
| Return fare stages and expected fare | ✅ |
| Spoken output (TTS) | ✅ |
| Usable offline (weak/no connection) | ✅ (Service Worker + local JSON) |
| Fare labelled as estimate | ✅ |
| No unnecessary personal data collection | ✅ |

---

## 🗂️ File Structure

```
CODE_ROAD/
├── index.html              ← App shell (accessible UI)
├── style.css               ← Clean design — no loud colors, large text
├── app.js                  ← All logic: STT, TTS, routing, fare, NLP
├── data/
│   ├── stops.json          ← 15 stops × 3 languages + landmarks (SYNTHETIC)
│   ├── routes.json         ← 10 bus routes (SYNTHETIC, Kerala corridor)
│   ├── fare_stages.json    ← Fare stage matrix (SYNTHETIC, KSRTC structure)
│   └── sample_queries.json ← 15 test queries in EN/ML/HI (SYNTHETIC DATASET)
├── manifest.json           ← PWA manifest (installable on phone)
├── sw.js                   ← Service Worker (full offline caching)
└── README.md               ← This file
```

---

## 🚀 How to Run

**No server, no npm, no installation required.**

1. Open `index.html` directly in **Chrome** or **Edge**
2. For voice input, allow microphone access when prompted
3. Works fully offline after the first load

> ⚠️ Voice input requires Chrome or Edge. Firefox has limited SpeechRecognition support.

---

## 🏗️ Architecture

```
User (Voice/Text)
       │
       ▼
   IntentParser           ← Keyword + fuzzy (Levenshtein) NLP in JS
       │                     Detects: language, from-stop, to-stop
       ▼
   RouteEngine            ← BFS over route graph
       │                     Handles: direct routes + single-transfer
       ▼
   FareCalculator         ← Looks up stage matrix or calculates from km
       │
       ▼
   ResponseGenerator      ← Multilingual text templates
       │
       ├─→ ResultCard     ← Visual display with bus/stop/fare
       └─→ SpeechSynthesis ← TTS spoken aloud in selected language
```

---

## 🎙️ Speech Technology

| Feature | Technology | API Key Needed | Works Offline |
|---|---|---|---|
| Speech-to-Text | Web Speech API (`SpeechRecognition`) | ❌ No | ✅ Yes (after cache) |
| Text-to-Speech | Web Speech Synthesis API | ❌ No | ✅ Yes |
| Languages | `ml-IN`, `en-IN`, `hi-IN` | — | — |

---

## 📊 Synthetic Dataset Summary

| File | Records | Source |
|---|---|---|
| `stops.json` | 15 stops | Synthetic — based on real Kerala stop names |
| `routes.json` | 10 routes | Synthetic — based on real KSRTC corridors |
| `fare_stages.json` | 40+ fare pairs | Synthetic — based on KSRTC stage/km structure |
| `sample_queries.json` | 15 queries | Synthetic — covers EN/ML/HI, direct, transfer, fare-only |

---

## 🔧 Key Modules in `app.js`

| Module | Lines | Purpose |
|---|---|---|
| `DataLayer` | ~40 | Loads JSON, provides stop/route/fare lookup |
| `IntentParser` | ~100 | Keyword extraction + Levenshtein fuzzy match |
| `RouteEngine` | ~70 | BFS journey finder with transfer support |
| `FareCalc` | ~35 | Stage lookup + km-based fallback estimation |
| `SpeechModule` | ~55 | Web Speech API STT + TTS wrapper |
| `T` (translations) | ~120 | All UI strings in EN / ML / HI |
| `UI` | ~280 | Event handling, rendering, autocomplete |

---

## ♿ Accessibility Features

- Large Text Mode toggle (22px base font)
- High contrast — minimum 4.5:1 ratio
- All interactive elements ≥ 48px tap target
- ARIA labels on all controls
- Screen reader live regions for results
- Offline-first — works on 2G/no internet
- No login / no data collection

---

## 📝 Important Boundaries

> **Fare output is always labelled as an ESTIMATE.**  
> The app does not collect or store any personal information.  
> No account, no GPS, no tracking.

---

## 🏆 Rubric Coverage

| Criteria | How We Address It |
|---|---|
| Problem understanding (15) | Voice-first for migrants/tourists/elderly; offline for Kerala's weak connectivity |
| Originality (10) | Browser-native STT+TTS (no API cost), BFS routing + fuzzy NLP, all in one HTML file |
| Impact (10) | 3 languages, large-text mode, landmark hints, works on budget Android |
| Feasibility (10) | Zero dependencies, zero server, runs from a USB stick |
| Working prototype (20) | Full end-to-end: voice → parse → route → fare → TTS |
| Use of dataset (10) | 4 JSON datasets, 15+ test queries, fare stage matrix |
| Architecture & code quality (10) | 7 modular JS classes, clean separation, documented |
| Response to feedback (10) | Architecture designed to swap route/fare data at any time |
