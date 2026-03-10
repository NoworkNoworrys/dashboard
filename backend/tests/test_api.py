"""
Integration tests for backend/server.py API endpoints.

Uses FastAPI's TestClient (backed by httpx) to spin up the app in-process
without needing a real uvicorn server. The pipeline is NOT started and a
fresh temp SQLite DB is used so tests never touch the real events.db.

Strategy for DB isolation:
  event_store.get_store() is a singleton that caches the real DB path.
  We patch `server.get_store` directly (the name imported into server's
  namespace) to return a fresh EventStore pointing at a temp file.

Endpoints tested:
  GET /          — dashboard HTML
  GET /api/status
  GET /api/events
  GET /api/market
  GET /api/learning
  GET /api/regime
  GET /api/correlation
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from contextlib import asynccontextmanager
from unittest.mock import patch


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope='module')
def _fresh_db(tmp_path_factory):
    """Temp SQLite path — one per test module run."""
    return str(tmp_path_factory.mktemp('db') / 'test_events.db')


@pytest.fixture(scope='module')
def client(_fresh_db):
    """
    TestClient with empty DB and pipeline disabled.
    Patches server.get_store → fresh EventStore on temp DB.
    """
    import event_store as es
    import server as srv
    from fastapi.testclient import TestClient

    fresh_store = es.EventStore(_fresh_db)

    @asynccontextmanager
    async def _noop_lifespan(app):
        yield

    srv.app.router.lifespan_context = _noop_lifespan

    with patch.object(srv, 'get_store', return_value=fresh_store):
        with TestClient(srv.app, raise_server_exceptions=True) as c:
            yield c


@pytest.fixture(scope='module')
def seeded_client(_fresh_db):
    """
    TestClient with 5 pre-seeded events in the temp DB.
    Uses the same temp DB as `client` fixture — called after it so events
    are appended. In practice these run in separate test classes.
    """
    import event_store as es
    import server as srv
    from keyword_detector import build_event
    from fastapi.testclient import TestClient

    store = es.EventStore(_fresh_db)

    seed_events = [
        build_event('Iran launches airstrike on US base',   'Officials confirm attack',    'BBC',      src_count=2),
        build_event('Russia deploys troops near border',    'NATO responds with alert',    'Reuters',  src_count=1),
        build_event('Taiwan strait tensions rising',        'PLA exercises near island',   'AP',       src_count=3),
        build_event('Gold hits all-time high',              'Safe-haven demand surges',    'Bloomberg',src_count=1),
        build_event('Peace talks resume in Geneva',         'Ceasefire terms discussed',   'BBC',      src_count=1),
    ]
    for evt in seed_events:
        store.insert(evt)

    @asynccontextmanager
    async def _noop_lifespan(app):
        yield

    srv.app.router.lifespan_context = _noop_lifespan

    with patch.object(srv, 'get_store', return_value=store):
        with TestClient(srv.app, raise_server_exceptions=True) as c:
            yield c


# ── GET / ────────────────────────────────────────────────────────────────────

class TestServeDashboard:

    def test_dashboard_returns_200(self, client):
        r = client.get('/')
        assert r.status_code == 200

    def test_dashboard_content_type_html(self, client):
        r = client.get('/')
        assert 'text/html' in r.headers.get('content-type', '')

    def test_dashboard_contains_geointel(self, client):
        r = client.get('/')
        assert 'GeoIntel' in r.text or 'geointel' in r.text.lower()


# ── GET /api/status ───────────────────────────────────────────────────────────

class TestApiStatus:

    def test_status_200(self, client):
        assert client.get('/api/status').status_code == 200

    def test_status_has_ok(self, client):
        assert client.get('/api/status').json().get('status') == 'ok'

    def test_status_has_required_fields(self, client):
        body = client.get('/api/status').json()
        for field in ('status', 'clients', 'events', 'ts'):
            assert field in body, f'Missing field: {field}'

    def test_status_ts_is_int(self, client):
        ts = client.get('/api/status').json()['ts']
        assert isinstance(ts, int) and ts > 0

    def test_status_clients_zero_in_test(self, client):
        assert client.get('/api/status').json()['clients'] == 0

    def test_status_events_zero_on_empty_db(self, client):
        assert client.get('/api/status').json()['events'] == 0


# ── GET /api/events ───────────────────────────────────────────────────────────

class TestApiEvents:

    def test_events_200(self, client):
        assert client.get('/api/events').status_code == 200

    def test_events_has_events_list(self, client):
        body = client.get('/api/events').json()
        assert 'events' in body
        assert isinstance(body['events'], list)

    def test_events_has_count(self, client):
        body = client.get('/api/events').json()
        assert 'count' in body
        assert body['count'] == len(body['events'])

    def test_events_limit_param_accepted(self, client):
        assert client.get('/api/events?limit=5').status_code == 200

    def test_events_empty_on_fresh_db(self, client):
        assert client.get('/api/events').json()['count'] == 0


# ── GET /api/market ───────────────────────────────────────────────────────────

class TestApiMarket:

    def test_market_200(self, client):
        assert client.get('/api/market').status_code == 200

    def test_market_is_dict(self, client):
        assert isinstance(client.get('/api/market').json(), dict)

    def test_market_empty_before_pipeline(self, client):
        assert client.get('/api/market').json() == {}


# ── GET /api/learning ─────────────────────────────────────────────────────────

class TestApiLearning:

    def test_learning_200(self, client):
        assert client.get('/api/learning').status_code == 200

    def test_learning_has_required_keys(self, client):
        body = client.get('/api/learning').json()
        for key in ('metrics', 'regions', 'signal_dist', 'top_keywords',
                    'top_assets', 'top_sources', 'calibration',
                    'keyword_signals', 'events', 'ts'):
            assert key in body, f'Missing key: {key}'

    def test_learning_metrics_structure(self, client):
        m = client.get('/api/learning').json()['metrics']
        for field in ('total', 'high', 'critical', 'low_noise'):
            assert field in m, f'Missing metric: {field}'

    def test_learning_signal_dist_has_all_buckets(self, client):
        sd = client.get('/api/learning').json()['signal_dist']
        for bucket in ('0-19', '20-39', '40-59', '60-79', '80-100'):
            assert bucket in sd, f'Missing bucket: {bucket}'

    def test_learning_calibration_has_expected_buckets(self, client):
        cal = client.get('/api/learning').json()['calibration']
        for bk in ('20-39', '40-59', '60-79', '80-100'):
            assert bk in cal, f'Missing calibration bucket: {bk}'

    def test_learning_keyword_signals_is_dict(self, client):
        assert isinstance(client.get('/api/learning').json()['keyword_signals'], dict)

    def test_learning_ts_is_int(self, client):
        ts = client.get('/api/learning').json()['ts']
        assert isinstance(ts, int) and ts > 0

    def test_learning_limit_param(self, client):
        assert client.get('/api/learning?limit=10').status_code == 200


# ── GET /api/regime ───────────────────────────────────────────────────────────

class TestApiRegime:

    def test_regime_200(self, client):
        assert client.get('/api/regime').status_code == 200

    def test_regime_has_required_fields(self, client):
        body = client.get('/api/regime').json()
        for field in ('regime', 'regime_score', 'regime_desc', 'asset_biases', 'ts'):
            assert field in body, f'Missing field: {field}'

    def test_regime_unknown_when_no_market_data(self, client):
        # Market cache is empty → VIX = None → UNKNOWN
        assert client.get('/api/regime').json()['regime'] == 'UNKNOWN'

    def test_regime_asset_biases_is_dict(self, client):
        assert isinstance(client.get('/api/regime').json()['asset_biases'], dict)

    def test_regime_asset_biases_have_bias_field(self, client):
        biases = client.get('/api/regime').json()['asset_biases']
        valid  = {'LONG', 'SHORT', 'NEUTRAL', 'CROWDED', 'UNKNOWN'}
        for ticker, info in biases.items():
            assert 'bias' in info, f'{ticker} missing bias field'
            assert info['bias'] in valid, f'{ticker} bias {info["bias"]!r} not in {valid}'

    def test_regime_ts_is_int(self, client):
        ts = client.get('/api/regime').json()['ts']
        assert isinstance(ts, int) and ts > 0


# ── GET /api/correlation ──────────────────────────────────────────────────────

class TestApiCorrelation:

    def test_correlation_200(self, client):
        assert client.get('/api/correlation').status_code == 200

    def test_correlation_not_ready_before_pipeline(self, client):
        assert client.get('/api/correlation').json().get('ready') is False

    def test_correlation_has_snapshots_field(self, client):
        body = client.get('/api/correlation').json()
        assert 'snapshots' in body
        assert isinstance(body['snapshots'], int)

    def test_correlation_has_assets_list(self, client):
        body = client.get('/api/correlation').json()
        assert 'assets' in body
        assert len(body['assets']) > 0


# ── Seeded DB integration ─────────────────────────────────────────────────────

class TestSeededApiLearning:

    def test_events_count_matches_inserted(self, seeded_client):
        assert seeded_client.get('/api/events').json()['count'] == 5

    def test_learning_metrics_total_correct(self, seeded_client):
        assert seeded_client.get('/api/learning').json()['metrics']['total'] == 5

    def test_learning_metrics_are_non_negative_ints(self, seeded_client):
        m = seeded_client.get('/api/learning').json()['metrics']
        for field in ('total', 'high', 'critical', 'low_noise'):
            assert isinstance(m[field], int) and m[field] >= 0, \
                f'{field} = {m[field]} is not a non-negative int'

    def test_learning_metrics_add_up(self, seeded_client):
        m = seeded_client.get('/api/learning').json()['metrics']
        # low_noise = total − high; high ≥ critical
        assert m['low_noise'] == m['total'] - m['high']
        assert m['high'] >= m['critical']

    def test_learning_keyword_signals_non_empty(self, seeded_client):
        ks = seeded_client.get('/api/learning').json()['keyword_signals']
        assert len(ks) > 0

    def test_learning_keyword_signal_structure(self, seeded_client):
        ks = seeded_client.get('/api/learning').json()['keyword_signals']
        for kw, info in ks.items():
            assert 'count'        in info, f'{kw}: missing count'
            assert 'corroborated' in info, f'{kw}: missing corroborated'
            assert 'corr_rate'    in info, f'{kw}: missing corr_rate'
            assert 0 <= info['corr_rate'] <= 100

    def test_learning_top_keywords_non_empty(self, seeded_client):
        assert len(seeded_client.get('/api/learning').json()['top_keywords']) > 0

    def test_learning_regions_detected(self, seeded_client):
        # Should detect IRAN/RUSSIA/TAIWAN from seeded titles
        regions = seeded_client.get('/api/learning').json()['regions']
        assert len(regions) >= 1

    def test_status_events_count_after_seed(self, seeded_client):
        assert seeded_client.get('/api/status').json()['events'] == 5
