"""
SIMBA — guardrail-service
Classificatore semantico leggero per prevenire jailbreak e prompt injection.
Gira in CPU, latenza 30-80ms, fail-open se down.
"""

import os
import json
import hashlib
import sqlite3
import logging
from contextlib import contextmanager
from typing import Optional

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Header, Query
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
from transformers import AutoTokenizer, AutoModelForSequenceClassification

# ── Configurazione ────────────────────────────────────────────────────────────
DB_PATH              = os.environ.get("DB_PATH", "/app/data/guardrail.db")
ADMIN_TOKEN          = os.environ.get("ADMIN_TOKEN", "")
TOXICITY_THRESHOLD   = float(os.environ.get("TOXICITY_THRESHOLD", "0.85"))
SIMILARITY_THRESHOLD = float(os.environ.get("SIMILARITY_THRESHOLD", "0.78"))
CORPUS_STATIC_PATH   = os.environ.get("CORPUS_STATIC_PATH", "/app/corpus_static.json")
CORPUS_DYNAMIC_PATH  = os.environ.get("CORPUS_DYNAMIC_PATH", "/app/corpus_dynamic_backup.json")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("guardrail")

app = FastAPI(title="SIMBA Guardrail Service", version="1.0.0")

# ── Stato globale ─────────────────────────────────────────────────────────────
class GuardrailState:
    def __init__(self):
        self.toxicity_tokenizer   = None
        self.toxicity_model       = None
        self.sim_model            = None
        self.corpus_embeddings    = None
        self.corpus_ids           = []
        self.toxicity_threshold   = TOXICITY_THRESHOLD
        self.similarity_threshold = SIMILARITY_THRESHOLD

state = GuardrailState()

# ── DB helpers ────────────────────────────────────────────────────────────────
@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    """Crea tabelle se non esistono."""
    with get_db() as conn:
        conn.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS guardrail_corpus (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              prompt TEXT NOT NULL,
              category TEXT NOT NULL,
              source TEXT NOT NULL,
              added_by TEXT,
              added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              active INTEGER DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_guardrail_corpus_active
              ON guardrail_corpus(active);
            CREATE TABLE IF NOT EXISTS guardrail_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              prompt_hash TEXT NOT NULL,
              prompt_preview TEXT,
              decision TEXT NOT NULL,
              reason TEXT,
              toxicity_score REAL,
              similarity_score REAL,
              matched_corpus_id INTEGER,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (matched_corpus_id) REFERENCES guardrail_corpus(id)
            );
            CREATE INDEX IF NOT EXISTS idx_guardrail_logs_created
              ON guardrail_logs(created_at);
            CREATE INDEX IF NOT EXISTS idx_guardrail_logs_decision
              ON guardrail_logs(decision);
        """)
        conn.commit()
    log.info("DB inizializzato: %s", DB_PATH)

def seed_corpus_from_file(path: str, source: str):
    """Importa prompt da un file JSON se non già presenti."""
    if not os.path.exists(path):
        log.info("File corpus non trovato, skip: %s", path)
        return 0
    with open(path, "r", encoding="utf-8") as f:
        items = json.load(f)
    added = 0
    with get_db() as conn:
        for item in items:
            prompt   = item.get("prompt", "").strip()
            category = item.get("category", "other")
            if not prompt:
                continue
            existing = conn.execute(
                "SELECT id FROM guardrail_corpus WHERE prompt=? AND active=1",
                (prompt,)
            ).fetchone()
            if existing:
                continue
            conn.execute(
                "INSERT INTO guardrail_corpus (prompt, category, source, added_by) VALUES (?,?,?,?)",
                (prompt, category, source, "system")
            )
            added += 1
        conn.commit()
    log.info("Importati %d prompt da %s (source=%s)", added, path, source)
    return added

def rebuild_corpus_index():
    """Ricalcola gli embedding del corpus attivo."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, prompt FROM guardrail_corpus WHERE active=1"
        ).fetchall()
    if not rows:
        state.corpus_embeddings = None
        state.corpus_ids = []
        log.info("Corpus vuoto")
        return
    prompts = [r["prompt"] for r in rows]
    state.corpus_ids = [r["id"] for r in rows]
    log.info("Building corpus index per %d voci...", len(prompts))
    state.corpus_embeddings = state.sim_model.encode(
        prompts, convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False
    )
    log.info("Corpus index pronto")

def log_decision(prompt: str, decision: str, reason: Optional[str],
                  tox: float, sim: float, matched_id: Optional[int]):
    h = hashlib.sha256(prompt.encode()).hexdigest()
    preview = prompt[:100]
    with get_db() as conn:
        conn.execute(
            """INSERT INTO guardrail_logs
               (prompt_hash, prompt_preview, decision, reason, toxicity_score, similarity_score, matched_corpus_id)
               VALUES (?,?,?,?,?,?,?)""",
            (h, preview, decision, reason, tox, sim, matched_id)
        )
        conn.commit()

# ── Modelli ───────────────────────────────────────────────────────────────────
def load_models():
    log.info("Carico toxic-bert...")
    state.toxicity_tokenizer = AutoTokenizer.from_pretrained("unitary/toxic-bert")
    state.toxicity_model = AutoModelForSequenceClassification.from_pretrained("unitary/toxic-bert")
    state.toxicity_model.eval()
    log.info("Carico sentence-transformer...")
    state.sim_model = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")
    log.info("Models loaded")

def classify_toxicity(text: str) -> float:
    inputs = state.toxicity_tokenizer(
        text, return_tensors="pt", truncation=True, max_length=512
    )
    with torch.no_grad():
        logits = state.toxicity_model(**inputs).logits
    probs = torch.softmax(logits, dim=-1)
    return float(probs[0][1].item())

def classify_similarity(text: str) -> tuple:
    if state.corpus_embeddings is None or len(state.corpus_ids) == 0:
        return 0.0, None
    emb = state.sim_model.encode(
        [text], convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False
    )
    sims = np.dot(state.corpus_embeddings, emb[0])
    idx = int(np.argmax(sims))
    return float(sims[idx]), state.corpus_ids[idx]

# ── Lifecycle ─────────────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    load_models()
    init_db()
    # 1. Corpus statico (sempre)
    seed_corpus_from_file(CORPUS_STATIC_PATH, "static")
    # 2. Corpus dinamico backup (se esiste — per migrazione o primo deploy)
    seed_corpus_from_file(CORPUS_DYNAMIC_PATH, "dynamic_backup")
    rebuild_corpus_index()
    log.info("guardrail-service pronto")

# ── Auth helper ───────────────────────────────────────────────────────────────
def require_admin(x_admin_token: str = Header(None)):
    if not ADMIN_TOKEN:
        raise HTTPException(500, "ADMIN_TOKEN non configurato")
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(403, "Token non valido")

# ── Modelli Pydantic ──────────────────────────────────────────────────────────
class ClassifyRequest(BaseModel):
    prompt: str

class ClassifyResponse(BaseModel):
    block: bool
    reason: Optional[str]
    toxicity_score: float
    similarity_score: float
    matched_corpus_id: Optional[int]

class CorpusAddRequest(BaseModel):
    prompt: str
    category: str = "jailbreak"

class ThresholdRequest(BaseModel):
    toxicity: Optional[float] = None
    similarity: Optional[float] = None

# ── Endpoint pubblico ─────────────────────────────────────────────────────────
@app.post("/classify", response_model=ClassifyResponse)
async def classify(req: ClassifyRequest):
    prompt = req.prompt.strip()
    if not prompt:
        return ClassifyResponse(block=False, reason=None,
                                toxicity_score=0.0, similarity_score=0.0,
                                matched_corpus_id=None)
    tox_score = classify_toxicity(prompt)
    sim_score, matched_id = classify_similarity(prompt)
    block = False
    reason = None
    if tox_score >= state.toxicity_threshold:
        block = True
        reason = "toxicity"
    elif sim_score >= state.similarity_threshold:
        block = True
        reason = "jailbreak_similarity"
    log_decision(prompt, "block" if block else "pass", reason,
                 tox_score, sim_score, matched_id if block else None)
    return ClassifyResponse(
        block=block, reason=reason,
        toxicity_score=round(tox_score, 4),
        similarity_score=round(sim_score, 4),
        matched_corpus_id=matched_id if block else None,
    )

# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    with get_db() as conn:
        corpus_size = conn.execute(
            "SELECT COUNT(*) FROM guardrail_corpus WHERE active=1"
        ).fetchone()[0]
    return {
        "status": "ok",
        "corpus_size": corpus_size,
        "thresholds": {
            "toxicity": state.toxicity_threshold,
            "similarity": state.similarity_threshold,
        }
    }

# ── Admin: corpus ─────────────────────────────────────────────────────────────
@app.get("/admin/corpus")
async def list_corpus(include_inactive: bool = False, x_admin_token: str = Header(None)):
    require_admin(x_admin_token)
    with get_db() as conn:
        q = "SELECT * FROM guardrail_corpus ORDER BY added_at DESC" if include_inactive \
            else "SELECT * FROM guardrail_corpus WHERE active=1 ORDER BY added_at DESC"
        rows = conn.execute(q).fetchall()
    return [dict(r) for r in rows]

@app.post("/admin/corpus", status_code=201)
async def add_corpus(req: CorpusAddRequest, x_admin_token: str = Header(None)):
    require_admin(x_admin_token)
    valid_cats = {"jailbreak", "pii_extraction", "prompt_injection", "roleplay_bypass", "other"}
    if req.category not in valid_cats:
        raise HTTPException(400, f"category deve essere uno di: {valid_cats}")
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO guardrail_corpus (prompt, category, source, added_by) VALUES (?,?,?,?)",
            (req.prompt, req.category, "admin", "admin")
        )
        conn.commit()
        new_id = cur.lastrowid
    rebuild_corpus_index()
    return {"id": new_id, "message": "Aggiunto e index aggiornato"}

@app.delete("/admin/corpus/{item_id}")
async def delete_corpus(item_id: int, x_admin_token: str = Header(None)):
    require_admin(x_admin_token)
    with get_db() as conn:
        conn.execute("UPDATE guardrail_corpus SET active=0 WHERE id=?", (item_id,))
        conn.commit()
    rebuild_corpus_index()
    return {"message": f"Voce {item_id} disattivata (soft-delete)"}

@app.get("/admin/export")
async def export_corpus(x_admin_token: str = Header(None)):
    """Esporta tutto il corpus attivo in JSON — per backup/migrazione."""
    require_admin(x_admin_token)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT prompt, category, source FROM guardrail_corpus WHERE active=1 ORDER BY id"
        ).fetchall()
    return [dict(r) for r in rows]

# ── Admin: logs ───────────────────────────────────────────────────────────────
@app.get("/admin/logs")
async def get_logs(
    limit: int = Query(50, le=500),
    decision: Optional[str] = None,
    x_admin_token: str = Header(None)
):
    require_admin(x_admin_token)
    with get_db() as conn:
        if decision:
            rows = conn.execute(
                "SELECT * FROM guardrail_logs WHERE decision=? ORDER BY created_at DESC LIMIT ?",
                (decision, limit)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM guardrail_logs ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
    return [dict(r) for r in rows]

# ── Admin: stats ──────────────────────────────────────────────────────────────
@app.get("/admin/stats")
async def get_stats(x_admin_token: str = Header(None)):
    require_admin(x_admin_token)
    with get_db() as conn:
        total  = conn.execute("SELECT COUNT(*) FROM guardrail_logs").fetchone()[0]
        blocks = conn.execute("SELECT COUNT(*) FROM guardrail_logs WHERE decision='block'").fetchone()[0]
        by_reason = conn.execute(
            "SELECT reason, COUNT(*) as cnt FROM guardrail_logs WHERE decision='block' GROUP BY reason"
        ).fetchall()
        corpus_size = conn.execute("SELECT COUNT(*) FROM guardrail_corpus WHERE active=1").fetchone()[0]
    return {
        "total_classified": total,
        "total_blocked": blocks,
        "pass_rate": round((total - blocks) / total * 100, 1) if total > 0 else 100.0,
        "blocks_by_reason": {r["reason"]: r["cnt"] for r in by_reason},
        "corpus_size": corpus_size,
        "thresholds": {
            "toxicity": state.toxicity_threshold,
            "similarity": state.similarity_threshold,
        }
    }

# ── Admin: threshold ──────────────────────────────────────────────────────────
@app.get("/admin/threshold")
async def get_threshold(x_admin_token: str = Header(None)):
    require_admin(x_admin_token)
    return {"toxicity": state.toxicity_threshold, "similarity": state.similarity_threshold}

@app.post("/admin/threshold")
async def set_threshold(req: ThresholdRequest, x_admin_token: str = Header(None)):
    require_admin(x_admin_token)
    if req.toxicity is not None:
        if not 0.0 < req.toxicity <= 1.0:
            raise HTTPException(400, "toxicity deve essere tra 0.01 e 1.0")
        state.toxicity_threshold = req.toxicity
    if req.similarity is not None:
        if not 0.0 < req.similarity <= 1.0:
            raise HTTPException(400, "similarity deve essere tra 0.01 e 1.0")
        state.similarity_threshold = req.similarity
    return {
        "message": "Thresholds aggiornati",
        "toxicity": state.toxicity_threshold,
        "similarity": state.similarity_threshold,
    }
