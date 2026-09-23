/**
 * ANAVANDI v2 — Complete Multilingual Journey Assistant
 * PS-02 | Track 1 — Public Transport | ANAVANDI FutureBuild 2026
 *
 * Modules:
 *  1. DataLayer       — JSON loader, stop/route/fare/alias APIs
 *  2. GeoEngine       — Haversine GPS, nearest-stop finder
 *  3. AliasResolver   — tourist names, old names, multilingual aliases
 *  4. IntentParser    — keyword NLP + fuzzy match (Levenshtein)
 *  5. RouteEngine     — BFS route + transfer finder
 *  6. FareEngine      — stage lookup + km fallback
 *  7. SpeechModule    — Web Speech API STT + TTS
 *  8. Translations    — All UI strings EN / ML / HI
 *  9. JourneyTracker  — GPS watch, 3-level destination alerts
 * 10. UI              — 4-screen controller
 */

'use strict';

// ═══════════════════════════════════════════════════════════
// 1. DATA LAYER
// ═══════════════════════════════════════════════════════════
const DataLayer = (() => {
  let stops = null, routes = null, fareMatrix = null, aliases = null, entities = null;
  let datasetMeta = null;
  let _loadError = null;

  async function loadAll() {
    try {
      const [sRes, rRes, fRes, aRes, eRes, mRes] = await Promise.all([
        fetch('data/stops.json'),
        fetch('data/routes.json'),
        fetch('data/fare_stages.json'),
        fetch('data/aliases.json'),
        fetch('data/entities.json'),
        fetch('data/dataset_meta.json').catch(() => null),
      ]);
      stops = await sRes.json();
      routes = (await rRes.json()).routes;
      fareMatrix = (await fRes.json()).stage_matrix;
      const aliasData = await aRes.json();
      aliases = aliasData.aliases;
      const entityData = await eRes.json();
      entities = entityData;
      if (mRes && mRes.ok) datasetMeta = await mRes.json();
      console.info('[DataLayer] Loaded:', { stops: Object.keys(stops).length, routes: routes.length, fareStages: Object.keys(fareMatrix).length, version: datasetMeta?.version });
      return true;
    } catch (e) {
      console.error('[DataLayer] Load failed:', e);
      _loadError = e.message || 'Unknown error';
      return false;
    }
  }

  const getStop = (id) => stops?.[id] ?? null;
  const getAllStops = () => stops ? Object.values(stops) : [];
  const getAllRoutes = () => routes ?? [];
  const getFareMatrix = (routeId) => fareMatrix?.[routeId] ?? {};
  const getAllAliases = () => aliases ?? [];
  const getEntities = () => entities;
  const getLoadError = () => _loadError;

  function getStopName(id, lang = 'en') {
    const s = getStop(id);
    if (!s) return id;
    return s[lang] || s.en || id;
  }

  function getLandmark(id, lang = 'en') {
    const s = getStop(id);
    return s?.landmark ? (s.landmark[lang] || s.landmark.en) : null;
  }

  // Dataset metadata & provenance
  function getVersion() {
    return {
      version: datasetMeta?.version || '1.0.0',
      lastUpdated: datasetMeta?.last_updated || 'unknown',
      sources: datasetMeta?.sources || [],
      coverage: datasetMeta?.coverage || {},
      limitations: datasetMeta?.limitations || [],
    };
  }

  function getDataSource(sourceId) {
    return (datasetMeta?.sources || []).find(s => s.id === sourceId) || null;
  }

  return { loadAll, getStop, getAllStops, getAllRoutes, getFareMatrix, getAllAliases, getStopName, getLandmark, getEntities, getVersion, getDataSource, getLoadError };
})();

// ═══════════════════════════════════════════════════════════
// 2. GEO ENGINE (Haversine GPS)
// ═══════════════════════════════════════════════════════════
const GeoEngine = (() => {
  const R = 6371000; // Earth radius in metres

  function haversine(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function formatDistance(m) {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }

  function walkingMinutes(m) {
    return Math.max(1, Math.round(m / 80)); // avg 80m/min walking
  }

  function getNearestStops(lat, lon, limit = 5) {
    const stops = DataLayer.getAllStops().filter(s => s.lat && s.lon);
    return stops
      .map(s => ({ ...s, distance: haversine(lat, lon, s.lat, s.lon) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  // Finds nearest stops that SERVE a given destination (smart boarding)
  function getBestBoardingStops(userLat, userLon, destStopId, limit = 3) {
    const routes = DataLayer.getAllRoutes();
    // Find all stops that appear before destStopId on any route
    const servingStops = new Set();
    for (const r of routes) {
      const di = r.stops.indexOf(destStopId);
      if (di > 0) {
        for (let i = 0; i < di; i++) servingStops.add(r.stops[i]);
      }
    }
    const candidates = DataLayer.getAllStops()
      .filter(s => s.lat && s.lon && servingStops.has(s.id))
      .map(s => ({ ...s, distance: haversine(userLat, userLon, s.lat, s.lon) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
    return candidates;
  }

  function getDistanceToStop(userLat, userLon, stopId) {
    const s = DataLayer.getStop(stopId);
    if (!s || !s.lat || !s.lon) return null;
    return haversine(userLat, userLon, s.lat, s.lon);
  }

  function getCurrentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('no_geolocation')); return; }

      // First attempt: high accuracy, no cached fixes
      navigator.geolocation.getCurrentPosition(
        pos => {
          const acc = pos.coords.accuracy;   // metres
          // If fix is good enough, use it
          if (acc <= 150) {
            resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: acc });
            return;
          }
          // Fix is coarse (>150m) — try one more time with a fresh request
          navigator.geolocation.getCurrentPosition(
            pos2 => resolve({ lat: pos2.coords.latitude, lon: pos2.coords.longitude, accuracy: pos2.coords.accuracy }),
            err  => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: acc }), // fallback to coarse
            { timeout: 8000, enableHighAccuracy: true, maximumAge: 0 }
          );
        },
        err => reject(err),
        { timeout: 12000, enableHighAccuracy: true, maximumAge: 0 }  // maximumAge:0 = always fresh
      );
    });
  }

  // bestAccuracy tracks the best fix seen so far in this watch session
  let _bestAccuracy = Infinity;

  function watchPosition(cb, errCb) {
    if (!navigator.geolocation) return null;
    _bestAccuracy = Infinity;  // reset on new watch
    return navigator.geolocation.watchPosition(
      pos => {
        const acc = pos.coords.accuracy;
        // Accept this fix only if it's reasonably accurate (<=200m)
        // AND if it's better than or within 30m of the best seen so far
        // This prevents jitter from oscillating between a good GPS fix and a coarse Wi-Fi fix
        if (acc > 200) return;   // skip coarse fixes (IP / Wi-Fi triangulation artefacts)
        if (acc > _bestAccuracy + 30) return;  // skip if significantly worse than best seen
        _bestAccuracy = Math.min(_bestAccuracy, acc);
        cb({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: acc });
      },
      errCb,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
      //                          ↑ maximumAge:0 = always fresh, never use cached position
    );
  }

  function clearWatch(id) {
    if (id != null) navigator.geolocation.clearWatch(id);
  }

  return { haversine, formatDistance, walkingMinutes, getNearestStops, getDistanceToStop, getCurrentPosition, watchPosition, clearWatch };
})();

// ═══════════════════════════════════════════════════════════
// 3. ENTITY RESOLVER (Varkala Cliff ≠ Varkala, etc.)
// ═══════════════════════════════════════════════════════════
const EntityResolver = (() => {
  /**
   * Resolves a text query to a canonical stop_id.
   * Priority: entity aliases > stop aliases > direct stop name match
   * Returns { stopId, entityId, type, confidence, note }
   */
  function resolve(text) {
    if (!text) return null;
    const norm = text.toLowerCase().trim();
    const entityData = DataLayer.getEntities();
    if (!entityData) return null;

    // 1. Check entity aliases (handles Varkala Cliff, Trivandrum, etc.)
    for (const a of (entityData.aliases || [])) {
      if (norm === a.alias.toLowerCase() || norm.includes(a.alias.toLowerCase())) {
        const stopId = entityData.entity_to_stop?.[a.entity_id] ?? null;
        const entity = entityData.entities?.find(e => e.id === a.entity_id);
        return {
          stopId,
          entityId: a.entity_id,
          type: entity?.type || 'UNKNOWN',
          canonical: entity?.canonical || a.alias,
          confidence: 'high',
          note: a.note || null
        };
      }
    }

    // 2. Check stop aliases (data/aliases.json)
    const stopAliases = DataLayer.getAllAliases();
    for (const a of stopAliases) {
      if (norm === a.alias.toLowerCase() || norm.includes(a.alias.toLowerCase())) {
        return { stopId: a.stop_id, entityId: null, type: 'STOP', canonical: a.alias, confidence: 'medium', note: null };
      }
    }

    return null;
  }

  /**
   * Detects if a query is ambiguous (multiple possible interpretations)
   * Returns array of candidates if ambiguous, null if clear.
   */
  function detectAmbiguity(text) {
    if (!text) return null;
    const norm = text.toLowerCase().trim();
    const entityData = DataLayer.getEntities();
    if (!entityData) return null;

    const matches = [];
    const seen = new Set();
    for (const a of (entityData.aliases || [])) {
      if (norm.includes(a.alias.toLowerCase())) {
        const eid = a.entity_id;
        if (!seen.has(eid)) {
          seen.add(eid);
          const entity = entityData.entities?.find(e => e.id === eid);
          const stopId = entityData.entity_to_stop?.[eid];
          if (entity) matches.push({ entityId: eid, canonical: entity.canonical, type: entity.type, stopId });
        }
      }
    }
    return matches.length > 1 ? matches : null;
  }

  return { resolve, detectAmbiguity };
})();

// ═══════════════════════════════════════════════════════════
// 3b. ALIAS RESOLVER (legacy wrapper for IntentParser)
// ═══════════════════════════════════════════════════════════
const AliasResolver = (() => {
  function resolve(text) {
    // Try entity resolver first (handles Varkala Cliff, Trivandrum, etc.)
    const entityResult = EntityResolver.resolve(text);
    if (entityResult?.stopId) return entityResult.stopId;
    return null;
  }
  return { resolve };
})();

// ═══════════════════════════════════════════════════════════
// 4. INTENT PARSER
// ═══════════════════════════════════════════════════════════
const IntentParser = (() => {
  const FROM_KW = {
    en: ['starting from', 'boarding at', 'i am at', 'i am in', 'i am near', 'from', 'at', 'near'],
    ml: ['നിന്ന്', 'നിന്നും', 'ൽ നിന്ന്', 'ൽ'],
    hi: ['यहाँ से', 'यहां से', 'से', 'पर', 'पास', 'मैं']
  };
  const TO_KW = {
    en: ['want to go to', 'need to go to', 'going to', 'drop me at', 'towards', 'reach', 'destination', 'go to', 'to'],
    ml: ['ലേക്ക്', 'വരെ', 'പോകണം', 'പോകണ്ടത്', 'എത്തണം', 'ക്ക്'],
    hi: ['जाना चाहता', 'जाना चाहती', 'जाना है', 'पहुँचना', 'जाऊंगा', 'जाना', 'तक', 'को']
  };

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
    );
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
    return dp[m][n];
  }

  function norm(s) { return s.toLowerCase().trim().replace(/[।,.?!।।]/g, '').replace(/\s+/g, ' '); }

  function detectLanguage(text) {
    if (/[\u0D00-\u0D7F]/.test(text)) return 'ml';
    if (/[\u0900-\u097F]/.test(text)) return 'hi';
    return 'en';
  }

  function fuzzyMatchStop(fragment, lang = 'en') {
    if (!fragment || fragment.length < 2) return null;
    fragment = norm(fragment);

    // 1. Alias lookup first
    const aliasMatch = AliasResolver.resolve(fragment);
    if (aliasMatch) return aliasMatch;

    // 2. Fuzzy match against stop names
    const allStops = DataLayer.getAllStops();
    let best = null, bestScore = Infinity;

    for (const stop of allStops) {
      const candidates = [stop.en, stop.ml, stop.hi, stop.id].filter(Boolean);
      for (const cand of candidates) {
        const cn = norm(cand);
        if (fragment.includes(cn) || cn.includes(fragment)) {
          const score = Math.abs(cn.length - fragment.length);
          if (score < bestScore) { bestScore = score; best = stop.id; }
          continue;
        }
        const dist = levenshtein(fragment, cn);
        const threshold = Math.max(2, Math.floor(cn.length * 0.38));
        if (dist < threshold && dist < bestScore) { bestScore = dist; best = stop.id; }
      }
    }
    return best;
  }

  function parse(text) {
    const lang = detectLanguage(text);
    const n = norm(text);
    let fromText = null, toText = null;

    const fromKw = FROM_KW[lang] || FROM_KW.en;
    const toKw = TO_KW[lang] || TO_KW.en;

    // Try "from X to Y" pattern (longest keyword match first)
    for (const fk of fromKw) {
      for (const tk of toKw) {
        const re = new RegExp(`(?:^|\\s)${fk}\\s+(.+?)\\s+${tk}\\s+(.+)$`, 'i');
        const m = n.match(re);
        if (m) { fromText = m[1].trim(); toText = m[2].trim(); break; }
      }
      if (fromText) break;
    }

    // Try "X to Y" — find the LAST matching keyword to split on (avoids stop names with 'to' in them)
    if (!fromText) {
      for (const tk of toKw) {
        // Find the LAST occurrence of keyword (word boundary)
        const re = new RegExp(`\\b${tk}\\b`, 'gi');
        let m, lastMatch = null;
        while ((m = re.exec(n)) !== null) lastMatch = m;
        if (lastMatch && lastMatch.index > 0) {
          const before = n.slice(0, lastMatch.index).trim();
          const after = n.slice(lastMatch.index + lastMatch[0].length).trim();
          if (before && after) {
            // Strip leading from-keywords from the 'before' part
            let cleanFrom = before;
            for (const fk of fromKw) {
              const fre = new RegExp(`^${fk}\\s+`, 'i');
              if (fre.test(cleanFrom)) { cleanFrom = cleanFrom.replace(fre, '').trim(); break; }
            }
            fromText = cleanFrom;
            toText = after;
            break;
          }
        }
      }
    }

    // Whole text = destination only
    if (!toText && !fromText) toText = n;

    const fromStop = fromText ? fuzzyMatchStop(fromText, lang) : null;
    const toStop = toText ? fuzzyMatchStop(toText, lang) : null;

    // If both resolved to the same stop (e.g. "kochi to ernakulam" both = ernakulam_ksrtc),
    // try to find a better match for the FROM stop by NOT using alias lookup
    let resolvedFrom = fromStop;
    let resolvedTo = toStop;
    if (fromStop && toStop && fromStop === toStop && fromText && toText) {
      // Try re-matching from directly against stop names (skip aliases)
      const allStops = DataLayer.getAllStops();
      let best = null, bestScore = Infinity;
      const fn = norm(fromText);
      for (const stop of allStops) {
        if (stop.id === toStop) continue; // skip the already-matched destination
        const candidates = [stop.en, stop.ml, stop.hi, stop.id].filter(Boolean);
        for (const cand of candidates) {
          const cn = norm(cand);
          if (fn.includes(cn) || cn.includes(fn)) {
            const score = Math.abs(cn.length - fn.length);
            if (score < bestScore) { bestScore = score; best = stop.id; }
          }
        }
      }
      if (best) resolvedFrom = best;
    }

    return {
      fromStop: resolvedFrom,
      toStop: resolvedTo,
      detectedLang: lang,
      raw: text
    };
  }

  return { parse, fuzzyMatchStop, detectLanguage };
})();

// ═══════════════════════════════════════════════════════════
// 5. ROUTE ENGINE (BFS)
// ═══════════════════════════════════════════════════════════
const RouteEngine = (() => {
  function findDirectRoutes(fromId, toId) {
    return DataLayer.getAllRoutes().filter(r => {
      const fi = r.stops.indexOf(fromId);
      const ti = r.stops.indexOf(toId);
      return fi !== -1 && ti !== -1 && fi < ti;
    });
  }

  function findTransferRoutes(fromId, toId) {
    const routes = DataLayer.getAllRoutes();
    const stopRouteMap = {};
    for (const r of routes) {
      for (const s of r.stops) {
        if (!stopRouteMap[s]) stopRouteMap[s] = [];
        stopRouteMap[s].push(r);
      }
    }

    const results = [];
    const fromRoutes = (stopRouteMap[fromId] || []).filter(r => r.stops.indexOf(fromId) !== -1);

    // 1. Check for 1-stop transfer (2 buses)
    for (const r1 of fromRoutes) {
      const fi = r1.stops.indexOf(fromId);
      const transferCandidates = r1.stops.slice(fi + 1);
      for (const ts of transferCandidates) {
        if (ts === toId) break;
        const r2list = (stopRouteMap[ts] || []).filter(r => {
          const ti = r.stops.indexOf(ts);
          const di = r.stops.indexOf(toId);
          return ti !== -1 && di !== -1 && ti < di && r.id !== r1.id;
        });
        for (const r2 of r2list) {
          results.push({ type: 'transfer', route1: r1, route2: r2, transferStop: ts });
        }
      }
    }
    
    // If we found 1-stop transfers, return them. No need to suggest complex 3-bus routes.
    if (results.length > 0) return results;

    // 2. Check for 2-stop transfer (3 buses) - e.g. Kakkanad -> Edapally -> Ernakulam -> Aluva
    for (const r1 of fromRoutes) {
      const fi = r1.stops.indexOf(fromId);
      const ts1Candidates = r1.stops.slice(fi + 1);
      
      for (const ts1 of ts1Candidates) {
        if (ts1 === toId) break;
        const r2list = (stopRouteMap[ts1] || []).filter(r => r.id !== r1.id && r.stops.indexOf(ts1) !== -1);
        
        for (const r2 of r2list) {
          const t1i = r2.stops.indexOf(ts1);
          const ts2Candidates = r2.stops.slice(t1i + 1);
          
          for (const ts2 of ts2Candidates) {
            if (ts2 === toId || ts2 === ts1 || ts2 === fromId) continue;
            
            const r3list = (stopRouteMap[ts2] || []).filter(r => {
              const ti = r.stops.indexOf(ts2);
              const di = r.stops.indexOf(toId);
              return ti !== -1 && di !== -1 && ti < di && r.id !== r1.id && r.id !== r2.id;
            });
            
            for (const r3 of r3list) {
              results.push({ 
                type: 'multi_transfer', 
                route1: r1, transferStop1: ts1, 
                route2: r2, transferStop2: ts2, 
                route3: r3 
              });
            }
          }
        }
      }
    }
    return results;
  }

  function findJourney(fromId, toId) {
    if (!fromId || !toId) return [];
    if (fromId === toId) return [{ type: 'same_stop' }];

    const priority = { 'Super Fast': 0, 'Fast': 1, 'Airport': 1, 'City': 2, 'Ordinary': 3 };
    const direct = findDirectRoutes(fromId, toId);
    
    if (direct.length > 0) {
      direct.sort((a, b) => (priority[a.type] ?? 9) - (priority[b.type] ?? 9));
      return direct.map(route => ({ type: 'direct', route }));
    }

    const transfers = findTransferRoutes(fromId, toId);
    if (transfers.length > 0) {
      // Sort by fewest transfers, then by route priorities loosely
      transfers.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'transfer' ? -1 : 1;
        return (priority[a.route1.type] ?? 9) - (priority[b.route1.type] ?? 9);
      });
      // Deduplicate similar route patterns to avoid flooding options
      const unique = [];
      const seen = new Set();
      for (const t of transfers) {
        const key = t.type === 'transfer' 
          ? `${t.route1.id}-${t.route2.id}` 
          : `${t.route1.id}-${t.route2.id}-${t.route3.id}`;
        if (!seen.has(key)) { seen.add(key); unique.push(t); }
      }
      return unique.slice(0, 3);
    }
    return [{ type: 'not_found' }];
  }

  return { findJourney };
})();

// ═══════════════════════════════════════════════════════════
// 6. FARE ENGINE
// ═══════════════════════════════════════════════════════════
const FareEngine = (() => {
  function lookupFare(routeId, fromId, toId) {
    const matrix = DataLayer.getFareMatrix(routeId);
    const key = `${fromId}-${toId}`;
    const rkey = `${toId}-${fromId}`;
    const result = matrix[key] || matrix[rkey] || null;
    if (result) return { ...result, isEstimate: false };
    return null;
  }

  function estimateFare(routeId, fromId, toId) {
    const lu = lookupFare(routeId, fromId, toId);
    if (lu) return lu;

    const route = DataLayer.getAllRoutes().find(r => r.id === routeId);
    if (!route) return null;
    const fi = route.stops.indexOf(fromId);
    const ti = route.stops.indexOf(toId);
    if (fi === -1 || ti === -1) return null;
    const km = Math.abs((route.stop_distances_km?.[ti] || 0) - (route.stop_distances_km?.[fi] || 0));
    const stages = Math.max(1, Math.ceil(km / 3));
    const fare = 7 + (stages - 1) * 3;
    return { stages, fare_min: fare, fare_max: fare + 4, isEstimate: true };
  }

  return { estimateFare };
})();

// ═══════════════════════════════════════════════════════════
// 7. SPEECH MODULE
// ═══════════════════════════════════════════════════════════
const SpeechModule = (() => {
  const LANG_CODES = { en: 'en-IN', ml: 'ml-IN', hi: 'hi-IN' };
  const supported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  let recognition = null, isListening = false;

  function startListening(langKey, { onResult, onEnd, onError } = {}) {
    if (isListening) stopListening();
    
    // Web Speech API does not work on file:/// in Chrome/Edge.
    if (window.location.protocol === 'file:') {
      onError?.('file_protocol_blocked');
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { onError?.('not_supported'); return; }
    recognition = new SR();
    recognition.lang = LANG_CODES[langKey] || 'en-IN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;

    recognition.onresult = (e) => {
      let interim = '', final_ = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final_ += t; else interim += t;
      }
      onResult?.({ interim, final: final_, isFinal: !!final_ });
    };
    recognition.onend = () => { isListening = false; onEnd?.(); };
    recognition.onerror = (e) => { isListening = false; onError?.(e.error); };
    try { recognition.start(); isListening = true; }
    catch (e) { onError?.(e.message); }
  }

  function stopListening() { if (recognition && isListening) { recognition.stop(); isListening = false; } }

  function speak(text, langKey, onDone) {
    if (!window.speechSynthesis) { onDone?.(); return; }
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = LANG_CODES[langKey] || 'en-IN';
    utt.rate = 0.88; utt.pitch = 1; utt.volume = 1;
    utt.onend = onDone; utt.onerror = onDone;
    window.speechSynthesis.speak(utt);
  }

  function cancel() { window.speechSynthesis?.cancel(); }

  return { supported, startListening, stopListening, speak, cancel };
})();

// ═══════════════════════════════════════════════════════════
// 8. TRANSLATIONS
// ═══════════════════════════════════════════════════════════
const LANG = {
  en: {
    greeting: 'Where would you like to go?',
    greetingSub: 'Speak or type your destination',
    whereAmI: 'Where am I?', whereAmISub: 'Find nearby bus stops',
    tapSpeak: 'TAP TO SPEAK',
    listening: '🔴 Listening… speak now',
    iHeard: 'I heard:', correct: '✓ Correct', tryAgain: '↺ Try Again',
    orType: 'OR TYPE',
    fromLbl: '🟢 FROM', toLbl: '🔴 TO',
    fromPh: 'Boarding stop…', toPh: 'Destination…',
    findBtn: 'Find My Bus →', searching: 'Finding your bus…',
    quickLabel: 'Quick routes',
    yourJourney: 'Your Journey',
    boardAt: 'BOARD AT', exitAt: 'GET DOWN AT',
    fareLbl: 'ESTIMATED FARE', stagesLbl: 'FARE STAGES',
    operatorLbl: 'OPERATOR', typeLbl: 'SERVICE',
    transfer: 'With Transfer', transferAt: 'Transfer at',
    fareNote: 'Fare shown is an estimate based on KSRTC stage data. Actual fare may vary.',
    hearDirections: 'Hear Directions', startJourney: '▶ Start Journey', newSearch: '↺ New Search',
    journeyMode: 'Journey Mode', distRemaining: 'remaining',
    alertTitle: 'Destination Alerts',
    alert1km: '1 km before — destination is 1 km away',
    alert500m: '500 m before — prepare to get down',
    alert150m: 'Next stop — get ready to exit',
    speakNow: 'Read Instructions', endJourney: '■ End Journey',
    arrived: "You've Arrived!", arrivedSub: 'Your journey is complete.',
    noMic: 'Voice input not supported in this browser. Please type your journey.',
    notFound: 'No route found between these stops. Try nearby stops.',
    sameStop: 'Your boarding stop and destination are the same!',
    gpsError: 'Could not get your location. Please check GPS permissions.',
    noGps: 'GPS not supported on this device.',
    unknownDest: "I couldn't find that destination. Try a nearby stop name.",
    nearbyStops: 'Nearby Bus Stops',
    useAsFrom: 'Board here',
    offlineMode: '✅ Offline — route & fare data cached locally',
    changeLang: 'Language',
    speakDirect: 'Take bus {bus} from {from}. Get down at {to}. Estimated fare {fare} rupees.',
    speakTransfer: 'Take bus {bus1} from {from} to {transfer}. Then take bus {bus2} to {to}.',
    speak1km: 'Your destination is 1 kilometre away.',
    speak500m: '{stop} is 500 metres away. Please prepare to get down.',
    speak150m: 'Your destination is approaching. Get ready to exit.',
    speakArrived: 'You have arrived at {stop}. Journey complete.',
    locating: '📡 Locating you…', gpsActive: '📡 GPS active',
    frequency: 'Frequency', everyMins: 'Every {n} mins',
    backToHome: '← Back',
  },
  ml: {
    greeting: 'എവിടെ പോകണം?',
    greetingSub: 'ഗന്തവ്യം ടൈപ്പ് ചെയ്യൂ അല്ലെങ്കിൽ പറയൂ',
    whereAmI: 'ഞാൻ എവിടെ?', whereAmISub: 'സമീപ ബസ് സ്‌റ്റോപ്പ് കണ്ടെത്തൂ',
    tapSpeak: 'ടാപ്പ് ചെയ്ത് സംസാരിക്കൂ',
    listening: '🔴 കേൾക്കുന്നു… സംസാരിക്കൂ',
    iHeard: 'ഞാൻ കേട്ടത്:', correct: '✓ ശരി', tryAgain: '↺ വീണ്ടും ശ്രമിക്കൂ',
    orType: 'അല്ലെങ്കിൽ ടൈപ്പ് ചെയ്യൂ',
    fromLbl: '🟢 നിന്ന്', toLbl: '🔴 ലേക്ക്',
    fromPh: 'തുടക്ക സ്ഥലം…', toPh: 'ഗന്തവ്യം…',
    findBtn: 'ബസ് കണ്ടെത്തൂ →', searching: 'ബസ് തിരയുന്നു…',
    quickLabel: 'ഉദാഹരണ റൂട്ടുകൾ',
    yourJourney: 'നിങ്ങളുടെ യാത്ര',
    boardAt: 'കയറുന്ന സ്ഥലം', exitAt: 'ഇറങ്ങുന്ന സ്ഥലം',
    fareLbl: 'ഏകദേശ ചാർജ്', stagesLbl: 'ഫെയർ സ്റ്റേജ്',
    operatorLbl: 'ഓപ്പറേറ്റർ', typeLbl: 'സർവ്വീസ്',
    transfer: 'ബസ് മാറ്റം', transferAt: 'ഇവിടെ ബസ് മാറൂ',
    fareNote: 'ഇവിടെ കാണിക്കുന്ന ചാർജ് ഒരു ഏകദേശ കണക്ക് മാത്രം.',
    hearDirections: 'നിർദ്ദേശങ്ങൾ കേൾക്കൂ', startJourney: '▶ യാത്ര ആരംഭിക്കൂ', newSearch: '↺ പുതിയ തിരയൽ',
    journeyMode: 'യാത്ര മോഡ്', distRemaining: 'ബാക്കി',
    alertTitle: 'ഗന്തവ്യ അലേർട്ടുകൾ',
    alert1km: '1 കി.മീ മുൻപ് — ഗന്തവ്യം 1 കി.മീ അകലെ',
    alert500m: '500 മി. മുൻപ് — ഇറങ്ങാൻ തയ്യാറാകൂ',
    alert150m: 'അടുത്ത സ്‌റ്റോപ്പ് — ഇറങ്ങാൻ ഒരുങ്ങൂ',
    speakNow: 'നിർദ്ദേശം കേൾക്കൂ', endJourney: '■ യാത്ര അവസാനിപ്പിക്കൂ',
    arrived: 'നിങ്ങൾ എത്തി!', arrivedSub: 'യാത്ര പൂർത്തിയായി.',
    noMic: 'ഈ ബ്രൗസറിൽ വോയ്സ് ഇൻപുട്ട് ലഭ്യമല്ല.',
    notFound: 'ഈ സ്‌റ്റോപ്പുകൾക്കിടയിൽ റൂട്ട് കണ്ടെത്തിയില്ല.',
    sameStop: 'കയറുന്ന സ്ഥലവും ഇറങ്ങുന്ന സ്ഥലവും ഒന്നുതന്നെ!',
    gpsError: 'ലൊക്കേഷൻ ലഭ്യമല്ല. GPS അനുമതി പരിശോധിക്കൂ.',
    noGps: 'ഈ ഉപകരണത്തിൽ GPS ലഭ്യമല്ല.',
    unknownDest: 'ഈ ഗന്തവ്യം കണ്ടെത്തിയില്ല. മറ്റൊരു പേര് ശ്രമിക്കൂ.',
    nearbyStops: 'സമീപ ബസ് സ്‌റ്റോപ്പുകൾ',
    useAsFrom: 'ഇവിടെ നിന്ന് കയറൂ',
    offlineMode: '✅ ഓഫ്‌ലൈൻ — ഡേറ്റ ലോക്കൽ ആയി സേവ് ചെയ്തിരിക്കുന്നു',
    changeLang: 'ഭാഷ',
    speakDirect: '{from} ൽ നിന്ന് ബസ് {bus} എടുക്കൂ. {to} ൽ ഇറങ്ങൂ. ഏകദേശ ചാർജ് {fare} രൂപ.',
    speakTransfer: '{from} ൽ നിന്ന് ബസ് {bus1} എടുക്കൂ. {transfer} ൽ ബസ് {bus2} ലേക്ക് മാറൂ.',
    speak1km: 'നിങ്ങളുടെ ഗന്തവ്യം 1 കിലോമീറ്റർ അകലെ.',
    speak500m: '{stop} 500 മീറ്റർ അകലെ. ഇറങ്ങാൻ തയ്യാറാകൂ.',
    speak150m: 'ഗന്തവ്യം അടുക്കുന്നു. ഇറങ്ങാൻ ഒരുങ്ങൂ.',
    speakArrived: 'നിങ്ങൾ {stop} ൽ എത്തി. യാത്ര പൂർത്തിയായി.',
    locating: '📡 ലൊക്കേഷൻ കണ്ടെത്തുന്നു…', gpsActive: '📡 GPS സജ്ജം',
    frequency: 'ഇടവേള', everyMins: 'ഓരോ {n} മിനിറ്റ്',
    backToHome: '← തിരികെ',
  },
  hi: {
    greeting: 'आप कहाँ जाना चाहते हैं?',
    greetingSub: 'बोलें या टाइप करें',
    whereAmI: 'मैं कहाँ हूँ?', whereAmISub: 'पास के बस स्टॉप खोजें',
    tapSpeak: 'बोलने के लिए टैप करें',
    listening: '🔴 सुन रहा हूँ… बोलिए',
    iHeard: 'मैंने सुना:', correct: '✓ सही है', tryAgain: '↺ फिर से',
    orType: 'या टाइप करें',
    fromLbl: '🟢 कहाँ से', toLbl: '🔴 कहाँ जाना है',
    fromPh: 'शुरुआत का स्टॉप…', toPh: 'मंजिल…',
    findBtn: 'बस खोजें →', searching: 'बस खोजा जा रहा है…',
    quickLabel: 'लोकप्रिय रास्ते',
    yourJourney: 'आपकी यात्रा',
    boardAt: 'कहाँ चढ़ें', exitAt: 'कहाँ उतरें',
    fareLbl: 'अनुमानित किराया', stagesLbl: 'किराया चरण',
    operatorLbl: 'संचालक', typeLbl: 'सेवा',
    transfer: 'बस बदलें', transferAt: 'यहाँ बस बदलें',
    fareNote: 'यह किराया केवल अनुमानित है। वास्तविक किराया थोड़ा भिन्न हो सकता है।',
    hearDirections: 'निर्देश सुनें', startJourney: '▶ यात्रा शुरू करें', newSearch: '↺ नई खोज',
    journeyMode: 'यात्रा मोड', distRemaining: 'बचा है',
    alertTitle: 'गंतव्य अलर्ट',
    alert1km: '1 किमी पहले — गंतव्य 1 किमी दूर है',
    alert500m: '500 मी पहले — उतरने के लिए तैयार रहें',
    alert150m: 'अगला स्टॉप — उतरने के लिए तैयार हों',
    speakNow: 'निर्देश सुनें', endJourney: '■ यात्रा समाप्त करें',
    arrived: 'आप पहुँच गए!', arrivedSub: 'आपकी यात्रा पूरी हो गई।',
    noMic: 'इस ब्राउज़र में वॉयस इनपुट उपलब्ध नहीं। कृपया टाइप करें।',
    notFound: 'इन स्टॉप्स के बीच कोई रास्ता नहीं मिला।',
    sameStop: 'चढ़ने और उतरने का स्थान एक ही है!',
    gpsError: 'आपका स्थान नहीं मिल सका। GPS अनुमति जाँचें।',
    noGps: 'इस डिवाइस पर GPS उपलब्ध नहीं।',
    unknownDest: 'यह गंतव्य नहीं मिला। कोई नज़दीकी स्टॉप आज़माएं।',
    nearbyStops: 'पास के बस स्टॉप',
    useAsFrom: 'यहाँ से चढ़ें',
    offlineMode: '✅ ऑफलाइन — रूट और किराया डेटा स्थानीय रूप से सहेजा गया है',
    changeLang: 'भाषा',
    speakDirect: '{from} से बस {bus} लें। {to} पर उतरें। अनुमानित किराया {fare} रुपये।',
    speakTransfer: '{from} से बस {bus1} लें। {transfer} पर बस {bus2} लें।',
    speak1km: 'आपका गंतव्य लगभग 1 किलोमीटर दूर है।',
    speak500m: '{stop} लगभग 500 मीटर दूर है। उतरने के लिए तैयार रहें।',
    speak150m: 'आपका गंतव्य आ गया। उतरने के लिए तैयार हों।',
    speakArrived: 'आप {stop} पहुँच गए। यात्रा पूरी हुई।',
    locating: '📡 स्थान खोजा जा रहा है…', gpsActive: '📡 GPS सक्रिय',
    frequency: 'आवृत्ति', everyMins: 'हर {n} मिनट',
    backToHome: '← वापस',
  }
};

function t(key, lang, vars = {}) {
  let s = LANG[lang]?.[key] || LANG.en?.[key] || key;
  for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  return s;
}

// ═══════════════════════════════════════════════════════════
// 9. JOURNEY TRACKER (GPS destination alerts)
// ═══════════════════════════════════════════════════════════
const JourneyTracker = (() => {
  let watchId = null;
  let destStopId = null, destLat = null, destLon = null;
  let startDist = null;
  let fired1km = false, fired500m = false, fired150m = false;
  let onUpdateCb = null, onAlertCb = null, onArriveCb = null;
  let currentLang = 'en';

  function start(toStopId, lang, { onUpdate, onAlert, onArrive } = {}) {
    stop();
    destStopId = toStopId;
    currentLang = lang;
    onUpdateCb = onUpdate;
    onAlertCb = onAlert;
    onArriveCb = onArrive;
    fired1km = fired500m = fired150m = false;
    startDist = null;

    const stop_ = DataLayer.getStop(toStopId);
    if (!stop_ || !stop_.lat) { onAlert?.({ level: 'error', msg: 'No coordinates for destination' }); return; }
    destLat = stop_.lat;
    destLon = stop_.lon;

    watchId = GeoEngine.watchPosition(
      (pos) => handlePositionUpdate(pos),
      (err) => console.warn('GPS watch error:', err)
    );
  }

  function handlePositionUpdate(pos) {
    const dist = GeoEngine.haversine(pos.lat, pos.lon, destLat, destLon);
    if (startDist === null) startDist = dist;

    onUpdateCb?.({ dist, startDist, pos });

    const stopName = DataLayer.getStopName(destStopId, currentLang);

    if (!fired1km && dist < 1100 && dist > 200) {
      fired1km = true;
      const msg = t('speak1km', currentLang);
      onAlertCb?.({ level: '1km', msg });
      SpeechModule.speak(msg, currentLang);
    }
    if (!fired500m && dist < 550 && dist > 100) {
      fired500m = true;
      const msg = t('speak500m', currentLang, { stop: stopName });
      onAlertCb?.({ level: '500m', msg });
      SpeechModule.speak(msg, currentLang);
      vibrate([300, 100, 300]);
    }
    if (!fired150m && dist < 180) {
      fired150m = true;
      const msg = t('speak150m', currentLang);
      onAlertCb?.({ level: '150m', msg });
      SpeechModule.speak(msg, currentLang);
      vibrate([200, 100, 200, 100, 500]);
    }
    if (dist < 80) {
      stop();
      const msg = t('speakArrived', currentLang, { stop: stopName });
      SpeechModule.speak(msg, currentLang);
      onArriveCb?.();
    }
  }

  function vibrate(pattern) {
    try { navigator.vibrate?.(pattern); } catch (e) {}
  }

  function stop() {
    GeoEngine.clearWatch(watchId);
    watchId = null;
  }

  return { start, stop };
})();

// ═══════════════════════════════════════════════════════════
// 10. UI CONTROLLER
// ═══════════════════════════════════════════════════════════
const UI = (() => {
  let lang = 'en';
  let resolvedFrom = null, resolvedTo = null;
  let lastJourney = null, lastJourneyFrom = null, lastJourneyTo = null;
  let isSpeaking = false;
  let sttFinalText = '';
  // ── Route selection state ─────────────────────────────────
  let selectedRouteIndex = -1;   // which card the user selected
  let activeJourney = null;      // locked journey object when tracking starts
  let journeySteps = [];         // flat ordered steps for the active journey
  let currentStepIndex = 0;      // which step the user is currently on

  const QUICK_ROUTES = [
    { from: 'ernakulam_ksrtc', to: 'alappuzha' },
    { from: 'vytilla', to: 'aluva' },
    { from: 'ernakulam_south', to: 'thrissur' },
    { from: 'aluva', to: 'kochi_airport' },
  ];

  const $ = id => document.getElementById(id);

  // ── Screen navigation ───────────────────────────────────
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
    window.scrollTo(0, 0);
  }

  // ── Language ─────────────────────────────────────────────
  function setLang(l) {
    lang = l;
    document.documentElement.lang = l;
    applyTranslations();
  }

  function applyTranslations() {
    safe('greetingBig', t('greeting', lang));
    safe('greetingSmall', t('greetingSub', lang));
    safe('gpsLabel', t('whereAmI', lang));
    safe('gpsSub', t('whereAmISub', lang));
    safe('micHint', t('tapSpeak', lang));
    safe('orText', t('orType', lang));
    safe('fromLbl', t('fromLbl', lang));
    safe('toLbl', t('toLbl', lang));
    safeAttr('fromInput', 'placeholder', t('fromPh', lang));
    safeAttr('toInput', 'placeholder', t('toPh', lang));
    safe('findBtnText', t('findBtn', lang));
    safe('quickLabel', t('quickLabel', lang));
    safe('searchingText', t('searching', lang));
    safe('resultHeaderTitle', t('yourJourney', lang));
    safe('fareNoteText', t('fareNote', lang));
    safe('speakResultTxt', t('hearDirections', lang));
    safe('startJourneyTxt', t('startJourney', lang));
    safe('newSearchTxt', t('newSearch', lang));
    safe('journeyHeaderTitle', t('journeyMode', lang));
    safe('jpFromLabel', t('boardAt', lang));
    safe('jpToLabel', t('exitAt', lang));
    safe('alertLogTitle', t('alertTitle', lang));
    safe('alert1kmText', t('alert1km', lang));
    safe('alert500mText', t('alert500m', lang));
    safe('alert150mText', t('alert150m', lang));
    safe('speakNowTxt', t('speakNow', lang));
    safe('endJourneyTxt', t('endJourney', lang));
    safe('arrivalTitle', t('arrived', lang));
    safe('sttHeardLabel', t('iHeard', lang));
    safe('sttConfirmBtn', t('correct', lang));
    safe('sttRetryBtn', t('tryAgain', lang));
    safe('gpsStatusLabel', t('locating', lang));
    buildQuickChips();
  }

  function safe(id, text) { const el = $(id); if (el) el.textContent = text; }
  function safeAttr(id, attr, val) { const el = $(id); if (el) el.setAttribute(attr, val); }

  // ── Quick Chips ──────────────────────────────────────────
  function buildQuickChips() {
    const container = $('quickChips');
    if (!container) return;
    container.innerHTML = '';
    for (const r of QUICK_ROUTES) {
      const fn = DataLayer.getStopName(r.from, lang);
      const tn = DataLayer.getStopName(r.to, lang);
      const btn = document.createElement('button');
      btn.className = 'quick-chip';
      btn.textContent = `${fn} → ${tn}`;
      btn.onclick = () => {
        $('fromInput').value = formatStopName(r.from);
        $('toInput').value = formatStopName(r.to);
        resolvedFrom = r.from; resolvedTo = r.to;
        runSearch();
      };
      container.appendChild(btn);
    }
  }

  // ── Helpers ──────────────────────────────────────────────
  function formatStopName(stopId) {
    const s = DataLayer.getStop(stopId);
    if (!s) return '';
    const name = s[lang] || s.en;
    if (lang === 'en' && s.ml) return `${name} (${s.ml})`;
    return name;
  }

  // ── Autocomplete ─────────────────────────────────────────
  function initAutocomplete(inputId, dropId, onSelect) {
    const input = $(inputId), drop = $(dropId);
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      drop.innerHTML = '';
      if (q.length < 1) { drop.classList.remove('open'); return; }
      const matches = DataLayer.getAllStops()
        .filter(s => [s.en, s.ml, s.hi, s.id].some(n => n && n.toLowerCase().includes(q)))
        .slice(0, 8);
      if (!matches.length) { drop.classList.remove('open'); return; }
      for (const s of matches) {
        const item = document.createElement('div');
        item.className = 'dd-item';
        const nameText = lang === 'en' && s.ml ? `${s[lang] || s.en} <span style="color:#6b7280;font-size:.85rem;">(${s.ml})</span>` : (s[lang] || s.en);
        item.innerHTML = `<span class="dd-name">${nameText}</span><span class="dd-sub">${s.landmark ? (s.landmark[lang] || s.landmark.en) : ''}</span>`;
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          input.value = formatStopName(s.id);
          onSelect(s.id);
          drop.classList.remove('open');
        });
        drop.appendChild(item);
      }
      drop.classList.add('open');
    });
    input.addEventListener('blur', () => setTimeout(() => drop.classList.remove('open'), 150));
  }

  // ── GPS "Where Am I?" (Smart: shows best boarding stop if destination known) ─
  async function handleGPS() {
    const btn = $('gpsBtn');
    const result = $('gpsResult');
    btn.style.opacity = '.6';
    safe('gpsLabel', t('locating', lang));
    try {
      const pos = await GeoEngine.getCurrentPosition();
      const hasDestination = !!(resolvedTo || $('toInput').value.trim());

      let stops, headerLabel;
      if (hasDestination && resolvedTo) {
        // SMART MODE: show stops that actually serve the destination bus
        stops = GeoEngine.getBestBoardingStops(pos.lat, pos.lon, resolvedTo, 4);
        const destName = DataLayer.getStopName(resolvedTo, lang);
        headerLabel = `Best boarding for ${destName}`;
      } else {
        // BASIC MODE: show nearest stops
        stops = GeoEngine.getNearestStops(pos.lat, pos.lon, 4);
        headerLabel = t('nearbyStops', lang);
      }

      safe('gpsLabel', headerLabel);
      safe('gpsSub', pos.accuracy ? `GPS accuracy: ${Math.round(pos.accuracy)} m` : '');
      result.innerHTML = '';

      if (!stops.length) {
        result.innerHTML = `<div style="padding:.75rem 1rem;font-size:.85rem;color:#9ca3af;">No stops found nearby.</div>`;
        result.classList.add('open');
        return;
      }

      for (const stop of stops) {
        const distStr = GeoEngine.formatDistance(stop.distance);
        const walkMin = GeoEngine.walkingMinutes(stop.distance);
        const isBest = stops.indexOf(stop) === 0;
        const dirUrl = `https://www.google.com/maps/dir/?api=1&origin=${pos.lat},${pos.lon}&destination=${stop.lat},${stop.lon}&travelmode=walking`;
        
        const item = document.createElement('div');
        item.className = 'gps-stop-item';
        item.innerHTML = `
          <div class="gps-stop-dot" style="${isBest ? 'background:#16a34a;' : ''}"></div>
          <div style="flex:1;">
            <div class="gps-stop-name">
              ${stop[lang] || stop.en}
              ${isBest && hasDestination ? '<span style="font-size:.65rem;background:#dcfce7;color:#16a34a;padding:.1rem .4rem;border-radius:10px;margin-left:.4rem;font-weight:700;">BEST</span>' : ''}
            </div>
            <div class="gps-stop-dist">
              ${distStr} · ~${walkMin} min walk
              <a href="${dirUrl}" target="_blank" style="margin-left:0.5rem;color:#2563eb;text-decoration:underline;font-size:0.75rem;">Get Directions</a>
            </div>
          </div>
          <button class="gps-use-btn">${t('useAsFrom', lang)}</button>
        `;
        item.querySelector('.gps-use-btn').onclick = () => {
          $('fromInput').value = formatStopName(stop.id);
          resolvedFrom = stop.id;
          result.classList.remove('open');
          safe('gpsLabel', t('whereAmI', lang));
          safe('gpsSub', t('whereAmISub', lang));
          if (resolvedFrom && resolvedTo) setTimeout(runSearch, 300);
          else $('toInput').focus();
        };
        result.appendChild(item);
      }
      result.classList.add('open');
    } catch (e) {
      const msg = e.message === 'no_geolocation' ? t('noGps', lang) : t('gpsError', lang);
      showError(msg);
    } finally {
      btn.style.opacity = '1';
    }
  }


  // ── Mic / STT ────────────────────────────────────────────
  let isListening = false;

  function handleMic() {
    if (isListening) { SpeechModule.stopListening(); setMicState(false); return; }
    if (!SpeechModule.supported) { showError(t('noMic', lang)); return; }
    sttFinalText = '';
    setMicState(true);
    hideSttConfirm();

    SpeechModule.startListening(lang, {
      onResult: ({ interim, final: fin, isFinal }) => {
        if (isFinal && fin) {
          sttFinalText = fin;
          setMicState(false);
          showSttConfirm(fin);
        } else {
          safe('micStatusHome', interim || t('listening', lang));
        }
      },
      onEnd: () => setMicState(false),
      onError: (err) => {
        setMicState(false);
        if (err === 'file_protocol_blocked') {
          showError('Microphone blocked on local files. Run "python -m http.server" or type manually.');
        } else if (err !== 'no-speech') {
          showError(t('noMic', lang));
        }
      }
    });
  }

  function setMicState(on) {
    isListening = on;
    $('micBtnHome').classList.toggle('listening', on);
    $('micStatusHome').classList.toggle('active', on);
    $('micStatusHome').textContent = on ? t('listening', lang) : '';
  }

  function showSttConfirm(text) {
    safe('sttTranscript', text);
    $('sttConfirm').classList.add('visible');
  }

  function hideSttConfirm() { $('sttConfirm').classList.remove('visible'); }

  function confirmSTT() {
    hideSttConfirm();
    if (!sttFinalText) return;
    const parsed = IntentParser.parse(sttFinalText);
    console.info('[Voice Pipeline] STT →', sttFinalText, '→ Parsed:', parsed);
    if (parsed.detectedLang && parsed.detectedLang !== lang) setLang(parsed.detectedLang);
    if (parsed.fromStop) { resolvedFrom = parsed.fromStop; $('fromInput').value = formatStopName(parsed.fromStop); }
    if (parsed.toStop) { resolvedTo = parsed.toStop; $('toInput').value = formatStopName(parsed.toStop); }
    if (parsed.fromStop && parsed.toStop) { setTimeout(runSearch, 300); }
    else if (parsed.toStop && !parsed.fromStop) { $('fromInput').focus(); }
    else { showError(t('unknownDest', lang)); }
  }

  // ── Search ───────────────────────────────────────────────
  async function runSearch() {
    if (!resolvedFrom && $('fromInput').value.trim())
      resolvedFrom = IntentParser.fuzzyMatchStop($('fromInput').value.trim(), lang);
    if (!resolvedTo && $('toInput').value.trim())
      resolvedTo = IntentParser.fuzzyMatchStop($('toInput').value.trim(), lang);

    // Auto-GPS boarding: if FROM is empty but destination is set, try GPS
    if (!resolvedFrom && resolvedTo) {
      try {
        const pos = await GeoEngine.getCurrentPosition();
        const boarding = GeoEngine.getBestBoardingStops(pos.lat, pos.lon, resolvedTo, 1);
        if (boarding.length > 0) {
          resolvedFrom = boarding[0].id;
          $('fromInput').value = formatStopName(resolvedFrom);
          console.info('[GPS Auto-Board] Selected:', resolvedFrom, 'dist:', Math.round(boarding[0].distance), 'm');
        }
      } catch (_) { /* GPS unavailable, fall through to error */ }
    }

    if (!resolvedFrom || !resolvedTo) { showError('Please enter both boarding stop and destination.'); return; }
    if (resolvedFrom === resolvedTo) { showError(t('sameStop', lang)); return; }

    hideError();
    showLoading(true);
    console.info('[RouteEngine] Searching:', resolvedFrom, '→', resolvedTo);

    setTimeout(() => {
      const journey = RouteEngine.findJourney(resolvedFrom, resolvedTo);
      showLoading(false);
      console.info('[RouteEngine] Result:', journey?.length, 'options, type:', journey?.[0]?.type);
      if (!journey || journey.length === 0 || journey[0]?.type === 'not_found') { showError(t('notFound', lang)); return; }
      if (journey[0]?.type === 'same_stop') { showError(t('sameStop', lang)); return; }

      lastJourney = journey;
      lastJourneyFrom = resolvedFrom;
      lastJourneyTo = resolvedTo;
      // Reset selection on new search
      selectedRouteIndex = -1;
      activeJourney = null;
      _updateStickyBar();
      renderResult(journey);
      showScreen('screenResult');
    }, 350);
  }

  // ── Result Rendering ─────────────────────────────────────
  function generateScheduleText(freqMins) {
    if (!freqMins) return '';
    const now = new Date();
    const minOffset = (now.getMinutes() % Math.max(1, freqMins - 5)) + 2;
    const nextTime = new Date(now.getTime() + minOffset * 60000);
    const timeStr = nextTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${t('everyMins', lang, { n: freqMins })} (Next: ~${timeStr})`;
  }

  // Build the sticky bottom bar state
  function _updateStickyBar() {
    const bar = $('stickyJourneyBar');
    const btn = $('startJourneyBtn');
    const info = $('sjbSelectedInfo');
    if (!bar) return;
    if (selectedRouteIndex < 0 || !lastJourney) {
      bar.classList.remove('active');
      if (btn) btn.disabled = true;
      if (info) info.textContent = 'Select a route below to start';
      return;
    }
    bar.classList.add('active');
    if (btn) btn.disabled = false;
    const sel = lastJourney[selectedRouteIndex];
    if (!sel) return;
    let summary = '';
    if (sel.type === 'direct') {
      summary = `🚌 Bus ${sel.route.number} • Direct`;
    } else if (sel.type === 'transfer') {
      summary = `🔄 Bus ${sel.route1.number} → ${sel.route2.number} • 1 Transfer`;
    } else if (sel.type === 'multi_transfer') {
      summary = `🔄 Bus ${sel.route1.number} → ${sel.route2.number} → ${sel.route3.number} • 2 Transfers`;
    }
    if (info) info.textContent = summary;
  }

  // Select a route card — called when user taps "Select this route"
  function selectRoute(idx) {
    selectedRouteIndex = idx;
    // Update card visuals
    document.querySelectorAll('.route-option-card').forEach((card, i) => {
      card.classList.toggle('selected-route', i === idx);
      const btn = card.querySelector('.select-route-btn');
      if (btn) btn.textContent = i === idx ? 'Selected ✓' : 'Select this route';
      btn?.classList.toggle('selected', i === idx);
    });
    _updateStickyBar();
  }

  function renderResult(journeys) {
    const container = $('resultMain');
    container.innerHTML = '';
    const fromName = DataLayer.getStopName(resolvedFrom, lang);
    const toName = DataLayer.getStopName(resolvedTo, lang);
    const landmark = DataLayer.getLandmark(resolvedTo, lang);

    journeys.forEach((journey, idx) => {
      const isTopOption = idx === 0;
      let cardHtml = '';
      if (journey.type === 'direct') {
        const r = journey.route;
        const fare = FareEngine.estimateFare(r.id, resolvedFrom, resolvedTo);
        cardHtml = buildDirectCard(r, fromName, toName, landmark, fare, resolvedFrom, resolvedTo, isTopOption, idx);
      } else if (journey.type === 'transfer') {
        cardHtml = buildTransferCard(journey, fromName, toName, landmark, isTopOption, idx);
      } else if (journey.type === 'multi_transfer') {
        cardHtml = buildMultiTransferCard(journey, fromName, toName, landmark, isTopOption, idx);
      }
      container.innerHTML += cardHtml;
    });

    // Attach select-button listeners after DOM insert
    container.querySelectorAll('.select-route-btn').forEach(btn => {
      btn.addEventListener('click', () => selectRoute(parseInt(btn.dataset.idx, 10)));
    });

    safe('fareNoteText', t('fareNote', lang));
    safe('resultHeaderTitle', t('yourJourney', lang));
    _updateStickyBar();
  }

  function buildDirectCard(route, fromName, toName, landmark, fare, fromId, toId, isTopOption, cardIdx) {
    const fi = route.stops.indexOf(fromId);
    const ti = route.stops.indexOf(toId);
    const stopsInBetween = route.stops.slice(fi, ti + 1);

    let timelineHtml = '';
    for (let i = 0; i < stopsInBetween.length; i++) {
      const cls = i === 0 ? 'start' : i === stopsInBetween.length - 1 ? 'end' : 'mid';
      const bold = cls !== 'mid' ? ' bold' : '';
      const showLine = i < stopsInBetween.length - 1;
      timelineHtml += `
        <div class="tl-item">
          <div style="position:relative;display:flex;flex-direction:column;align-items:center;width:18px;">
            <div class="tl-dot ${cls}"></div>
            ${showLine ? '<div class="tl-line"></div>' : ''}
          </div>
          <span class="tl-stop-name${bold}">${DataLayer.getStopName(stopsInBetween[i], lang)}</span>
        </div>`;
    }

    return `
      <div class="route-option-card result-card-inner" data-idx="${cardIdx}" style="${isTopOption ? 'border: 2px solid var(--accent);' : 'margin-top: 1rem; opacity: 0.95;'}">
        ${isTopOption ? '<div style="background:var(--accent);color:white;font-size:0.75rem;font-weight:700;text-align:center;padding:4px;border-radius:10px 10px 0 0;margin:-1rem -1rem 1rem -1rem;">RECOMMENDED OPTION</div>' : ''}
        <div class="rc-head">
          <span class="rc-bus-badge">🚌 Bus ${route.number}</span>
          <span class="rc-type">${route.operator} · ${route.type}</span>
        </div>
        <div class="rc-rows">
          <div class="rc-row">
            <span class="rc-icon">🟢</span>
            <div><div class="rc-lbl">${t('boardAt', lang)}</div><div class="rc-val">${fromName}</div></div>
          </div>
          <div class="rc-row">
            <span class="rc-icon">🔴</span>
            <div>
              <div class="rc-lbl">${t('exitAt', lang)}</div>
              <div class="rc-val">${toName}</div>
              ${landmark ? `<div class="rc-landmark">${landmark}</div>` : ''}
            </div>
          </div>
          ${fare ? `
          <div class="rc-row">
            <span class="rc-icon">🎫</span>
            <div><div class="rc-lbl">${t('stagesLbl', lang)}</div><div class="rc-val">${fare.stages} stage${fare.stages !== 1 ? 's' : ''}</div></div>
          </div>
          <div class="rc-row">
            <span class="rc-icon">💰</span>
            <div><div class="rc-lbl">${t('fareLbl', lang)}</div><div class="rc-fare">${fare.isEstimate ? '≈ ' : ''}₹${fare.fare_min}–₹${fare.fare_max}${fare.isEstimate ? ' <span style="font-size:.7rem;color:var(--text3);font-weight:400;">(distance estimate)</span>' : ''}</div></div>
          </div>` : ''}
          <div class="rc-row">
            <span class="rc-icon">⏱️</span>
            <div><div class="rc-lbl">${t('frequency', lang)}</div><div class="rc-val">${generateScheduleText(route.frequency_mins)}</div></div>
          </div>
        </div>
        <div class="stop-timeline">${timelineHtml}</div>
        <button class="select-route-btn" data-idx="${cardIdx}">Select this route</button>
      </div>`;
  }

  function buildTransferCard(journey, fromName, toName, landmark, isTopOption, cardIdx) {
    const { route1, route2, transferStop } = journey;
    const transferName = DataLayer.getStopName(transferStop, lang);
    const fare1 = FareEngine.estimateFare(route1.id, resolvedFrom, transferStop);
    const fare2 = FareEngine.estimateFare(route2.id, transferStop, resolvedTo);
    const totalMin = (fare1?.fare_min || 0) + (fare2?.fare_min || 0);
    const totalMax = (fare1?.fare_max || 0) + (fare2?.fare_max || 0);

    return `
      <div class="route-option-card transfer-card" data-idx="${cardIdx}" style="${isTopOption ? '' : 'margin-top: 1rem; opacity: 0.95;'}">
        ${isTopOption ? '<div style="background:#6b7280;color:white;font-size:0.75rem;font-weight:700;text-align:center;padding:4px;border-radius:10px 10px 0 0;margin:-1rem -1rem 1rem -1rem;">RECOMMENDED OPTION</div>' : ''}
        <div style="margin-bottom:.75rem;">
          <span class="rc-bus-badge" style="background:#6b7280;">🔄 ${t('transfer', lang)} (1 Stop)</span>
        </div>
        <div class="transfer-step">
          <div class="transfer-num">1</div>
          <div style="flex:1;">
            <strong>Bus ${route1.number}</strong> <span style="font-size:.8rem;color:#6b7280;">(Every ${route1.frequency_mins} mins)</span><br>
            <span style="font-size:.85rem;color:#4b5563;">${fromName} → ${transferName}</span>
            ${fare1 ? `<br><span style="font-size:.78rem;color:#9ca3af;">₹${fare1.fare_min}–₹${fare1.fare_max}</span>` : ''}
          </div>
        </div>
        <div class="transfer-connector">${t('transferAt', lang)}: <strong>${transferName}</strong></div>
        <div class="transfer-step">
          <div class="transfer-num">2</div>
          <div style="flex:1;">
            <strong>Bus ${route2.number}</strong> <span style="font-size:.8rem;color:#6b7280;">(Every ${route2.frequency_mins} mins)</span><br>
            <span style="font-size:.85rem;color:#4b5563;">${transferName} → ${toName}</span>
            ${fare2 ? `<br><span style="font-size:.78rem;color:#9ca3af;">₹${fare2.fare_min}–₹${fare2.fare_max}</span>` : ''}
          </div>
        </div>
        <div style="padding-top:.75rem;border-top:1px solid #e5e7eb;margin-top:.5rem;">
          <div class="rc-lbl">${t('fareLbl', lang)} (Total)</div>
          <div class="transfer-fare-total">₹${totalMin}–₹${totalMax}</div>
        </div>
        <button class="select-route-btn" data-idx="${cardIdx}">Select this route</button>
      </div>`;
  }

  function buildMultiTransferCard(journey, fromName, toName, landmark, isTopOption, cardIdx) {
    const { route1, transferStop1, route2, transferStop2, route3 } = journey;
    const tn1 = DataLayer.getStopName(transferStop1, lang);
    const tn2 = DataLayer.getStopName(transferStop2, lang);
    
    const fare1 = FareEngine.estimateFare(route1.id, resolvedFrom, transferStop1);
    const fare2 = FareEngine.estimateFare(route2.id, transferStop1, transferStop2);
    const fare3 = FareEngine.estimateFare(route3.id, transferStop2, resolvedTo);
    const totalMin = (fare1?.fare_min || 0) + (fare2?.fare_min || 0) + (fare3?.fare_min || 0);
    const totalMax = (fare1?.fare_max || 0) + (fare2?.fare_max || 0) + (fare3?.fare_max || 0);

    return `
      <div class="route-option-card transfer-card" data-idx="${cardIdx}" style="${isTopOption ? '' : 'margin-top: 1rem; opacity: 0.95;'}">
        ${isTopOption ? '<div style="background:#6b7280;color:white;font-size:0.75rem;font-weight:700;text-align:center;padding:4px;border-radius:10px 10px 0 0;margin:-1rem -1rem 1rem -1rem;">RECOMMENDED OPTION</div>' : ''}
        <div style="margin-bottom:.75rem;">
          <span class="rc-bus-badge" style="background:#6b7280;">🔄 ${t('transfer', lang)} (2 Stops)</span>
        </div>
        <div class="transfer-step">
          <div class="transfer-num">1</div>
          <div style="flex:1;">
            <strong>Bus ${route1.number}</strong> <span style="font-size:.8rem;color:#6b7280;">(Every ${route1.frequency_mins} mins)</span><br>
            <span style="font-size:.85rem;color:#4b5563;">${fromName} → ${tn1}</span>
          </div>
        </div>
        <div class="transfer-connector">${t('transferAt', lang)}: <strong>${tn1}</strong></div>
        <div class="transfer-step">
          <div class="transfer-num">2</div>
          <div style="flex:1;">
            <strong>Bus ${route2.number}</strong> <span style="font-size:.8rem;color:#6b7280;">(Every ${route2.frequency_mins} mins)</span><br>
            <span style="font-size:.85rem;color:#4b5563;">${tn1} → ${tn2}</span>
          </div>
        </div>
        <div class="transfer-connector">${t('transferAt', lang)}: <strong>${tn2}</strong></div>
        <div class="transfer-step">
          <div class="transfer-num">3</div>
          <div style="flex:1;">
            <strong>Bus ${route3.number}</strong> <span style="font-size:.8rem;color:#6b7280;">(Every ${route3.frequency_mins} mins)</span><br>
            <span style="font-size:.85rem;color:#4b5563;">${tn2} → ${toName}</span>
          </div>
        </div>
        <div style="padding-top:.75rem;border-top:1px solid #e5e7eb;margin-top:.5rem;">
          <div class="rc-lbl">${t('fareLbl', lang)} (Total)</div>
          <div class="transfer-fare-total">₹${totalMin}–₹${totalMax}</div>
        </div>
        <button class="select-route-btn" data-idx="${cardIdx}">Select this route</button>
      </div>`;
  }

  // ── Speak Result (uses selected route, falls back to first) ──
  function speakResult() {
    if (!lastJourney || !lastJourney.length) return;
    if (isSpeaking) { SpeechModule.cancel(); setSpeak(false); return; }
    // Use the selected route, or fall back to #0
    const idx = selectedRouteIndex >= 0 ? selectedRouteIndex : 0;
    const journey = lastJourney[idx];
    if (!journey) return;
    const from = DataLayer.getStopName(lastJourneyFrom, lang);
    const to = DataLayer.getStopName(lastJourneyTo, lang);
    let text = '';
    if (journey.type === 'direct') {
      const fare = FareEngine.estimateFare(journey.route.id, lastJourneyFrom, lastJourneyTo);
      text = t('speakDirect', lang, { bus: journey.route.number, from, to, fare: fare ? Math.round((fare.fare_min + fare.fare_max) / 2) : '?' });
    } else if (journey.type === 'transfer') {
      const tn = DataLayer.getStopName(journey.transferStop, lang);
      text = t('speakTransfer', lang, { bus1: journey.route1.number, bus2: journey.route2.number, from, to, transfer: tn });
    } else if (journey.type === 'multi_transfer') {
      const tn1 = DataLayer.getStopName(journey.transferStop1, lang);
      const tn2 = DataLayer.getStopName(journey.transferStop2, lang);
      text = `Take bus ${journey.route1.number} from ${from} to ${tn1}. Transfer to bus ${journey.route2.number} towards ${tn2}. Then take bus ${journey.route3.number} to ${to}.`;
    }
    setSpeak(true);
    SpeechModule.speak(text, lang, () => setSpeak(false));
  }

  function setSpeak(on) {
    isSpeaking = on;
    const btn = $('speakResultBtn');
    if (!btn) return;
    btn.classList.toggle('speaking', on);
    safe('speakResultTxt', on ? t('speaking', lang) || '…' : t('hearDirections', lang));
  }

  // ── Build flat journey steps from a journey object ────────
  function buildJourneySteps(journey, fromId, toId) {
    const steps = [];
    if (journey.type === 'direct') {
      const fromName = DataLayer.getStopName(fromId, lang);
      const toName = DataLayer.getStopName(toId, lang);
      const fare = FareEngine.estimateFare(journey.route.id, fromId, toId);
      steps.push({ type: 'board',   bus: journey.route.number, stop: fromName, stopId: fromId });
      steps.push({ type: 'ride',    bus: journey.route.number, from: fromName, to: toName });
      steps.push({ type: 'alight',  bus: journey.route.number, stop: toName, stopId: toId,
                   fare: fare ? `₹${fare.fare_min}–₹${fare.fare_max}` : null });
    } else if (journey.type === 'transfer') {
      const fromName  = DataLayer.getStopName(fromId, lang);
      const transName = DataLayer.getStopName(journey.transferStop, lang);
      const toName    = DataLayer.getStopName(toId, lang);
      const fare1 = FareEngine.estimateFare(journey.route1.id, fromId, journey.transferStop);
      const fare2 = FareEngine.estimateFare(journey.route2.id, journey.transferStop, toId);
      steps.push({ type: 'board',    bus: journey.route1.number, stop: fromName, stopId: fromId });
      steps.push({ type: 'ride',     bus: journey.route1.number, from: fromName, to: transName });
      steps.push({ type: 'transfer', stop: transName, stopId: journey.transferStop,
                   nextBus: journey.route2.number,
                   fare: fare1 ? `₹${fare1.fare_min}–₹${fare1.fare_max}` : null });
      steps.push({ type: 'board',    bus: journey.route2.number, stop: transName, stopId: journey.transferStop });
      steps.push({ type: 'ride',     bus: journey.route2.number, from: transName, to: toName });
      steps.push({ type: 'alight',   bus: journey.route2.number, stop: toName, stopId: toId,
                   fare: fare2 ? `₹${fare2.fare_min}–₹${fare2.fare_max}` : null });
    } else if (journey.type === 'multi_transfer') {
      const fromName  = DataLayer.getStopName(fromId, lang);
      const tn1 = DataLayer.getStopName(journey.transferStop1, lang);
      const tn2 = DataLayer.getStopName(journey.transferStop2, lang);
      const toName    = DataLayer.getStopName(toId, lang);
      steps.push({ type: 'board',    bus: journey.route1.number, stop: fromName, stopId: fromId });
      steps.push({ type: 'ride',     bus: journey.route1.number, from: fromName, to: tn1 });
      steps.push({ type: 'transfer', stop: tn1, stopId: journey.transferStop1, nextBus: journey.route2.number });
      steps.push({ type: 'board',    bus: journey.route2.number, stop: tn1, stopId: journey.transferStop1 });
      steps.push({ type: 'ride',     bus: journey.route2.number, from: tn1, to: tn2 });
      steps.push({ type: 'transfer', stop: tn2, stopId: journey.transferStop2, nextBus: journey.route3.number });
      steps.push({ type: 'board',    bus: journey.route3.number, stop: tn2, stopId: journey.transferStop2 });
      steps.push({ type: 'ride',     bus: journey.route3.number, from: tn2, to: toName });
      steps.push({ type: 'alight',   bus: journey.route3.number, stop: toName, stopId: toId });
    }
    return steps;
  }

  function stepInstruction(step) {
    if (!step) return '—';
    switch (step.type) {
      case 'board':    return `Board Bus ${step.bus} at ${step.stop}`;
      case 'ride':     return `Travelling: ${step.from} → ${step.to} on Bus ${step.bus}`;
      case 'transfer': return `Get down at ${step.stop}. Transfer to Bus ${step.nextBus}`;
      case 'alight':   return `Get down at ${step.stop}${step.fare ? '. Fare: ' + step.fare : ''}`;
      default:         return '—';
    }
  }

  function renderJourneyStepsList(steps) {
    const el = $('journeyStepsList');
    if (!el) return;
    el.innerHTML = steps.map((s, i) => {
      const icon = { board: '🟢', ride: '🚌', transfer: '🔄', alight: '🔴' }[s.type] || '●';
      return `<div class="jsl-item" id="jslStep_${i}">
        <span class="jsl-icon">${icon}</span>
        <span class="jsl-text">${stepInstruction(s)}</span>
      </div>`;
    }).join('');
  }

  function updateCurrentStep(idx, steps) {
    safe('cscInstruction', stepInstruction(steps[idx]));
    safe('cscBusBadge', steps[idx]?.bus ? `🚌 Bus ${steps[idx].bus}` : '');
    const labelMap = { board: 'BOARD NOW', ride: 'ON THE BUS', transfer: 'TRANSFER HERE', alight: 'GET DOWN' };
    safe('cscStepLabel', labelMap[steps[idx]?.type] || 'CURRENT STEP');
    const next = steps[idx + 1];
    safe('nscInstruction', next ? stepInstruction(next) : 'You have arrived! ✅');
    // Highlight in list
    document.querySelectorAll('.jsl-item').forEach((el, i) => el.classList.toggle('active-step', i === idx));
  }

  // ── Journey Mode ─────────────────────────────────────────
  function startJourneyMode() {
    // Must have a selected route
    if (selectedRouteIndex < 0 || !lastJourney) {
      showError('Please select a route first before starting the journey.');
      return;
    }

    const journey = lastJourney[selectedRouteIndex];
    if (!journey) return;

    // Lock the active journey — do NOT recalculate
    activeJourney = {
      origin:      lastJourneyFrom,
      destination: lastJourneyTo,
      routeIndex:  selectedRouteIndex,
      journey,
      lang,
    };

    // Build flat ordered steps from local data only
    journeySteps = buildJourneySteps(journey, lastJourneyFrom, lastJourneyTo);
    currentStepIndex = 0;

    // Persist to localStorage so journey survives a page refresh
    try { localStorage.setItem('anavandi-active-journey', JSON.stringify(activeJourney)); } catch(_) {}

    // Set up journey screen
    const fromName = DataLayer.getStopName(lastJourneyFrom, lang);
    const toName   = DataLayer.getStopName(lastJourneyTo,   lang);
    safe('distNum', '—');
    safe('gpsStatusLabel', t('locating', lang));
    safe('gpsCoords', '');
    $('distBar').style.width = '100%';
    resetAlertItems();

    // Show offline pill
    const pill = $('journeyOfflinePill');
    if (pill) { pill.textContent = '📴 Offline Journey Mode'; pill.classList.add('active'); }

    // Render current step panel
    renderJourneyStepsList(journeySteps);
    updateCurrentStep(0, journeySteps);

    showScreen('screenJourney');

    // Start GPS tracking to final destination
    JourneyTracker.start(lastJourneyTo, lang, {
      onUpdate: ({ dist, startDist, pos }) => {
        const remaining = GeoEngine.formatDistance(dist);
        const [num, unit] = remaining.split(' ');
        safe('distNum', num);
        safe('distUnit', `${unit} ${t('distRemaining', lang)}`);
        const pct = startDist ? Math.max(0, Math.min(100, (dist / startDist) * 100)) : 100;
        $('distBar').style.width = `${pct}%`;
        safe('gpsStatusLabel', pos.accuracy <= 20  ? '📡 GPS — Excellent' :
                               pos.accuracy <= 60  ? '📡 GPS — Good' :
                               pos.accuracy <= 150 ? '📡 GPS — Fair' :
                                                     `📡 GPS — Weak (±${Math.round(pos.accuracy)}m)`);
        safe('gpsCoords', `±${Math.round(pos.accuracy ?? 999)}m accuracy · ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`);

        // Auto-advance steps: if we're near a transfer stop, move to next step
        _tryAdvanceStep(pos, dist);
      },
      onAlert: ({ level }) => fireAlert(level),
      onArrive: showArrival
    });
  }

  // Auto-advance step when near a transfer/alight stop
  function _tryAdvanceStep(pos, distToFinalDest) {
    if (!journeySteps.length || currentStepIndex >= journeySteps.length - 1) return;
    const step = journeySteps[currentStepIndex];
    // Check proximity to the step's stop
    if ((step.type === 'transfer' || step.type === 'alight') && step.stopId) {
      const stopData = DataLayer.getStop(step.stopId);
      if (stopData?.lat && stopData?.lon) {
        const d = GeoEngine.haversine(pos.lat, pos.lon, stopData.lat, stopData.lon);
        if (d < 200) { // within 200m of the transfer stop
          currentStepIndex++;
          updateCurrentStep(currentStepIndex, journeySteps);
          if (step.type === 'transfer') {
            SpeechModule.speak(`Transfer here. Take bus ${journeySteps[currentStepIndex]?.bus || ''}`, lang);
          }
        }
      }
    }
  }

  function resetAlertItems() {
    ['alertItem1km', 'alertItem500m', 'alertItem150m'].forEach(id => {
      $(id)?.classList.remove('fired');
      $(id)?.classList.add('pending');
    });
  }

  function fireAlert(level) {
    const map = { '1km': 'alertItem1km', '500m': 'alertItem500m', '150m': 'alertItem150m' };
    const el = $(map[level]);
    if (el) { el.classList.remove('pending'); el.classList.add('fired'); }
  }

  function showArrival() {
    const to = DataLayer.getStopName(lastJourneyTo, lang);
    safe('arrivalTitle', t('arrived', lang));
    safe('arrivalStop', to);
    safe('arrivalSub', t('arrivedSub', lang));
    $('arrivalOverlay').classList.add('visible');
  }

  function endJourney() {
    JourneyTracker.stop();
    SpeechModule.cancel();
    activeJourney = null;
    journeySteps = [];
    currentStepIndex = 0;
    try { localStorage.removeItem('anavandi-active-journey'); } catch(_) {}
    showScreen('screenHome');
    resolvedFrom = null; resolvedTo = null;
    $('fromInput').value = ''; $('toInput').value = '';
  }

  // ── Error / Loading ──────────────────────────────────────
  function showError(msg) {
    $('errorBar').classList.add('visible');
    safe('errorMsg', msg);
    setTimeout(() => $('errorBar').classList.remove('visible'), 5000);
  }
  function hideError() { $('errorBar').classList.remove('visible'); }
  function showLoading(on) {
    $('searchLoading').classList.toggle('visible', on);
    $('findBtnHome').disabled = on;
  }

  // ── Offline ──────────────────────────────────────────────
  function updateOffline() {
    const strip = $('offlineStrip');
    const note = $('langOfflineNote');
    const offline = !navigator.onLine;
    strip?.classList.toggle('visible', offline);
    if (offline) { strip.textContent = t('offlineMode', lang); }
    if (note) note.textContent = offline ? t('offlineMode', lang) : '✅ Works offline after first load';
  }

  // ── Init ─────────────────────────────────────────────────
  async function init() {
    const ok = await DataLayer.loadAll();
    if (!ok) {
      const err = DataLayer.getLoadError() || 'Unknown error';
      console.error('[Init] DataLayer failed:', err);
      showError(`Data load failed: ${err}. Some features may not work. Try refreshing.`);
      // Continue with degraded mode instead of blocking
    }

    // Screen 1: Language select
    document.querySelectorAll('.lang-option').forEach(btn => {
      btn.addEventListener('click', () => {
        setLang(btn.dataset.lang);
        showScreen('screenHome');
      });
    });

    // Header lang buttons
    ['changeLangBtn', 'changeLangResult'].forEach(id => {
      $(id)?.addEventListener('click', () => showScreen('screenLang'));
    });

    // Large text toggle
    $('largeTxtBtn')?.addEventListener('click', () => {
      document.body.classList.toggle('large-text');
      $('largeTxtBtn').classList.toggle('active');
    });

    // Dark/Light mode removed for branding

    // GPS
    $('gpsBtn').addEventListener('click', handleGPS);

    // Mic
    $('micBtnHome').addEventListener('click', handleMic);

    // STT confirm/retry
    $('sttConfirmBtn').addEventListener('click', confirmSTT);
    $('sttRetryBtn').addEventListener('click', () => { hideSttConfirm(); handleMic(); });

    // Inputs: clear resolved on manual edit
    $('fromInput').addEventListener('input', () => resolvedFrom = null);
    $('toInput').addEventListener('input', () => resolvedTo = null);

    // Autocomplete
    initAutocomplete('fromInput', 'fromDropdown', id => resolvedFrom = id);
    initAutocomplete('toInput', 'toDropdown', id => resolvedTo = id);

    // Swap
    $('swapBtn').addEventListener('click', () => {
      [resolvedFrom, resolvedTo] = [resolvedTo, resolvedFrom];
      [$('fromInput').value, $('toInput').value] = [$('toInput').value, $('fromInput').value];
    });

    // Find bus
    $('findBtnHome').addEventListener('click', runSearch);
    [$('fromInput'), $('toInput')].forEach(el => {
      el.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
    });

    // Result screen
    $('speakResultBtn').addEventListener('click', speakResult);
    $('startJourneyBtn').addEventListener('click', () => {
      if (selectedRouteIndex < 0) {
        showError('Please tap "Select this route" on one of the options above.');
        return;
      }
      startJourneyMode();
    });
    $('newSearchBtn').addEventListener('click', () => {
      resolvedFrom = null; resolvedTo = null;
      selectedRouteIndex = -1;
      $('fromInput').value = ''; $('toInput').value = '';
      showScreen('screenHome');
    });
    $('backToHome').addEventListener('click', () => showScreen('screenHome'));

    // Journey screen
    $('speakNowBtn').addEventListener('click', speakResult);
    $('endJourneyBtn').addEventListener('click', endJourney);
    // Back from journey → confirm if tracking active
    $('backToResult').addEventListener('click', () => {
      if (activeJourney) {
        if (!confirm('End current journey and go back to route selection?')) return;
      }
      JourneyTracker.stop();
      activeJourney = null;
      journeySteps = [];
      try { localStorage.removeItem('anavandi-active-journey'); } catch(_) {}
      showScreen('screenResult');
    });

    // Arrival
    $('arrivalDoneBtn').addEventListener('click', () => {
      $('arrivalOverlay').classList.remove('visible');
      endJourney();
    });

    // Offline
    window.addEventListener('online', updateOffline);
    window.addEventListener('offline', updateOffline);
    updateOffline();

    // Service Worker
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

    // Default translations (EN)
    setLang('en');

    // Dataset version footer (Task 4)
    const vf = $('datasetVersionFooter');
    if (vf) {
      const v = DataLayer.getVersion();
      vf.innerHTML = `<span>Dataset v${v.version} · Updated ${v.lastUpdated} · ${v.coverage.stops_count || '?'} stops · ${v.coverage.routes_count || '?'} routes</span>`;
    }
  }

  return { init };
})();

// ═══════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => UI.init());
