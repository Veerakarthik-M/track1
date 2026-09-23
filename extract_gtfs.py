"""
extract_gtfs.py — Extract key stops and routes from KochiTransport GTFS
Run: python extract_gtfs.py
Output: data/gtfs_stops.json, data/gtfs_routes_summary.json
"""
import csv, json, os

BASE = os.path.dirname(os.path.abspath(__file__))
GTFS = os.path.join(BASE, 'KochiTransport')
DATA = os.path.join(BASE, 'data')

# ── 1. Read stops ─────────────────────────────────────────
stops = {}
with open(os.path.join(GTFS, 'stops.txt'), encoding='utf-8') as f:
    for row in csv.DictReader(f):
        stops[row['stop_id']] = {
            'id': row['stop_id'],
            'name': row['stop_name'].strip(),
            'lat': float(row['stop_lat']) if row['stop_lat'] else None,
            'lon': float(row['stop_lon']) if row['stop_lon'] else None,
        }
print(f"Loaded {len(stops)} stops")

# ── 2. Read routes ────────────────────────────────────────
routes = {}
with open(os.path.join(GTFS, 'routes.txt'), encoding='utf-8') as f:
    for row in csv.DictReader(f):
        routes[row['route_id']] = {
            'id': row['route_id'],
            'name': row['route_long_name'].strip(),
            'agency': row['agency_id'],
            'type': row['route_type'],
        }
print(f"Loaded {len(routes)} routes")

# ── 3. Read trips (route → trip mapping) ─────────────────
trip_to_route = {}
with open(os.path.join(GTFS, 'trips.txt'), encoding='utf-8') as f:
    for row in csv.DictReader(f):
        trip_to_route[row['trip_id']] = row['route_id']
print(f"Loaded {len(trip_to_route)} trips")

# ── 4. Read stop_times → build route stop sequences ──────
route_stops_map = {}
with open(os.path.join(GTFS, 'stop_times.txt'), encoding='utf-8') as f:
    for row in csv.DictReader(f):
        trip_id = row['trip_id']
        route_id = trip_to_route.get(trip_id)
        if not route_id:
            continue
        if route_id not in route_stops_map:
            route_stops_map[route_id] = {}
        stop_id = row['stop_id']
        seq = int(row['stop_sequence'])
        # Keep the first trip's sequence per route
        if stop_id not in route_stops_map[route_id]:
            route_stops_map[route_id][stop_id] = seq

print(f"Built stop sequences for {len(route_stops_map)} routes")

# ── 5. Assemble route records ─────────────────────────────
route_records = []
for route_id, stop_seq in route_stops_map.items():
    ordered = sorted(stop_seq.items(), key=lambda x: x[1])
    stop_ids = [s[0] for s in ordered]
    stop_names = [stops[s]['name'] for s in stop_ids if s in stops]
    r = routes.get(route_id, {})
    route_records.append({
        'route_id': route_id,
        'name': r.get('name', ''),
        'agency': r.get('agency', ''),
        'stop_count': len(stop_ids),
        'stops': stop_ids[:50],  # cap at 50
        'stop_names': stop_names[:50],
    })

# ── 6. Filter notable stops (high-frequency appearances) ─
stop_freq = {}
for rr in route_records:
    for s in rr['stops']:
        stop_freq[s] = stop_freq.get(s, 0) + 1

notable_stops = sorted(
    [s for s in stops.values() if s['lat'] and s['lon']],
    key=lambda s: -stop_freq.get(s['id'], 0)
)[:200]  # top 200 most-connected stops

# ── 7. Save outputs ───────────────────────────────────────
os.makedirs(DATA, exist_ok=True)

with open(os.path.join(DATA, 'gtfs_stops.json'), 'w', encoding='utf-8') as f:
    json.dump(notable_stops, f, ensure_ascii=False, indent=2)
print(f"Saved {len(notable_stops)} notable stops -> data/gtfs_stops.json")

with open(os.path.join(DATA, 'gtfs_routes_summary.json'), 'w', encoding='utf-8') as f:
    json.dump(route_records[:100], f, ensure_ascii=False, indent=2)
print(f"Saved {len(route_records[:100])} routes -> data/gtfs_routes_summary.json")

print("DONE. Now open data/gtfs_stops.json and data/gtfs_routes_summary.json")
