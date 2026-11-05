import datetime
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


class Halt(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def sha(*parts):
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()


def canon(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _merge(a, b):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict):
            _merge(a[k], v)
        else:
            a[k] = v
    return a


def load_config():
    cfg = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
    extra = os.environ.get("AI_CONFIG")
    if extra:
        _merge(cfg, json.loads(Path(extra).read_text(encoding="utf-8")))
    b = cfg["budgets"]
    b["max_usd_day"] = float(os.environ.get("AI_MAX_USD_DAY", b["max_usd_day"]))
    b["max_usd_month"] = float(os.environ.get("AI_MAX_USD_MONTH", b["max_usd_month"]))
    b["max_articles"] = int(os.environ.get("AI_MAX_ARTICLES", b["max_articles"]))
    return cfg


def now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.datetime.now(ZoneInfo("Europe/Lisbon"))
    except Exception:
        return datetime.datetime.now().astimezone()


def default_date():
    return now().date().isoformat()


def state_root():
    return Path(os.environ.get("ESTADO_ABERTO_STATE") or "/var/lib/estado-aberto/state")


def data_dir():
    return Path(os.environ.get("ESTADO_ABERTO_DATA") or ROOT / "data").expanduser().resolve()


def open_ro(path):
    p = Path(path)
    for q in ("mode=ro", "immutable=1"):
        try:
            con = sqlite3.connect(f"file:{p}?{q}", uri=True, timeout=10)
            con.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchall()
            con.row_factory = sqlite3.Row
            return con
        except sqlite3.Error:
            continue
    raise FileNotFoundError(str(p))


class Ctx:
    def __init__(self, date=None, dry=False):
        self.cfg = load_config()
        self.date = date or default_date()
        self.dry = dry
        self.ai = state_root() / "ai"
        self.work = self.ai / "work" / self.date
        self.bundles = self.ai / "bundles"
        self.cache = self.ai / "cache"
        self.published = self.ai / "published" / self.date
        self.rejected = self.ai / "rejected" / self.date
        self.audit_path = self.ai / "audit.log"
        self.claude_bin = os.environ.get("CLAUDE_BIN") or self.cfg["claude_bin_default"]
        self.port = os.environ.get("PORT", "3000")
        self.api = f"http://127.0.0.1:{self.port}"
        self.calls = 0

    def mkdirs(self):
        for d in (self.work, self.bundles, self.cache, self.published, self.rejected):
            d.mkdir(parents=True, exist_ok=True)

    def enabled(self):
        return os.environ.get("AI_ENABLED", "0") == "1"

    def stopped(self):
        return (self.ai / "STOP").exists()

    def audit(self, stage, model="", tin=0, tout=0, usd=0.0, cache=False, decision="", **extra):
        rec = {"time": now().isoformat(timespec="seconds"), "stage": stage, "model": model, "tokens_in": tin,
               "tokens_out": tout, "usd": round(usd, 6), "cache": cache, "decision": decision}
        rec.update(extra)
        self.ai.mkdir(parents=True, exist_ok=True)
        with open(self.audit_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def spent(self, prefix):
        total = 0.0
        try:
            for line in self.audit_path.read_text(encoding="utf-8").splitlines():
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if str(r.get("time", "")).startswith(prefix):
                    total += float(r.get("usd") or 0)
        except FileNotFoundError:
            pass
        return total

    def spent_day(self):
        return self.spent(now().date().isoformat())

    def spent_month(self):
        return self.spent(now().strftime("%Y-%m"))

    def price(self, tier, tin, tout):
        pi, po = self.cfg["prices_usd_per_million"][tier]
        return (tin * pi + tout * po) / 1e6

    def estimate_stage(self, stage, n=1):
        e = self.cfg["estimates"][stage]
        tier = self.cfg["stages"][stage]["tier"]
        if "in_per_candidate" in e:
            return self.price(tier, e["in_per_candidate"] * n, e["out"])
        return self.price(tier, e["in"], e["out"])

    def guard(self, stage, est):
        if self.stopped():
            raise Halt("stop")
        b = self.cfg["budgets"]
        if self.spent_day() + est > b["max_usd_day"]:
            raise Halt("budget_day")
        if self.spent_month() + est > b["max_usd_month"]:
            raise Halt("budget_month")


def validate(schema, v, path="$"):
    t = schema.get("type")
    errs = []
    types = {"object": dict, "array": list, "string": str, "integer": int, "number": (int, float), "boolean": bool}
    if t:
        ok = isinstance(v, types[t]) and not (t in ("integer", "number") and isinstance(v, bool))
        if not ok:
            return [f"{path}: tipo {t}"]
    if "enum" in schema and v not in schema["enum"]:
        errs.append(f"{path}: enum")
    if isinstance(v, str):
        if len(v) < schema.get("minLength", 0) or len(v) > schema.get("maxLength", 10 ** 9):
            errs.append(f"{path}: comprimento")
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if v < schema.get("minimum", -1e18) or v > schema.get("maximum", 1e18):
            errs.append(f"{path}: intervalo")
    if isinstance(v, list):
        if len(v) < schema.get("minItems", 0) or len(v) > schema.get("maxItems", 10 ** 9):
            errs.append(f"{path}: itens")
        for i, x in enumerate(v):
            if "items" in schema:
                errs += validate(schema["items"], x, f"{path}[{i}]")
    if isinstance(v, dict):
        for k in schema.get("required", []):
            if k not in v:
                errs.append(f"{path}.{k}: em falta")
        for k, s in schema.get("properties", {}).items():
            if k in v:
                errs += validate(s, v[k], f"{path}.{k}")
    return errs


INJ = re.compile(
    r"ignor[ae]\b|ignore\s+(all|any|previous|the|above|prior)|disregard|esquece\b|instru[cç][oõ]es\s+anteriores|"
    r"new\s+instructions|nova[s]?\s+instru|you\s+are\s+now|\bact\s+as\b|"
    r"^\s*(system|assistant|human|user|developer)\s*:|<\s*/?\s*(system|assistant|tool|function|instructions?)\b|"
    r"tool_use|tool_call|function_call|\"role\"\s*:|\[/?INST\]|<\|", re.I)
TAG = re.compile(r"</?\s*fonte_nao_confiavel\s*>", re.I)


def sanitize(text):
    out = []
    for line in str(text).splitlines():
        line = TAG.sub("", line)
        out.append("[linha removida]" if INJ.search(line) else line)
    return "\n".join(out)


def wrap(text):
    return "<fonte_nao_confiavel>\n" + sanitize(text) + "\n</fonte_nao_confiavel>"


def parse_output(stdout):
    obj = json.loads(stdout)
    if isinstance(obj, list):
        obj = next((x for x in reversed(obj) if isinstance(x, dict) and x.get("type") == "result"), obj[-1])
    if obj.get("is_error"):
        raise RuntimeError("cli_error")
    data = obj.get("structured_output")
    if data is None:
        r = obj.get("result")
        if isinstance(r, str):
            r = re.sub(r"^```(?:json)?\s*|\s*```$", "", r.strip())
            data = json.loads(r)
        else:
            data = r
    u = obj.get("usage") or {}
    tin = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    return data, tin, int(u.get("output_tokens") or 0), obj.get("total_cost_usd")


def call_model(ctx, stage, cwd, user_prompt, evidence_hash, est=None):
    sc = ctx.cfg["stages"][stage]
    tier = sc["tier"]
    model = ctx.cfg["models"][tier]
    key = sha(stage, model, ctx.cfg["prompt_versions"][stage], evidence_hash)
    cf = ctx.cache / f"{key}.json"
    if cf.exists():
        ctx.audit(stage, model, 0, 0, 0.0, True, "cache", evidence=evidence_hash[:12])
        return json.loads(cf.read_text(encoding="utf-8"))
    ctx.guard(stage, est if est is not None else ctx.estimate_stage(stage))
    schema_path = HERE / "schemas" / f"{sc['schema']}.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    cwd = Path(cwd).resolve()
    rule = "//" + str(cwd).lstrip("/") + "/**"
    subs = {"model": model, "schema_json": canon(schema), "system_prompt_file": str(HERE / "prompts" / f"{sc['prompt']}.md"),
            "read_rules": f"Read({rule}),Grep({rule}),Glob({rule})", "max_turns": str(sc["max_turns"]), "max_usd": str(sc["max_usd"])}
    argv = [ctx.claude_bin] + [a.format(**subs) if "{" in a else a for a in ctx.cfg["cli"]["args"]]
    ctx.calls += 1
    try:
        p = subprocess.run(argv, input=user_prompt, capture_output=True, text=True, cwd=cwd, timeout=ctx.cfg["cli"]["timeout_s"])
        if p.returncode != 0:
            raise RuntimeError(f"exit {p.returncode}")
        data, tin, tout, cost = parse_output(p.stdout)
    except Exception as e:
        ctx.audit(stage, model, 0, 0, 0.0, False, "falha", erro=type(e).__name__, evidence=evidence_hash[:12])
        return None
    usd = float(cost) if cost is not None else ctx.price(tier, tin, tout)
    errs = validate(schema, data)
    if errs:
        ctx.audit(stage, model, tin, tout, usd, False, "invalido", erro=errs[0][:80], evidence=evidence_hash[:12])
        return None
    ctx.cache.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=ctx.cache)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"data": data, "tokens_in": tin, "tokens_out": tout, "usd": usd}, f, ensure_ascii=False)
    os.replace(tmp, cf)
    ctx.audit(stage, model, tin, tout, usd, False, "ok", evidence=evidence_hash[:12])
    return {"data": data, "tokens_in": tin, "tokens_out": tout, "usd": usd}
