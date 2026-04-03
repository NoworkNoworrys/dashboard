# Dashboard Fix Plan — For Sonnet Agent

**Created:** 2026-04-03 by Opus (full audit complete)
**Purpose:** You (Sonnet) are executing fixes. The audit is done. Follow each step in order.

**Rules:**
- Only edit files inside `/Users/morgan/Claude Code/`
- Never start servers or open new ports — the server runs permanently on localhost:8080
- Never call `preview_start` or `preview_stop`
- Test nothing by running the app — just make the code changes
- Do NOT add unnecessary comments, docstrings, or refactors beyond what each step requires
- Keep changes minimal and surgical — fix the issue, nothing more

---

## PHASE 1: CRITICAL FIXES

These must all be completed before moving to Phase 2.

---

### CRIT-1: Whitelist HLBroker backend URL

**File:** `HLBroker.js`
**Line:** ~26
**What:** The `BACKEND` variable is hardcoded to `http://localhost:8765` but nothing prevents it being changed (e.g. via XSS or DOM manipulation). If changed, private keys get sent to an attacker's server.

**Fix:** After the `BACKEND` variable declaration, add a validation check in the function that sends the private key to the backend. Find the function that POSTs to `BACKEND + '/api/hl/...'` endpoints (the connect/order functions). At the top of each function that sends sensitive data (private key, order signing), add:

```javascript
if (BACKEND !== 'http://localhost:8765' && BACKEND !== 'http://127.0.0.1:8765') {
  console.error('[HLBroker] BLOCKED: backend URL is not localhost — refusing to send credentials');
  return Promise.reject('Backend URL not whitelisted');
}
```

Also make the BACKEND variable a `const` if it isn't already (use `var` since this is vanilla JS in an IIFE — just don't reassign it).

---

### CRIT-2: Fix trades_store race condition

**File:** `backend/trades_store.py`
**What:** The `upsert()` function checks if a trade is CLOSED before writing, but the check and write are not atomic. Between the SELECT and the INSERT/UPDATE, another thread could close the trade.

**Fix:** Replace the two-step check-then-write with a single atomic SQL statement. Find the upsert function and replace the pattern:

```python
# REPLACE THIS PATTERN:
#   1. SELECT status WHERE trade_id = ?
#   2. if status == 'CLOSED': return
#   3. INSERT OR REPLACE ...

# WITH THIS:
def upsert(trade: dict) -> None:
    trade_id = trade.get('trade_id')
    if not trade_id:
        return
    with _lock:
        with _get_conn() as conn:
            # Never downgrade CLOSED → OPEN in a single atomic operation
            if trade.get('status') == 'OPEN':
                existing = conn.execute(
                    "SELECT status FROM trades WHERE trade_id = ?", [trade_id]
                ).fetchone()
                if existing and existing[0] == 'CLOSED':
                    return
            # Now do the actual upsert (keep existing upsert SQL as-is)
            # ... rest of existing upsert logic stays inside this same `with _lock` block
```

The key change: ensure the SELECT check AND the INSERT/REPLACE both happen inside the same `with _lock` block with no gap between them. Read the existing code carefully — if they're already in the same lock block, check whether `_get_conn()` is called twice (once for check, once for write). If so, combine into a single connection.

---

### CRIT-3: Fix uncleared intervals in agents

**Files:** `agents/live-portfolio.js`, `agents/event-momentum-agent.js`, `agents/gii-scalper-session.js`

**What:** `setInterval` is called without guarding against double-initialization. If `init()` runs twice, duplicate intervals stack up, causing memory leaks.

**Fix:** In each file, find the `init()` or equivalent startup function. Add an initialization guard at the top:

```javascript
var _initialized = false;

// Then at the start of init():
function init() {
  if (_initialized) return;
  _initialized = true;
  // ... existing init code
}
```

If the file already has something like `if (_interval) clearInterval(_interval)` before setting a new interval, that's partially okay but still add the `_initialized` guard as a safety net.

Search all 65 agent files for `setInterval` calls. Any agent that sets an interval in its init/startup path should have this guard. The three files above are confirmed, but grep for others:

```
grep -rn "setInterval" agents/
```

---

### CRIT-4: Enforce MAX_SIGNALS caps in agents

**Files:** Multiple agents — grep to find them all.

**What:** Signal arrays (`_signals`) grow without bounds. Some agents define `MAX_SIGNALS` but don't enforce it after every push.

**Fix:** Run this search:
```
grep -rn "_signals.push\|_signals.unshift" agents/
```

For every match, check if there's a cap enforced immediately after. If not, add one:

```javascript
_signals.push(sig);
if (_signals.length > MAX_SIGNALS) _signals.shift();
```

If `MAX_SIGNALS` isn't defined in that file, add it at the top of the IIFE:
```javascript
var MAX_SIGNALS = 200;
```

Same pattern applies to any array that accumulates data: `_events`, `_history`, `_log`, etc. Search for `.push(` in agents/ and verify each one has a cap.

---

### CRIT-5: Fix executionEngine.js localStorage write queue race

**File:** `executionEngine.js`

**What:** If the backend goes offline, trades queue to `_writeQueue`. When it comes back, the queue flushes — but new trades can be written simultaneously, causing out-of-order persistence.

**Fix:** Find the queue flush function (search for `_writeQueue` or `_flushQueue`). Add a flushing guard:

```javascript
var _flushing = false;

function _flushQueue() {
  if (_flushing) return;
  _flushing = true;
  // ... existing flush logic (process queue items)
  // At the end (in the finally/completion):
  _flushing = false;
}
```

If the flush is async (uses fetch/then), set `_flushing = false` in both the `.then()` and `.catch()` callbacks.

---

### CRIT-6: Add .env wildcard to .gitignore

**File:** `.gitignore`

**What:** Only specific env files are listed. A developer could accidentally commit `.env.local`, `.env.production`, etc.

**Fix:** Add these lines to `.gitignore`:

```
.env*
!.env.example
*.local.json
secrets/
```

Check that existing specific entries like `backend/.env` are still there (redundant but harmless). The wildcard `.env*` catches everything.

---

## PHASE 2: HIGH FIXES

Complete all of Phase 1 before starting these.

---

### HIGH-1: Replace broad exception handlers in backend ingest modules

**Files:** `backend/config.py`, `backend/hl_broker.py`, multiple files in `backend/ingest/`

**What:** Many `except Exception: pass` blocks silently swallow errors, hiding API failures, auth issues, and data corruption.

**Fix:** Search for bare exception handlers:
```
grep -rn "except Exception" backend/
```

For each match:
- If it says `except Exception: pass` — replace with `except Exception as e: print(f'[MODULE_NAME] Error: {e}')`
- If it says `except Exception as e: pass` — add the print
- Do NOT change the control flow (don't add `raise`) — just add logging

Example in `backend/hl_broker.py` around lines 117-118:
```python
# FROM:
except Exception:
    pass

# TO:
except Exception as e:
    print(f'[HL_BROKER] leverage update failed: {e}')
```

Do this for every `except Exception: pass` in the backend. There are roughly 15-20 of them.

---

### HIGH-2: Add input validation to /api/trades endpoint

**File:** `backend/server.py`

**What:** The POST `/api/trades` endpoint accepts any JSON without validation. Invalid data corrupts the database.

**Fix:** Find the `trades_create` function. Add validation before calling `trades_store.upsert()`:

```python
REQUIRED_TRADE_FIELDS = {'trade_id', 'asset', 'direction', 'status'}
VALID_STATUSES = {'OPEN', 'CLOSED'}

@app.post('/api/trades')
async def trades_create(request: Request):
    body = await request.json()
    trades = body if isinstance(body, list) else [body]
    for trade in trades:
        # Validate required fields
        missing = REQUIRED_TRADE_FIELDS - set(trade.keys())
        if missing:
            return JSONResponse({'ok': False, 'error': f'Missing fields: {missing}'}, status_code=400)
        if trade.get('status') not in VALID_STATUSES:
            return JSONResponse({'ok': False, 'error': f'Invalid status: {trade.get("status")}'}, status_code=400)
        if trade.get('entry_price') is not None:
            try:
                p = float(trade['entry_price'])
                if p <= 0 or p > 1e9:
                    return JSONResponse({'ok': False, 'error': f'Invalid entry_price: {p}'}, status_code=400)
            except (ValueError, TypeError):
                return JSONResponse({'ok': False, 'error': 'entry_price must be numeric'}, status_code=400)
    # Then proceed with existing upsert logic
    for trade in trades:
        await asyncio.get_event_loop().run_in_executor(None, trades_store.upsert, trade)
    return {'ok': True}
```

---

### HIGH-3: Fix timestamp bounds in unusual_whales.py

**File:** `backend/ingest/unusual_whales.py`

**What:** Timestamp parsing can produce values in year 2087+ if API returns nanoseconds.

**Fix:** Find the timestamp parsing block (around lines 211-215). Replace with:

```python
MIN_TS_MS = 631152000000   # Jan 1990
MAX_TS_MS = 2524608000000  # Jan 2050

try:
    ts_raw = float(alert.get('created_at') or alert.get('start_time') or alert.get('ts') or 0)
    if ts_raw < 1e10:       # seconds
        ts = int(ts_raw * 1000)
    elif ts_raw < 1e13:     # milliseconds
        ts = int(ts_raw)
    elif ts_raw < 1e16:     # microseconds
        ts = int(ts_raw / 1000)
    else:                   # nanoseconds
        ts = int(ts_raw / 1e6)
    if not (MIN_TS_MS <= ts <= MAX_TS_MS):
        ts = int(time.time() * 1000)
except (ValueError, TypeError):
    ts = int(time.time() * 1000)
```

---

### HIGH-4: Fix stale price retention in market_data.py

**File:** `backend/market_data.py`

**What:** When Stooq returns N/D, old prices are kept and marked `stale=True`. Consumers don't check this flag.

**Fix:** Find `_fetch_stooq_cached()` (around line 100). Change the stale handling:

```python
# Instead of keeping stale prices indefinitely, add a TTL
import time

STALE_TTL_MS = 3600000  # 1 hour

for ticker in list(merged.keys()):
    if ticker not in result:
        entry = merged[ticker]
        if not entry.get('stale'):
            entry['stale'] = True
            entry['stale_since'] = int(time.time() * 1000)
        elif int(time.time() * 1000) - entry.get('stale_since', 0) > STALE_TTL_MS:
            del merged[ticker]  # Remove after 1 hour stale
```

Also search `server.py` for where stale prices are used in the regime detector (around lines 329-331). Add a guard:

```python
if price_data and not price_data.get('stale'):
    # use it
```

---

### HIGH-5: Reduce negation window in keyword_detector.py

**File:** `backend/keyword_detector.py`
**Line:** ~32

**What:** `_NEGATION_WINDOW = 60` is too wide — catches negations from adjacent sentences.

**Fix:** Change to:
```python
_NEGATION_WINDOW = 20  # ~3-4 words, within same clause
```

---

### HIGH-6: Add null safety for GII.gti() across agents

**Files:** ~50 agent files in `agents/`

**What:** Agents check `if (window.GII && typeof GII.gti === 'function')` but don't verify the return value is a number.

**Fix:** Search for the pattern:
```
grep -rn "GII.gti()" agents/
```

For each match, find where the GTI value is used and ensure there's a type check:

```javascript
// FROM:
var _gti = GII.gti();
if (_gti && _gti.value != null) {
  // use _gti.value as number
}

// TO:
var _gti = GII.gti();
if (_gti && typeof _gti.value === 'number' && isFinite(_gti.value)) {
  // use _gti.value as number
}
```

This is a repetitive find-and-replace across many files. The pattern is consistent.

---

### HIGH-7: Fix localStorage quota handling in gii-core.js

**File:** `gii-core.js`

**What:** `localStorage.setItem()` calls can throw when quota is exceeded. Currently caught with empty catch blocks, silently losing feedback data.

**Fix:** Find all `localStorage.setItem` calls in `gii-core.js`. Replace the catch blocks:

```javascript
// FROM:
try { localStorage.setItem(KEY, JSON.stringify(data)); } catch(e) {}

// TO:
try {
  localStorage.setItem(KEY, JSON.stringify(data));
} catch(e) {
  console.warn('[GII] localStorage quota exceeded for ' + KEY + ' — trimming data');
  // Trim the data and retry
  if (Array.isArray(data) && data.length > 50) {
    data = data.slice(-50);
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch(e2) {}
  }
}
```

Apply the same pattern to `gii-scalper-brain.js` and `executionEngine.js` where localStorage writes occur.

---

### HIGH-8: Add cooldown pruning to agents

**Files:** `agents/crypto-signals-agent.js`, `agents/technicals-agent.js`, `agents/momentum-agent.js`, `agents/gii-entry.js`

**What:** Cooldown objects (`_cooldowns = {}`) grow forever. Old expired entries are never removed.

**Fix:** In each file that has a `_cooldowns` object, add a pruning function and call it hourly:

```javascript
function _pruneCooldowns() {
  var cutoff = Date.now() - COOLDOWN_MS;
  var keys = Object.keys(_cooldowns);
  for (var i = 0; i < keys.length; i++) {
    if (_cooldowns[keys[i]] < cutoff) {
      delete _cooldowns[keys[i]];
    }
  }
}
setInterval(_pruneCooldowns, 3600000); // every hour
```

Search for `_cooldowns` or `_cooldown` across all agents:
```
grep -rn "_cooldown" agents/
```

---

### HIGH-9: Escape innerHTML in gii-ui.js

**File:** `gii-ui.js`

**What:** `content.innerHTML = html` where `html` is built from agent outputs. If any agent output contains user-controlled data from APIs, XSS is possible.

**Fix:** Find the main render function where `innerHTML` is set. For any data coming from agent signals or API responses, escape it before insertion:

Add this utility at the top of the IIFE:
```javascript
function _esc(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
```

Then find where agent reasons/descriptions are interpolated into HTML strings. Wrap them with `_esc()`:

```javascript
// FROM:
html += '<td>' + sig.reason + '</td>';

// TO:
html += '<td>' + _esc(sig.reason) + '</td>';
```

Apply `_esc()` to any field that comes from external data: `reason`, `asset` names from APIs, event descriptions, etc. Do NOT escape fields that are known constants (like CSS classes or internal labels).

---

## PHASE 3: MEDIUM FIXES

These are lower priority. Complete Phases 1 and 2 first. Skip any of these if time is limited.

---

### MED-1: Add retry logic to backend ingest modules

**File:** `backend/pipeline.py`

**What:** No retry on transient failures. One network hiccup = missed data for that 60s cycle.

**Fix:** Add a retry wrapper in `pipeline.py` and use it when calling ingest functions:

```python
import time as _time

def _fetch_with_retry(fn, name, max_retries=2, backoff=0.5):
    for attempt in range(max_retries + 1):
        try:
            return fn()
        except Exception as e:
            if attempt < max_retries:
                _time.sleep(backoff * (attempt + 1))
                print(f'[PIPELINE] {name} retry {attempt + 1}/{max_retries}: {e}')
            else:
                print(f'[PIPELINE] {name} failed after {max_retries} retries: {e}')
                return []
```

Then wrap ingest calls in the pipeline's main fetch loop with `_fetch_with_retry(lambda: module.fetch(), 'module_name')`.

---

### MED-2: Add WebSocket reconnect backoff to hl-feed.js

**File:** `hl-feed.js`

**What:** Fixed 12s reconnect interval floods the server if it's down.

**Fix:** Find `RECONNECT_MS` and the reconnect logic. Replace with exponential backoff:

```javascript
var _reconnectDelay = 1000;  // start at 1s
var MAX_RECONNECT_DELAY = 60000;  // cap at 60s

function _scheduleReconnect() {
  setTimeout(function() {
    _connect();
    _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }, _reconnectDelay);
}

// On successful connection, reset:
function _onOpen() {
  _reconnectDelay = 1000;
  // ... existing onopen logic
}
```

---

### MED-3: Fix trade ID collision risk in executionEngine.js

**File:** `executionEngine.js`

**What:** Trade IDs use `Math.random() * 0xFFFF` — only 65K possible values, collision likely after ~256 trades.

**Fix:** Find the trade ID generation (search for `0xFFFF` or `Math.random`). Replace with:

```javascript
function _genTradeId() {
  var ts = Date.now().toString(36);
  var r = Math.random().toString(36).substr(2, 8);
  return ts + '_' + r;
}
```

This gives timestamp-based uniqueness plus 8 random alphanumeric chars.

---

### MED-4: Add signal deduplication in execution engine

**File:** `executionEngine.js`

**What:** Multiple agents can emit the same asset+direction signal in one cycle, inflating confidence.

**Fix:** Find `EE.onSignals()` or wherever signals are received in batch. Add dedup before processing:

```javascript
function _dedupSignals(sigs) {
  var seen = {};
  var result = [];
  for (var i = 0; i < sigs.length; i++) {
    var key = sigs[i].asset + ':' + sigs[i].dir;
    if (!seen[key]) {
      seen[key] = true;
      result.push(sigs[i]);
    } else {
      // Keep the higher confidence one
      for (var j = 0; j < result.length; j++) {
        if (result[j].asset + ':' + result[j].dir === key && sigs[i].conf > result[j].conf) {
          result[j] = sigs[i];
          break;
        }
      }
    }
  }
  return result;
}
```

Call this at the top of `onSignals()` before any processing.

---

### MED-5: Add localStorage expiry to agent caches

**Files:** `agents/gii-escalation.js`, `agents/gii-smartmoney.js`, `agents/gii-marketstructure.js`, `agents/macro-regime.js`

**What:** Data cached to localStorage loads on restart with no age check. Can be days old.

**Fix:** When saving to localStorage, include a timestamp:
```javascript
localStorage.setItem(KEY, JSON.stringify({ ts: Date.now(), data: _data }));
```

When loading, check the age:
```javascript
var raw = localStorage.getItem(KEY);
if (raw) {
  var parsed = JSON.parse(raw);
  if (parsed.ts && (Date.now() - parsed.ts) < 86400000) { // 24h max
    _data = parsed.data;
  }
}
```

Search for `localStorage.getItem` in agents/ to find all instances that need this.

---

### MED-6: Add global variable locks in pipeline.py

**File:** `backend/pipeline.py`

**What:** `_source_status` dict is written by the pipeline thread and read by the server's `/api/sources` endpoint without a lock.

**Fix:** Add a lock around `_source_status` access:

```python
import threading
_status_lock = threading.Lock()

def _update_source(name: str, count: int, error: str = ''):
    with _status_lock:
        _source_status[name] = {
            'name': name,
            'count': count,
            'error': error,
            'ts': int(time.time() * 1000)
        }

def get_source_status():
    with _status_lock:
        return dict(_source_status)
```

Update the server endpoint that reads `_source_status` to call `get_source_status()` instead of accessing the dict directly.

---

## CHECKLIST

When all fixes are complete, verify:

- [ ] `grep -rn "except Exception: pass" backend/` returns 0 results
- [ ] `grep -rn "except Exception:" backend/` — all have logging
- [ ] `.gitignore` contains `.env*`
- [ ] No `setInterval` in agents/ without an `_initialized` guard
- [ ] All `_signals.push()` in agents/ are followed by a length cap
- [ ] `HLBroker.js` has backend URL whitelist check
- [ ] `trades_store.py` upsert is atomic (check + write in same lock)
- [ ] `gii-ui.js` has `_esc()` function and uses it on external data

---

**End of plan. Execute in order: Phase 1 → Phase 2 → Phase 3.**
