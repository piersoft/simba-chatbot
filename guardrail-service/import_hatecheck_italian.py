#!/usr/bin/env python3
"""
import_hatecheck_italian.py
Scarica Paul/hatecheck-italian da HuggingFace e importa i casi hateful
nel corpus del guardrail-service SIMBA.

Uso:
  python3 import_hatecheck_italian.py --token <ADMIN_TOKEN> [--url http://localhost:8000] [--dry-run] [--max 200]

Requisiti:
  pip install requests
"""

import argparse
import json
import sys
import time
import urllib.request
import urllib.error

# ── Argomenti ─────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="Importa hatecheck-italian nel guardrail SIMBA")
parser.add_argument("--token",   required=True, help="ADMIN_TOKEN del guardrail-service")
parser.add_argument("--url",     default="http://localhost:8000", help="URL del guardrail-service (default: http://localhost:8000)")
parser.add_argument("--max",     type=int, default=200, help="Max prompt da importare (default: 200)")
parser.add_argument("--dry-run", action="store_true", help="Mostra i prompt senza inviarli")
parser.add_argument("--min-len", type=int, default=15, help="Lunghezza minima del prompt (default: 15 chars)")
args = parser.parse_args()

GUARDRAIL_URL = args.url.rstrip("/")
ADMIN_TOKEN   = args.token
MAX_IMPORT    = args.max
MIN_LEN       = args.min_len

# ── HuggingFace dataset URL ───────────────────────────────────────────────────
HF_CSV_URL = "https://huggingface.co/datasets/Paul/hatecheck-italian/resolve/main/test_suite_italian.csv"

print(f"[1/4] Scarico hatecheck-italian da HuggingFace...")
try:
    req = urllib.request.Request(HF_CSV_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode("utf-8")
    print(f"      Scaricato: {len(raw)} bytes")
except Exception as e:
    print(f"ERRORE download: {e}")
    print("Provo URL alternativo...")
    # Fallback: parquet via datasets viewer API
    HF_API = "https://datasets-server.huggingface.co/rows?dataset=Paul%2Fhatecheck-italian&config=default&split=test&offset=0&length=1000"
    try:
        req = urllib.request.Request(HF_API, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        rows = data.get("rows", [])
        hateful = [
            r["row"]["test_case"] for r in rows
            if r["row"].get("label_gold") == "hateful"
            and len(r["row"].get("test_case", "")) >= MIN_LEN
        ]
        print(f"      API fallback: {len(hateful)} casi hateful trovati")
    except Exception as e2:
        print(f"ERRORE anche con API fallback: {e2}")
        sys.exit(1)
else:
    # Parsa il CSV manualmente
    lines = raw.splitlines()
    if not lines:
        print("ERRORE: CSV vuoto")
        sys.exit(1)
    
    # Trova le colonne
    header = lines[0].split(",")
    print(f"      Colonne CSV: {header[:8]}")
    
    # Cerca test_case e label_gold
    try:
        col_text  = next(i for i, h in enumerate(header) if "test_case" in h.lower())
        col_label = next(i for i, h in enumerate(header) if "label_gold" in h.lower())
    except StopIteration:
        # Fallback: prova con gender_male come testo
        try:
            col_text  = next(i for i, h in enumerate(header) if "gender_male" in h.lower() or "case" in h.lower())
            col_label = next(i for i, h in enumerate(header) if "label" in h.lower())
        except StopIteration:
            print(f"ERRORE: colonne non trovate. Header: {header}")
            sys.exit(1)
    
    print(f"      Colonna testo: {header[col_text]} (idx {col_text})")
    print(f"      Colonna label: {header[col_label]} (idx {col_label})")
    
    hateful = []
    for line in lines[1:]:
        # Split semplice — funziona per la maggior parte dei casi
        parts = line.split(",")
        if len(parts) <= max(col_text, col_label):
            continue
        text  = parts[col_text].strip().strip('"')
        label = parts[col_label].strip().strip('"').lower()
        if label == "hateful" and len(text) >= MIN_LEN and text:
            hateful.append(text)

print(f"\n[2/4] Trovati {len(hateful)} casi hateful (lunghezza >= {MIN_LEN} chars)")

# Deduplicazione
seen = set()
unique = []
for t in hateful:
    if t not in seen:
        seen.add(t)
        unique.append(t)

print(f"      Dopo dedup: {len(unique)} unici")

# Limita al max richiesto
to_import = unique[:MAX_IMPORT]
print(f"      Da importare: {len(to_import)} (max={MAX_IMPORT})")

if args.dry_run:
    print("\n[DRY RUN] Primi 5 prompt:")
    for p in to_import[:5]:
        print(f"  - {p[:80]}...")
    print(f"\nTotale che verrebbe importato: {len(to_import)}")
    sys.exit(0)

# ── Verifica connessione guardrail ─────────────────────────────────────────────
print(f"\n[3/4] Verifico connessione a {GUARDRAIL_URL}...")
try:
    req = urllib.request.Request(f"{GUARDRAIL_URL}/health")
    with urllib.request.urlopen(req, timeout=5) as r:
        health = json.loads(r.read())
    print(f"      Health OK — corpus attuale: {health.get('corpus_size', '?')} voci")
except Exception as e:
    print(f"ERRORE connessione guardrail: {e}")
    print("Assicurati di eseguire questo script dal server o dentro il container guardrail.")
    sys.exit(1)

# ── Import ─────────────────────────────────────────────────────────────────────
print(f"\n[4/4] Importo {len(to_import)} prompt nel corpus...")
ok = 0
skip = 0
err = 0

for i, prompt in enumerate(to_import):
    payload = json.dumps({"prompt": prompt, "category": "other"}).encode()
    req = urllib.request.Request(
        f"{GUARDRAIL_URL}/admin/corpus",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Admin-Token": ADMIN_TOKEN,
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            result = json.loads(r.read())
            ok += 1
    except urllib.error.HTTPError as e:
        if e.code == 409:
            skip += 1  # duplicato
        else:
            err += 1
            if err <= 3:
                print(f"  WARN [{i+1}] HTTP {e.code}: {prompt[:50]}")
    except Exception as e:
        err += 1
        if err <= 3:
            print(f"  WARN [{i+1}] {e}: {prompt[:50]}")
    
    # Progress ogni 50
    if (i + 1) % 50 == 0:
        print(f"  ... {i+1}/{len(to_import)} (ok={ok} skip={skip} err={err})")
    
    # Rate limiting leggero
    time.sleep(0.05)

# ── Report finale ──────────────────────────────────────────────────────────────
print(f"\n{'='*50}")
print(f"Import completato:")
print(f"  ✅ Aggiunti:   {ok}")
print(f"  ⏭  Saltati:   {skip} (duplicati)")
print(f"  ❌ Errori:     {err}")

# Verifica corpus finale
try:
    req = urllib.request.Request(f"{GUARDRAIL_URL}/health")
    with urllib.request.urlopen(req, timeout=5) as r:
        health = json.loads(r.read())
    print(f"\nCorpus totale ora: {health.get('corpus_size', '?')} voci")
except:
    pass

print(f"{'='*50}")
