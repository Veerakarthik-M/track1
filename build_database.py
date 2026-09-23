"""
ANAVANDI — Build SQLite Database from JSON data files
Generates data/anavandi.db with full relational schema
"""
import json, sqlite3, os

DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')
DB_PATH = os.path.join(DATA_DIR, 'anavandi.db')

# Remove old DB if exists
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)

conn = sqlite3.connect(DB_PATH)
c = conn.cursor()

# ═══════════════════════════════════════
# CREATE TABLES
# ═══════════════════════════════════════
c.executescript("""
CREATE TABLE stops (
    stop_id         TEXT PRIMARY KEY,
    name_en         TEXT NOT NULL,
    name_ml         TEXT,
    name_hi         TEXT,
    latitude        REAL NOT NULL,
    longitude       REAL NOT NULL,
    landmark_en     TEXT,
    landmark_ml     TEXT,
    landmark_hi     TEXT
);

CREATE TABLE routes (
    route_id        TEXT PRIMARY KEY,
    route_number    TEXT NOT NULL,
    name_en         TEXT NOT NULL,
    name_ml         TEXT,
    name_hi         TEXT,
    route_type      TEXT,
    operator        TEXT,
    frequency_mins  INTEGER
);

CREATE TABLE route_stops (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id        TEXT NOT NULL REFERENCES routes(route_id),
    stop_id         TEXT NOT NULL REFERENCES stops(stop_id),
    stop_sequence   INTEGER NOT NULL,
    distance_km     REAL NOT NULL DEFAULT 0
);

CREATE TABLE fare_stages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id        TEXT NOT NULL REFERENCES routes(route_id),
    from_stop       TEXT NOT NULL,
    to_stop         TEXT NOT NULL,
    stages          INTEGER NOT NULL,
    fare_min        REAL NOT NULL,
    fare_max        REAL NOT NULL
);

CREATE TABLE aliases (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    alias_text      TEXT NOT NULL,
    stop_id         TEXT NOT NULL REFERENCES stops(stop_id),
    language        TEXT NOT NULL DEFAULT 'en'
);

CREATE TABLE entities (
    entity_id       TEXT PRIMARY KEY,
    name_en         TEXT NOT NULL,
    name_ml         TEXT,
    name_hi         TEXT,
    entity_type     TEXT,
    latitude        REAL,
    longitude       REAL,
    district        TEXT,
    mapped_stop_id  TEXT REFERENCES stops(stop_id)
);

CREATE TABLE data_sources (
    source_id       TEXT PRIMARY KEY,
    source_name     TEXT NOT NULL,
    source_type     TEXT,
    url             TEXT,
    version         TEXT,
    collected_at    TEXT,
    validation      TEXT
);

CREATE INDEX idx_route_stops_route ON route_stops(route_id);
CREATE INDEX idx_route_stops_stop ON route_stops(stop_id);
CREATE INDEX idx_fare_route ON fare_stages(route_id);
CREATE INDEX idx_alias_text ON aliases(alias_text);
CREATE INDEX idx_alias_stop ON aliases(stop_id);
CREATE INDEX idx_entity_district ON entities(district);
""")

# ═══════════════════════════════════════
# LOAD DATA
# ═══════════════════════════════════════

# 1. Stops
with open(os.path.join(DATA_DIR, 'stops.json'), 'r', encoding='utf-8') as f:
    stops = json.load(f)

for sid, s in stops.items():
    lm = s.get('landmark', {})
    c.execute("""INSERT INTO stops VALUES (?,?,?,?,?,?,?,?,?)""",
              (sid, s.get('en',''), s.get('ml',''), s.get('hi',''),
               s.get('lat',0), s.get('lon',0),
               lm.get('en',''), lm.get('ml',''), lm.get('hi','')))

print(f"  ✓ {len(stops)} stops inserted")

# 2. Routes + Route Stops
with open(os.path.join(DATA_DIR, 'routes.json'), 'r', encoding='utf-8') as f:
    routes_data = json.load(f)

route_count = 0
rs_count = 0
for r in routes_data['routes']:
    nm = r.get('name', {})
    c.execute("""INSERT INTO routes VALUES (?,?,?,?,?,?,?,?)""",
              (r['id'], r['number'],
               nm.get('en',''), nm.get('ml',''), nm.get('hi',''),
               r.get('type',''), r.get('operator',''), r.get('frequency_mins',0)))
    route_count += 1

    for i, stop_id in enumerate(r.get('stops', [])):
        dist = r.get('stop_distances_km', [0]*len(r['stops']))[i] if i < len(r.get('stop_distances_km',[])) else 0
        c.execute("""INSERT INTO route_stops (route_id, stop_id, stop_sequence, distance_km)
                     VALUES (?,?,?,?)""", (r['id'], stop_id, i+1, dist))
        rs_count += 1

print(f"  ✓ {route_count} routes inserted")
print(f"  ✓ {rs_count} route_stops inserted")

# 3. Fare Stages
with open(os.path.join(DATA_DIR, 'fare_stages.json'), 'r', encoding='utf-8') as f:
    fares = json.load(f)

fare_count = 0
for route_id, pairs in fares.get('stage_matrix', {}).items():
    for pair_key, fare_info in pairs.items():
        parts = pair_key.split('-', 1)
        if len(parts) == 2:
            c.execute("""INSERT INTO fare_stages (route_id, from_stop, to_stop, stages, fare_min, fare_max)
                         VALUES (?,?,?,?,?,?)""",
                      (route_id, parts[0], parts[1],
                       fare_info['stages'], fare_info['fare_min'], fare_info['fare_max']))
            fare_count += 1

print(f"  ✓ {fare_count} fare stages inserted")

# 4. Aliases
with open(os.path.join(DATA_DIR, 'aliases.json'), 'r', encoding='utf-8') as f:
    aliases = json.load(f)

alias_count = 0
for a in aliases.get('aliases', []):
    c.execute("""INSERT INTO aliases (alias_text, stop_id, language)
                 VALUES (?,?,?)""", (a['alias'], a['stop_id'], a.get('lang','en')))
    alias_count += 1

print(f"  ✓ {alias_count} aliases inserted")

# 5. Entities
with open(os.path.join(DATA_DIR, 'entities.json'), 'r', encoding='utf-8') as f:
    entities = json.load(f)

entity_count = 0
for e in entities.get('entities', []):
    c.execute("""INSERT OR IGNORE INTO entities (entity_id, name_en, name_ml, name_hi, entity_type, latitude, longitude, district, mapped_stop_id)
                 VALUES (?,?,?,?,?,?,?,?,?)""",
              (e.get('id',''), e.get('canonical',''), e.get('ml',''), e.get('hi',''),
               e.get('type',''), e.get('lat',None), e.get('lon',None),
               '', e.get('parent','')))
    entity_count += 1

print(f"  ✓ {entity_count} entities inserted")

# 6. Data Sources (from dataset_meta.json)
try:
    with open(os.path.join(DATA_DIR, 'dataset_meta.json'), 'r', encoding='utf-8') as f:
        meta = json.load(f)
    src_count = 0
    for s in meta.get('sources', []):
        c.execute("""INSERT OR IGNORE INTO data_sources VALUES (?,?,?,?,?,?,?)""",
                  (s.get('source_id',''), s.get('name',''), s.get('type',''),
                   s.get('url',''), s.get('version',''),
                   s.get('collected',''), s.get('validation','')))
        src_count += 1
    print(f"  ✓ {src_count} data sources inserted")
except Exception as e:
    print(f"  ⚠ dataset_meta.json: {e}")

conn.commit()

# Print summary
c.execute("SELECT COUNT(*) FROM stops")
print(f"\n  Database Summary:")
print(f"  ─────────────────")
for table in ['stops','routes','route_stops','fare_stages','aliases','entities','data_sources']:
    c.execute(f"SELECT COUNT(*) FROM {table}")
    print(f"  {table}: {c.fetchone()[0]} rows")

db_size = os.path.getsize(DB_PATH)
print(f"\n  Database file: {DB_PATH}")
print(f"  Database size: {db_size / 1024:.1f} KB")

conn.close()
print("\n✅ anavandi.db created successfully!")
