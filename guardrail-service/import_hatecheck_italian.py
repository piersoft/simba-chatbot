#!/usr/bin/env python3
"""
import_hatecheck_italian.py
Scarica Paul/hatecheck-italian da HuggingFace, importa i casi hateful
nel corpus del guardrail-service SIMBA e aggiorna corpus_dynamic_backup.json.

Uso (dentro il container guardrail-service):
  python3 /tmp/import_hatecheck.py --token <ADMIN_TOKEN> [--url http://localhost:8000] [--max 200] [--dry-run]
"""

import argparse, json, os, sys, time, urllib.request, urllib.error

parser = argparse.ArgumentParser()
parser.add_argument("--token",     required=True)
parser.add_argument("--url",       default="http://localhost:8000")
parser.add_argument("--max",       type=int, default=200)
parser.add_argument("--min-len",   type=int, default=15)
parser.add_argument("--dry-run",   action="store_true")
parser.add_argument("--no-backup", action="store_true")
args = parser.parse_args()

GUARDRAIL_URL = args.url.rstrip("/")
ADMIN_TOKEN   = args.token
MAX_IMPORT    = args.max
MIN_LEN       = args.min_len
BACKUP_PATH   = "/app/corpus_dynamic_backup.json"

print("[1/5] Scarico hatecheck-italian...")
hateful = []

CSV_URLS = [
    "https://huggingface.co/datasets/Paul/hatecheck-italian/resolve/main/test_suite_italian.csv",
    "https://huggingface.co/datasets/Paul/hatecheck-italian/resolve/main/data/test_suite_italian.csv",
]
for csv_url in CSV_URLS:
    try:
        req = urllib.request.Request(csv_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8")
        print(f"  CSV: {len(raw)} bytes")
        lines = [l for l in raw.splitlines() if l.strip()]
        header = lines[0].split(",")
        col_text = col_label = -1
        for i, h in enumerate(header):
            hl = h.strip().lower().strip('"')
            if hl in ("test_case","gender_male","case_templ"): col_text = i
            if hl == "label_gold": col_label = i
        if col_text < 0 or col_label < 0:
            print(f"  Header non trovato: {header[:6]}")
            continue
        for line in lines[1:]:
            parts = line.split(",")
            if len(parts) <= max(col_text, col_label): continue
            text  = parts[col_text].strip().strip('"')
            label = parts[col_label].strip().strip('"').lower()
            if label == "hateful" and len(text) >= MIN_LEN:
                hateful.append(text)
        break
    except Exception as e:
        print(f"  {csv_url}: {e}")

if not hateful:
    print("  Provo HuggingFace Datasets API...")
    for offset in range(0, 2000, 100):
        api = f"https://datasets-server.huggingface.co/rows?dataset=Paul%2Fhatecheck-italian&config=default&split=test&offset={offset}&length=100"
        try:
            req = urllib.request.Request(api, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read())
            rows = data.get("rows", [])
            if not rows: break
            for r in rows:
                row = r.get("row", {})
                text  = (row.get("test_case") or row.get("gender_male") or "").strip()
                label = (row.get("label_gold") or "").strip().lower()
                if label == "hateful" and len(text) >= MIN_LEN:
                    hateful.append(text)
        except Exception as e:
            print(f"  API offset {offset}: {e}"); break

if not hateful:
    print("ERRORE: impossibile scaricare hatecheck-italian"); sys.exit(1)

print(f"\n[2/5] {len(hateful)} casi hateful raw")
seen, unique = set(), []
for t in hateful:
    if t not in seen: seen.add(t); unique.append(t)
print(f"  Dopo dedup: {len(unique)}")
to_import = unique[:MAX_IMPORT]
print(f"  Da importare: {len(to_import)}")

if args.dry_run:
    print("\n[DRY RUN] Primi 5:")
    for p in to_import[:5]: print(f"  - {p[:90]}")
    print(f"\nTotale: {len(to_import)}"); sys.exit(0)

print(f"\n[3/5] Verifico {GUARDRAIL_URL}...")
try:
    req = urllib.request.Request(f"{GUARDRAIL_URL}/health")
    with urllib.request.urlopen(req, timeout=5) as r:
        h = json.loads(r.read())
    print(f"  OK — corpus: {h.get('corpus_size','?')} voci")
except Exception as e:
    print(f"ERRORE: {e}"); sys.exit(1)

print(f"\n[4/5] Importo {len(to_import)} prompt...")
ok = skip = err = 0
imported_prompts = []
for i, prompt in enumerate(to_import):
    payload = json.dumps({"prompt": prompt, "category": "other"}).encode()
    req = urllib.request.Request(f"{GUARDRAIL_URL}/admin/corpus", data=payload,
        headers={"Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            json.loads(r.read()); ok += 1
        imported_prompts.append({"prompt": prompt, "category": "other"})
    except urllib.error.HTTPError as e:
        if e.code == 409: skip += 1; imported_prompts.append({"prompt": prompt, "category": "other"})
        else: err += 1; (print(f"  WARN [{i+1}] HTTP {e.code}: {prompt[:50]}") if err <= 3 else None)
    except Exception as e:
        err += 1; (print(f"  WARN [{i+1}] {e}: {prompt[:50]}") if err <= 3 else None)
    if (i+1) % 50 == 0: print(f"  {i+1}/{len(to_import)} ok={ok} skip={skip} err={err}")
    time.sleep(0.05)

print(f"\n[5/5] Aggiorno {BACKUP_PATH}...")
if not args.no_backup:
    existing = []
    if os.path.exists(BACKUP_PATH):
        try:
            with open(BACKUP_PATH) as f: existing = json.load(f)
            print(f"  Backup esistente: {len(existing)} voci")
        except: pass
    existing_set = {e["prompt"] for e in existing}
    new_entries  = [e for e in imported_prompts if e["prompt"] not in existing_set]
    merged = existing + new_entries
    with open(BACKUP_PATH, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
    print(f"  Backup: {len(merged)} voci totali (+{len(new_entries)} nuove)")

print(f"\n{'='*55}")
print(f"Aggiunti: {ok}  Gia presenti: {skip}  Errori: {err}")
try:
    req = urllib.request.Request(f"{GUARDRAIL_URL}/health")
    with urllib.request.urlopen(req, timeout=5) as r:
        h = json.loads(r.read())
    print(f"Corpus totale: {h.get('corpus_size','?')} voci")
except: pass
print(f"{'='*55}")
if not args.no_backup:
    print("\nPROSSIMO PASSO — esegui sul server:")
    print(f"  docker cp guardrail-service:{BACKUP_PATH} guardrail-service/corpus_dynamic_backup.json")
    print(f"  git add guardrail-service/corpus_dynamic_backup.json")
    print(f"  git commit -m 'backup: corpus guardrail post-hatecheck-italian'")
    print(f"  git push origin main")
