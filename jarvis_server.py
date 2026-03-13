"""
JARVIS 2.0 — DLCR CRM Cloud Server
Railway ready
"""
import os, json, time, datetime
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR   = os.path.join(BASE, "data")
MEMORY_DIR = os.path.join(BASE, "memory")

os.makedirs(DATA_DIR,   exist_ok=True)
os.makedirs(MEMORY_DIR, exist_ok=True)

LEADS_FILE  = os.path.join(DATA_DIR,   "leads.json")
EVENTS_FILE = os.path.join(DATA_DIR,   "events.json")
TEAM_FILE   = os.path.join(DATA_DIR,   "team.json")
TRANS_FILE  = os.path.join(DATA_DIR,   "transactions.json")
MEMORY_FILE = os.path.join(MEMORY_DIR, "memory.json")
CHAT_FILE   = os.path.join(MEMORY_DIR, "chat_history.json")

def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except:
        return default

def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def next_id(items):
    return max((i.get("id", 0) for i in items), default=0) + 1

def now():
    return datetime.datetime.now().strftime("%I:%M %p")

def call_claude(system, messages, max_tokens=1024):
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise Exception("ANTHROPIC_API_KEY not set")
    import urllib.request as ur
    payload = json.dumps({
        "model":      "claude-sonnet-4-20250514",
        "max_tokens": max_tokens,
        "system":     system,
        "messages":   messages
    }).encode()
    req = ur.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "Content-Type":      "application/json",
            "x-api-key":         api_key,
            "anthropic-version": "2023-06-01"
        },
        method="POST"
    )
    with ur.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
        return result["content"][0]["text"]

@app.route("/")
def index():
    for folder in [BASE, os.path.join(BASE, "dashboard")]:
        if os.path.exists(os.path.join(folder, "index.html")):
            return send_from_directory(folder, "index.html")
    return "<h1>JARVIS 2.0 Online</h1>", 200

@app.route("/<path:filename>")
def static_files(filename):
    for folder in [BASE, os.path.join(BASE, "dashboard")]:
        if os.path.exists(os.path.join(folder, filename)):
            return send_from_directory(folder, filename)
    return "Not found", 404

@app.route("/api/status")
def status():
    key = os.getenv("ANTHROPIC_API_KEY", "")
    sid = os.getenv("TWILIO_ACCOUNT_SID", "")
    return jsonify({"claude": key.startswith("sk-"), "twilio": sid.startswith("AC"), "time": now(), "version": "2.0-cloud"})

@app.route("/api/chat", methods=["POST"])
def chat():
    data    = request.json or {}
    message = data.get("message", "").strip()
    if not message:
        return jsonify({"reply": "No message.", "time": now()})
    memory   = load_json(MEMORY_FILE, {"facts": []})
    history  = load_json(CHAT_FILE, [])
    leads    = load_json(LEADS_FILE, [])
    mem_txt  = "\n".join(memory.get("facts", [])) or "None"
    system   = f"Eres Jarvis 2.0, asistente del CRM DLCR. Responde en el idioma del usuario.\nMemoria:\n{mem_txt}\nClientes: {len(leads)}"
    try:
        messages = [{"role": h["role"], "content": h["content"]} for h in history[-10:]]
        messages.append({"role": "user", "content": message})
        reply = call_claude(system, messages)
        history.append({"role": "user", "content": message})
        history.append({"role": "assistant", "content": reply})
        save_json(CHAT_FILE, history[-40:])
        return jsonify({"reply": reply, "time": now()})
    except Exception as e:
        return jsonify({"reply": f"Error: {e}", "time": now()})

@app.route("/api/jarvis/command", methods=["POST"])
def jarvis_command():
    data       = request.json or {}
    message    = data.get("message", "").strip()
    sys_prompt = data.get("system", "")
    if not message:
        return jsonify({"raw": "", "time": now()})
    try:
        raw = call_claude(sys_prompt, [{"role": "user", "content": message}], max_tokens=1000)
        return jsonify({"raw": raw, "time": now()})
    except Exception as e:
        return jsonify({"raw": "", "reply": f"Error: {e}", "time": now()})

@app.route("/api/crm/leads")
def get_leads():
    return jsonify(load_json(LEADS_FILE, []))

@app.route("/api/crm/add", methods=["POST"])
def add_lead():
    leads = load_json(LEADS_FILE, [])
    data  = request.json or {}
    data["id"] = next_id(leads)
    data["created"] = int(time.time() * 1000)
    leads.append(data)
    save_json(LEADS_FILE, leads)
    return jsonify({"success": True, "id": data["id"]})

@app.route("/api/crm/update", methods=["POST"])
def update_lead():
    leads = load_json(LEADS_FILE, [])
    data  = request.json or {}
    lid   = data.get("id")
    for i, l in enumerate(leads):
        if l.get("id") == lid:
            leads[i].update(data)
            break
    save_json(LEADS_FILE, leads)
    return jsonify({"success": True})

@app.route("/api/crm/delete", methods=["POST"])
def delete_lead():
    leads = load_json(LEADS_FILE, [])
    lid   = (request.json or {}).get("id")
    leads = [l for l in leads if l.get("id") != lid]
    save_json(LEADS_FILE, leads)
    return jsonify({"success": True})

@app.route("/api/calendar/events")
def get_events():
    return jsonify({"events": load_json(EVENTS_FILE, [])})

@app.route("/api/calendar/add", methods=["POST"])
def add_event():
    events = load_json(EVENTS_FILE, [])
    data   = request.json or {}
    data["id"] = next_id(events)
    events.append(data)
    save_json(EVENTS_FILE, events)
    return jsonify({"success": True})

@app.route("/api/calendar/delete", methods=["POST"])
def delete_event():
    events = load_json(EVENTS_FILE, [])
    eid    = (request.json or {}).get("id")
    events = [e for e in events if e.get("id") != eid]
    save_json(EVENTS_FILE, events)
    return jsonify({"success": True})

@app.route("/api/memory")
def get_memory():
    return jsonify(load_json(MEMORY_FILE, {"facts": []}))

@app.route("/api/memory/add", methods=["POST"])
def add_memory():
    mem  = load_json(MEMORY_FILE, {"facts": []})
    fact = (request.json or {}).get("fact", "").strip()
    if fact:
        mem["facts"].append(fact)
        save_json(MEMORY_FILE, mem)
    return jsonify({"success": True})

@app.route("/api/memory/clear", methods=["POST"])
def clear_memory():
    save_json(MEMORY_FILE, {"facts": []})
    return jsonify({"success": True})

@app.route("/api/team")
def get_team():
    return jsonify(load_json(TEAM_FILE, []))

@app.route("/api/team/add", methods=["POST"])
def add_team():
    team = load_json(TEAM_FILE, [])
    data = request.json or {}
    data["id"] = next_id(team)
    team.append(data)
    save_json(TEAM_FILE, team)
    return jsonify({"success": True})

@app.route("/api/team/delete", methods=["POST"])
def delete_team():
    team = load_json(TEAM_FILE, [])
    tid  = (request.json or {}).get("id")
    team = [t for t in team if t.get("id") != tid]
    save_json(TEAM_FILE, team)
    return jsonify({"success": True})

@app.route("/api/transactions")
def get_transactions():
    return jsonify(load_json(TRANS_FILE, []))

@app.route("/api/transactions/add", methods=["POST"])
def add_transaction():
    trans = load_json(TRANS_FILE, [])
    data  = request.json or {}
    data["id"] = next_id(trans)
    trans.append(data)
    save_json(TRANS_FILE, trans)
    return jsonify({"success": True})

@app.route("/api/transactions/delete", methods=["POST"])
def delete_transaction():
    trans = load_json(TRANS_FILE, [])
    tid   = (request.json or {}).get("id")
    trans = [t for t in trans if t.get("id") != tid]
    save_json(TRANS_FILE, trans)
    return jsonify({"success": True})

@app.route("/api/chat/history")
def chat_history():
    return jsonify(load_json(CHAT_FILE, []))

@app.route("/api/chat/clear", methods=["POST"])
def clear_chat():
    save_json(CHAT_FILE, [])
    return jsonify({"success": True})

@app.route("/api/sms/send", methods=["POST"])
def send_sms():
    data = request.json or {}
    sid  = os.getenv("TWILIO_ACCOUNT_SID", "")
    tok  = os.getenv("TWILIO_AUTH_TOKEN", "")
    frm  = os.getenv("TWILIO_PHONE_NUMBER", "")
    if not (sid.startswith("AC") and tok and frm):
        return jsonify({"success": False, "error": "Twilio not configured"})
    try:
        import urllib.request as ur, base64
        body  = f"To={data.get('to','')}&From={frm}&Body={data.get('message','')}".encode()
        creds = base64.b64encode(f"{sid}:{tok}".encode()).decode()
        req   = ur.Request(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
                           data=body, headers={"Authorization": f"Basic {creds}",
                           "Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        with ur.urlopen(req) as resp:
            r = json.loads(resp.read())
        return jsonify({"success": True, "sid": r.get("sid", "")})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 7000))
    print(f"\n  JARVIS 2.0 CLOUD — http://localhost:{port}\n")
    app.run(host="0.0.0.0", port=port, debug=False)
