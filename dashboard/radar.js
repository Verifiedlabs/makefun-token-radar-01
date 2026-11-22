(function () {
  'use strict';

  const DATA = window.TOKEN_RADAR_DATA;
  if (!DATA || !Array.isArray(DATA.rows)) {
    const tb = document.getElementById('table-body');
    if (tb) tb.innerHTML = '<tr><td colspan="7" class="empty-state">Missing radar dataset (../data.js).</td></tr>';
    return;
  }

  const state = {
    view: 'board',
    search: '',
    category: 'all',
    chain: 'all',
    growth: 'all',
    gas: 'all',
    sort: 'rank',
    detailSlug: null,
    insightsOpen: true,
    sandboxOpen: false,
    checkedSteps: new Set(),
    model: {
      mode: 'peer',
      baseScale: 1.0,
      growthWeight: DATA.params.growth_weight,
      maturitySpan: DATA.params.maturity_span,
      chainStep: DATA.params.chain_step,
    },
  };

  let scoredRows = [];
  const $ = function (id) { return document.getElementById(id); };

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function fmtUsd(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return a > 0 && a < 10 ? '$' + n.toFixed(2) : '$' + Math.round(n).toLocaleString('en-US');
  }

  function fmtGas(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    return n < 10 ? '$' + n.toFixed(2) : '$' + Math.round(n).toLocaleString('en-US');
  }

  function fmtPct(v) {
    if (v == null || !Number.isFinite(v)) return '<span class="delta-flat mono">n/a</span>';
    const cls = v > 0.05 ? 'delta-pos' : v < -0.05 ? 'delta-neg' : 'delta-flat';
    return '<span class="' + cls + ' mono">' + (v > 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  }

  function fmtAge(days) {
    if (days == null) return '<span class="mono">Unlisted</span>';
    if (days >= 365) return '<span class="mono">' + (days / 365).toFixed(1) + 'y</span> <span class="val-sub">(' + days + 'd)</span>';
    return '<span class="mono">' + days + 'd</span>';
  }

  function recomputeBoard() {
    const p = DATA.params;
    const m = state.model;
    const isDefault =
      m.mode === 'peer' &&
      Math.abs(m.baseScale - 1.0) < 1e-6 &&
      Math.abs(m.growthWeight - p.growth_weight) < 1e-6 &&
      Math.abs(m.maturitySpan - p.maturity_span) < 1e-6 &&
      Math.abs(m.chainStep - p.chain_step) < 1e-6;

    const list = DATA.rows.map(function (row) {
      if (isDefault) return Object.assign({}, row, { live_rank: row.rank, rank_delta: 0 });
      const baseMult = m.mode === 'peer' ? row.valuation.sector_multiple * m.baseScale : DATA.global_live_median * m.baseScale;
      const gClamped = clamp(row.change_7d == null ? 0 : row.change_7d, p.growth_floor_pct, p.growth_cap_pct);
      const gMult = 1 + (gClamped / 100) * m.growthWeight;
      const ageEff = row.age_days == null ? p.unknown_age_days : row.age_days;
      const matFloor = Math.max(0.35, 1.10 - m.maturitySpan);
      const mMult = matFloor + (clamp(ageEff, 0, p.maturity_cap_days) / p.maturity_cap_days) * m.maturitySpan;
      const extraChains = clamp(Math.max(row.chains.length - 1, 0), 0, p.chain_max_extra);
      const cMult = 1 + extraChains * m.chainStep;
      const implied = Math.max(1, Math.round(row.tvl_usd * baseMult * gMult * mMult * cMult));
      const scale = implied / Math.max(1, row.implied_value_usd);

      return Object.assign({}, row, {
        implied_value_usd: implied,
        valuation: Object.assign({}, row.valuation, {
          sector_multiple: Math.round(baseMult * 1e4) / 1e4,
          growth_mult: Math.round(gMult * 1e4) / 1e4,
          maturity_mult: Math.round(mMult * 1e4) / 1e4,
          chain_mult: Math.round(cMult * 1e4) / 1e4,
          effective_multiple: Math.round((implied / Math.max(1, row.tvl_usd)) * 1e4) / 1e4,
          low_usd: Math.max(1, Math.round(row.valuation.low_usd * scale)),
          high_usd: Math.max(implied, Math.round(row.valuation.high_usd * scale)),
        }),
      });
    });

    list.sort(function (a, b) {
      return b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1);
    });

    scoredRows = list.map(function (r, i) {
      return Object.assign({}, r, { live_rank: i + 1, rank_delta: r.rank - (i + 1) });
    });
  }

  function renderMasthead() {
    $('snapshot-date').textContent = 'Sealed Snapshot ' + DATA.as_of;
    $('model-badge').textContent = DATA.params.version;
    $('formula-foot').textContent =
      'Calibrated on ' + DATA.counts.live_comps_total + ' live non-CEX comps (median ' +
      DATA.global_live_median.toFixed(2) + 'x) · Floor ' + fmtUsd(DATA.floor_usd);
  }

  function renderKpis() {
    const totalImplied = scoredRows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    const totalTvl = DATA.counts.total_pre_token_tvl_usd;
    const wlRows = scoredRows.filter(function (r) { return r.tier === 'watchlist'; });
    const earlyRows = scoredRows.filter(function (r) { return r.tier === 'early'; });
    const growingEarly = earlyRows.filter(function (r) { return (r.change_7d || 0) > 0; }).length;
    const gasSorted = scoredRows.map(function (r) { return r.farm_summary.est_total_gas_usd; }).sort(function (a, b) { return a - b; });
    const medGas = gasSorted[Math.floor(gasSorted.length / 2)] || 0;

    const cards = [
      ['accent-emerald', 'Total Implied Value', fmtUsd(totalImplied), scoredRows.length + ' pre-token rows (' + (totalImplied / Math.max(1, totalTvl)).toFixed(2) + 'x TVL)'],
      ['accent-amber', 'Watchlist Coverage', wlRows.length + ' / ' + DATA.counts.watchlist_total, '100% floor (' + fmtUsd(wlRows.reduce(function (s, r) { return s + r.tvl_usd; }, 0)) + ' TVL)'],
      ['accent-teal', 'Early Radar (<$50M)', String(earlyRows.length), growingEarly + ' growing 7d · ' + fmtUsd(earlyRows.reduce(function (s, r) { return s + r.tvl_usd; }, 0)) + ' TVL'],
      ['accent-indigo', 'Live-Token Comps', String(DATA.counts.live_comps_total), 'Separated · median ' + DATA.global_live_median.toFixed(2) + 'x (IQR ' + DATA.global_live_p25.toFixed(2) + '–' + DATA.global_live_p75.toFixed(2) + 'x)'],
      ['', 'Median Farm Campaign', fmtGas(medGas) + ' gas', '$75–$500 principal · 30–75d hold'],
    ];

    $('kpi-strip').innerHTML = cards.map(function (c) {
      return '<div class="kpi-card ' + c[0] + '"><div class="kpi-label">' + esc(c[1]) + '</div><div class="kpi-value">' + esc(c[2]) + '</div><div class="kpi-sub">' + esc(c[3]) + '</div></div>';
    }).join('');

    $('cnt-board').textContent = String(scoredRows.length);
    $('cnt-watchlist').textContent = String(wlRows.length);
    $('cnt-early').textContent = String(earlyRows.length);
    $('cnt-live').textContent = String(DATA.live_comps.length);
  }

  function renderSectorChart() {
    const priority = ['Basis Trading', 'Dexs', 'Risk Curators', 'RWA', 'Yield', 'Lending'];
    const byCat = new Map(DATA.sector_multiples.map(function (s) { return [s.category, s]; }));
    const items = priority.filter(function (k) { return byCat.has(k); }).map(function (k) { return byCat.get(k); });
    items.sort(function (a, b) { return b.shrunk_multiple - a.shrunk_multiple; });

    const maxMult = Math.max(0.55, Math.max.apply(null, items.map(function (x) { return x.shrunk_multiple; })) * 1.14);
    const rowH = 16;
    const labelW = 112;
    const rightPad = 84;
    const width = 620;
    const plotW = width - labelW - rightPad;
    const height = items.length * rowH + 16;
    const medX = labelW + (DATA.global_live_median / maxMult) * plotW;

    let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Empirical Bayes sector valuation multiples">';
    svg += '<line x1="' + medX.toFixed(1) + '" y1="1" x2="' + medX.toFixed(1) + '" y2="' + (height - 13) + '" stroke="#a84d08" stroke-width="1.4" stroke-dasharray="3 3"/>';
    items.forEach(function (item, idx) {
      const y = 2 + idx * rowH;
      const barW = Math.max(4, (item.shrunk_multiple / maxMult) * plotW);
      svg += '<text x="' + (labelW - 7) + '" y="' + (y + 10) + '" text-anchor="end" fill="#3a434c" font-size="10.5" font-weight="600">' + esc(item.category) + '</text>';
      svg += '<rect x="' + labelW + '" y="' + (y + 2) + '" width="' + plotW + '" height="9" rx="3" fill="#efeae0"/>';
      svg += '<rect x="' + labelW + '" y="' + (y + 2) + '" width="' + barW.toFixed(1) + '" height="9" rx="3" fill="#0b6e4f"/>';
      svg += '<text x="' + (labelW + plotW + 6) + '" y="' + (y + 10) + '" fill="#13171b" font-family="ui-monospace, Menlo, monospace" font-size="10.5" font-weight="700">' + item.shrunk_multiple.toFixed(2) + 'x</text>';
      svg += '<text x="' + (labelW + plotW + 44) + '" y="' + (y + 10) + '" fill="#747d87" font-family="ui-monospace, Menlo, monospace" font-size="9.5">(n=' + item.peer_count + ')</text>';
    });
    svg += '<text x="' + medX.toFixed(1) + '" y="' + (height - 2) + '" text-anchor="middle" fill="#a84d08" font-family="ui-monospace, Menlo, monospace" font-size="9.2" font-weight="700">Global ' + DATA.global_live_median.toFixed(2) + 'x</text></svg>';
    $('sector-chart').innerHTML = svg;
  }

  function renderCoverageCard() {
    const wl = DATA.counts.watchlist_total;
    const early = DATA.counts.early_total;
    const live = DATA.counts.live_comps_total;
    const tot = wl + early + live;
    const wlTvl = DATA.rows.filter(function (r) { return r.tier === 'watchlist'; }).reduce(function (s, r) { return s + r.tvl_usd; }, 0);
    const earlyTvl = DATA.rows.filter(function (r) { return r.tier === 'early'; }).reduce(function (s, r) { return s + r.tvl_usd; }, 0);
    const liveMcap = DATA.live_comps.reduce(function (s, r) { return s + r.mcap_usd; }, 0);

    $('coverage-breakdown').innerHTML =
      '<div class="cov-bar-track">' +
        '<div class="cov-seg-wl" style="width:' + ((wl / tot) * 100).toFixed(1) + '%"></div>' +
        '<div class="cov-seg-early" style="width:' + ((early / tot) * 100).toFixed(1) + '%"></div>' +
        '<div class="cov-seg-live" style="width:' + ((live / tot) * 100).toFixed(1) + '%"></div>' +
      '</div>' +
      '<div class="cov-grid">' +
        '<div class="cov-stat"><div class="cov-stat-head"><i class="dot-sm" style="background:var(--amber)"></i>Watchlist</div><div class="cov-stat-val">' + wl + '</div><div class="cov-stat-meta">' + fmtUsd(wlTvl) + ' TVL</div></div>' +
        '<div class="cov-stat"><div class="cov-stat-head"><i class="dot-sm" style="background:var(--teal)"></i>Early Radar</div><div class="cov-stat-val">' + early + '</div><div class="cov-stat-meta">' + fmtUsd(earlyTvl) + ' TVL</div></div>' +
        '<div class="cov-stat"><div class="cov-stat-head"><i class="dot-sm" style="background:var(--indigo)"></i>Live Comps</div><div class="cov-stat-val">' + live + '</div><div class="cov-stat-meta">' + fmtUsd(liveMcap) + ' MCap</div></div>' +
      '</div>' +
      '<div class="cov-note"><strong>Clean Pre-Token Scope:</strong> Wrapped, staked, bridge, CEX, and versioned pools are excluded from Early Radar; all ' + live + ' live-token protocols sit in the separate Comps tab.</div>';
  }

  function populateSelects() {
    const cats = new Map();
    const chains = new Map();
    DATA.rows.forEach(function (r) {
      cats.set(r.category, (cats.get(r.category) || 0) + 1);
      r.chains.forEach(function (c) { chains.set(c, (chains.get(c) || 0) + 1); });
    });
    const catSel = $('filter-category');
    [...cats.entries()].sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); }).forEach(function (kv) {
      const o = document.createElement('option');
      o.value = kv[0];
      o.textContent = kv[0] + ' (' + kv[1] + ')';
      catSel.appendChild(o);
    });
    const chSel = $('filter-chain');
    [...chains.entries()].sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); }).slice(0, 35).forEach(function (kv) {
      const o = document.createElement('option');
      o.value = kv[0];
      o.textContent = kv[0] + ' (' + kv[1] + ')';
      chSel.appendChild(o);
    });
  }

  function filterPreToken() {
    const q = state.search.trim().toLowerCase();
    const rows = scoredRows.filter(function (r) {
      if (state.view === 'watchlist' && r.tier !== 'watchlist') return false;
      if (state.view === 'early' && r.tier !== 'early') return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && !r.chains.includes(state.chain)) return false;
      if (state.growth === 'positive' && !(r.change_7d != null && r.change_7d > 0)) return false;
      if (state.growth === 'strong' && !(r.change_7d != null && r.change_7d >= 5)) return false;
      if (state.growth === 'negative' && !(r.change_7d != null && r.change_7d < 0)) return false;
      if (state.gas === 'low' && r.farm_summary.tx_gas_usd > 0.25) return false;
      if (state.gas === 'budget' && r.farm_summary.capital_usd > 125) return false;
      if (q && !(r.name + ' ' + r.slug + ' ' + r.category + ' ' + r.chains.join(' ')).toLowerCase().includes(q)) return false;
      return true;
    });
    rows.sort(function (a, b) {
      if (state.sort === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (state.sort === 'growth') return (b.change_7d == null ? -9999 : b.change_7d) - (a.change_7d == null ? -9999 : a.change_7d);
      if (state.sort === 'multiple') return b.valuation.effective_multiple - a.valuation.effective_multiple;
      if (state.sort === 'age') return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days);
      if (state.sort === 'gas') return a.farm_summary.est_total_gas_usd - b.farm_summary.est_total_gas_usd;
      return a.live_rank - b.live_rank;
    });
    return rows;
  }

  function filterLive() {
    const q = state.search.trim().toLowerCase();
    const rows = DATA.live_comps.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && !r.chains.includes(state.chain)) return false;
      if (state.growth === 'positive' && !(r.change_7d != null && r.change_7d > 0)) return false;
      if (state.growth === 'strong' && !(r.change_7d != null && r.change_7d >= 5)) return false;
      if (state.growth === 'negative' && !(r.change_7d != null && r.change_7d < 0)) return false;
      if (q && !(r.name + ' ' + r.slug + ' ' + (r.symbol || '') + ' ' + r.category + ' ' + r.chains.join(' ')).toLowerCase().includes(q)) return false;
      return true;
    });
    rows.sort(function (a, b) {
      if (state.sort === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (state.sort === 'growth') return (b.change_7d == null ? -9999 : b.change_7d) - (a.change_7d == null ? -9999 : a.change_7d);
      if (state.sort === 'multiple') return b.mcap_tvl_ratio - a.mcap_tvl_ratio;
      return b.mcap_usd - a.mcap_usd || b.tvl_usd - a.tvl_usd;
    });
    return rows;
  }

  function renderChips(shown, total) {
    const chips = [];
    if (state.view === 'watchlist') chips.push('Watchlist');
    if (state.view === 'early') chips.push('Early <$50M');
    if (state.view === 'live') chips.push('Live Comps');
    if (state.category !== 'all') chips.push(state.category);
    if (state.chain !== 'all') chips.push(state.chain);
    if (state.growth !== 'all') chips.push('7d: ' + state.growth);
    if (state.gas !== 'all') chips.push(state.gas === 'low' ? 'Low-Fee' : '<=$125');
    if (state.search.trim()) chips.push('"' + state.search.trim() + '"');
    $('active-filter-bar').innerHTML =
      chips.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') +
      '<span class="mono"><strong>' + shown + '</strong> / ' + total + '</span>';
  }

  function chainTags(chains) {
    return chains.slice(0, 3).map(function (c) { return '<span class="chain-tag">' + esc(c) + '</span>'; }).join('') +
      (chains.length > 3 ? '<span class="chain-tag">+' + (chains.length - 3) + '</span>' : '');
  }

  function renderTable() {
    const thead = $('table-head');
    const tbody = $('table-body');
    const footer = $('table-footer');

    if (state.view === 'live') {
      const liveRows = filterLive();
      renderChips(liveRows.length, DATA.live_comps.length);
      thead.innerHTML = '<tr><th>#</th><th>Live-Token Protocol</th><th>Category</th><th class="num">Market Cap (Actual)</th><th class="num">TVL</th><th class="num">MCap / TVL</th><th class="num">7d TVL</th></tr>';
      tbody.innerHTML = liveRows.length
        ? liveRows.slice(0, 80).map(function (r, idx) {
            return '<tr>' +
              '<td><span class="rank-badge">' + (idx + 1) + '</span></td>' +
              '<td><div class="proto-cell"><div class="proto-top"><span class="proto-name">' + esc(r.name) + '</span><span class="pill pill-live">' + esc(r.symbol || 'LIVE') + '</span></div><div class="proto-chains">' + chainTags(r.chains) + '</div></div></td>' +
              '<td><span class="pill pill-cat">' + esc(r.category) + '</span></td>' +
              '<td class="num"><div class="val-main">' + fmtUsd(r.mcap_usd) + '</div><div class="val-sub">Live market cap</div></td>' +
              '<td class="num"><div class="val-main">' + fmtUsd(r.tvl_usd) + '</div></td>' +
              '<td class="num"><div class="val-main">' + r.mcap_tvl_ratio.toFixed(2) + 'x</div><div class="val-sub">Observed peer ratio</div></td>' +
              '<td class="num">' + fmtPct(r.change_7d) + '</td></tr>';
          }).join('')
        : '<tr><td colspan="7" class="empty-state">No live-token comps match the active filters.</td></tr>';
      footer.innerHTML = '<span>Trading-token protocols are strictly separated from pre-token rankings and serve solely as Empirical Bayes valuation anchors.</span><span class="mono">' + liveRows.length + ' live comps</span>';
      return;
    }

    const rows = filterPreToken();
    const total = state.view === 'watchlist' ? DATA.counts.watchlist_total : state.view === 'early' ? DATA.counts.early_total : DATA.counts.board_total;
    renderChips(rows.length, total);

    thead.innerHTML = '<tr><th>Rank</th><th>Protocol &amp; Chains</th><th class="num">Implied Value</th><th class="num">TVL</th><th class="num">7d TVL</th><th class="num">Age</th><th>Concrete Farm Snapshot</th></tr>';
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No pre-token protocols match these filters.</td></tr>';
      footer.innerHTML = '<span>0 protocols shown</span><span>Click Clear to reset</span>';
      return;
    }

    const maxVal = Math.max(1, scoredRows[0] ? scoredRows[0].implied_value_usd : 1);
    tbody.innerHTML = rows.map(function (r) {
      const rankCls = r.live_rank <= 3 ? 'rank-badge top3' : r.live_rank <= 10 ? 'rank-badge top10' : 'rank-badge';
      const tierPill = r.tier === 'watchlist' ? '<span class="pill pill-wl">Watchlist</span>' : '<span class="pill pill-early">Early</span>';
      const delta = r.rank_delta > 0 ? ' <span class="val-sub" style="color:var(--emerald)">▲' + r.rank_delta + '</span>'
        : r.rank_delta < 0 ? ' <span class="val-sub" style="color:var(--crimson)">▼' + Math.abs(r.rank_delta) + '</span>' : '';
      const barPct = clamp(Math.round((Math.log10(r.implied_value_usd + 1) / Math.log10(maxVal + 1)) * 100), 6, 100);
      const fs = r.farm_summary;
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.detailSlug === r.slug ? ' class="is-selected"' : '') + '>' +
        '<td><span class="' + rankCls + '">#' + r.live_rank + '</span>' + delta + '</td>' +
        '<td><div class="proto-cell"><div class="proto-top"><span class="proto-name">' + esc(r.name) + '</span>' + tierPill + '<span class="pill pill-cat">' + esc(r.category) + '</span></div><div class="proto-chains">' + chainTags(r.chains) + '</div></div></td>' +
        '<td class="num"><div class="val-main">' + fmtUsd(r.implied_value_usd) + '</div><div class="val-sub">' + r.valuation.effective_multiple.toFixed(2) + 'x · ' + fmtUsd(r.valuation.low_usd) + '–' + fmtUsd(r.valuation.high_usd) + '</div><div class="mini-bar-wrap"><div class="mini-bar-fill" style="width:' + barPct + '%"></div></div></td>' +
        '<td class="num"><div class="val-main">' + fmtUsd(r.tvl_usd) + '</div><div class="val-sub">' + r.chains.length + (r.chains.length === 1 ? ' chain' : ' chains') + '</div></td>' +
        '<td class="num">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td><div class="farm-brief"><div class="farm-brief-meta"><strong>$' + fs.capital_usd + '</strong> on <strong>' + esc(fs.primary_chain) + '</strong>' + (fs.secondary_chain ? ' + ' + esc(fs.secondary_chain) : '') + '<br><span class="mono">~' + fmtGas(fs.est_total_gas_usd) + ' gas · ' + fs.hold_days + 'd · ' + fs.setup_minutes + 'm setup</span></div><button type="button" class="btn-farm" data-open-slug="' + esc(r.slug) + '">Plan &rarr;</button></div></td>' +
        '</tr>';
    }).join('');

    footer.innerHTML = '<span>Click any row to open its full valuation waterfall, live peer comps, and interactive farm checklist.</span><span class="mono">' + rows.length + ' pre-token protocols · ' + esc(DATA.as_of) + '</span>';
  }

  function openDetail(slug) {
    const row = scoredRows.find(function (r) { return r.slug === slug; });
    if (!row) return;
    state.detailSlug = slug;

    const v = row.valuation;
    const fs = row.farm_summary;
    const catComps = DATA.live_comps.filter(function (c) { return c.category === row.category; }).slice(0, 3);
    const comps = catComps.length ? catComps : DATA.live_comps.slice(0, 3);
    const compsLabel = catComps.length ? 'Live-Token Peer Comps in ' + row.category : 'Global Live-Token Reference Comps';
    const markerPct = clamp(Math.round(((row.implied_value_usd - v.low_usd) / Math.max(1, v.high_usd - v.low_usd)) * 100), 8, 92);

    const stepsHtml = row.farm_plan.map(function (step, idx) {
      const key = row.slug + ':' + idx;
      const done = state.checkedSteps.has(key);
      return '<label class="step-card' + (done ? ' is-done' : '') + '">' +
        '<input type="checkbox" class="step-check" data-step-key="' + esc(key) + '"' + (done ? ' checked' : '') + '>' +
        '<div><div class="step-phase">' + esc(step.phase) + '</div><div class="step-action">' + esc(step.action) + '</div>' +
        '<div class="step-meta"><span class="step-cost">Cost: ' + esc(step.cost) + '</span><span class="step-time">Time: ' + esc(step.time) + '</span></div></div></label>';
    }).join('');

    const compsHtml = comps.map(function (c) {
      return '<tr><td><strong>' + esc(c.name) + '</strong> ' + (c.symbol ? '<span class="pill pill-live">' + esc(c.symbol) + '</span>' : '') + '</td>' +
        '<td class="num">' + fmtUsd(c.mcap_usd) + '</td><td class="num">' + fmtUsd(c.tvl_usd) + '</td><td class="num"><strong>' + c.mcap_tvl_ratio.toFixed(2) + 'x</strong></td></tr>';
    }).join('');

    $('drawer-content').innerHTML =
      '<div class="drawer-head"><div>' +
        '<div class="proto-top"><span class="rank-badge top3">#' + row.live_rank + '</span>' +
          (row.tier === 'watchlist' ? '<span class="pill pill-wl">Watchlist</span>' : '<span class="pill pill-early">Early Radar</span>') +
          '<span class="pill pill-cat">' + esc(row.category) + '</span><span class="pill pill-cat">No Token Recorded</span></div>' +
        '<h2 class="drawer-title">' + esc(row.name) + '</h2>' +
        '<div class="val-sub">Slug: ' + esc(row.slug) + ' · Listed: ' + esc(row.listed_at || 'Unreported') + ' · Chains: ' + esc(row.chains.slice(0, 6).join(', ')) + (row.chains.length > 6 ? ' +' + (row.chains.length - 6) : '') + '</div>' +
      '</div><button type="button" class="drawer-close" id="drawer-close-btn">Close &times;</button></div>' +

      '<div class="drawer-metrics">' +
        '<div class="d-metric"><div class="d-metric-label">Implied Value</div><div class="d-metric-val" style="color:var(--emerald)">' + fmtUsd(row.implied_value_usd) + '</div><div class="d-metric-sub">' + v.effective_multiple.toFixed(2) + 'x TVL</div></div>' +
        '<div class="d-metric"><div class="d-metric-label">Snapshot TVL</div><div class="d-metric-val">' + fmtUsd(row.tvl_usd) + '</div><div class="d-metric-sub">' + esc(DATA.as_of) + '</div></div>' +
        '<div class="d-metric"><div class="d-metric-label">7d Growth</div><div class="d-metric-val">' + (row.change_7d == null ? 'n/a' : (row.change_7d > 0 ? '+' : '') + row.change_7d.toFixed(1) + '%') + '</div><div class="d-metric-sub">Clamped ' + v.growth_pct_clamped.toFixed(1) + '%</div></div>' +
        '<div class="d-metric"><div class="d-metric-label">Pre-Token Age</div><div class="d-metric-val">' + (row.age_days == null ? '365d*' : row.age_days + 'd') + '</div><div class="d-metric-sub">' + (row.age_days == null ? 'Fallback' : (row.age_days / 365).toFixed(2) + 'y live') + '</div></div>' +
      '</div>' +

      '<section class="drawer-section">' +
        '<h3><span>Valuation Waterfall</span><span class="mono" style="font-size:10.5px;color:var(--ink-3)">IQR: ' + fmtUsd(v.low_usd) + ' – ' + fmtUsd(v.high_usd) + '</span></h3>' +
        '<div class="waterfall-grid">' +
          '<div class="wf-step"><div class="wf-k">TVL</div><div class="wf-v">' + fmtUsd(row.tvl_usd) + '</div><div class="wf-s">Sealed input</div></div>' +
          '<div class="wf-step"><div class="wf-k">Sector EB</div><div class="wf-v">&times;' + v.sector_multiple.toFixed(2) + '</div><div class="wf-s">' + v.sector_peer_count + ' live peers</div></div>' +
          '<div class="wf-step"><div class="wf-k">7d Growth</div><div class="wf-v">&times;' + v.growth_mult.toFixed(2) + '</div><div class="wf-s">' + v.growth_pct_clamped.toFixed(1) + '% 7d</div></div>' +
          '<div class="wf-step"><div class="wf-k">Age&times;Chain</div><div class="wf-v">&times;' + (v.maturity_mult * v.chain_mult).toFixed(2) + '</div><div class="wf-s">' + v.maturity_mult.toFixed(2) + '&times;' + v.chain_mult.toFixed(2) + '</div></div>' +
          '<div class="wf-step wf-final"><div class="wf-k">Implied</div><div class="wf-v" style="color:var(--emerald)">' + fmtUsd(row.implied_value_usd) + '</div><div class="wf-s">Rank #' + row.live_rank + '</div></div>' +
        '</div>' +
        '<svg viewBox="0 0 580 22" style="width:100%;height:22px;display:block;margin-top:6px" role="img" aria-label="Valuation confidence band">' +
          '<rect x="0" y="5" width="580" height="6" rx="3" fill="#ebe6dc"/>' +
          '<rect x="28" y="5" width="524" height="6" rx="3" fill="#cde6da"/>' +
          '<circle cx="' + (28 + markerPct * 5.24).toFixed(1) + '" cy="8" r="5" fill="#0b6e4f"/>' +
          '<text x="0" y="20" font-size="9" fill="#747d87" font-family="ui-monospace, Menlo, monospace">Low ' + fmtUsd(v.low_usd) + '</text>' +
          '<text x="580" y="20" text-anchor="end" font-size="9" fill="#747d87" font-family="ui-monospace, Menlo, monospace">High ' + fmtUsd(v.high_usd) + '</text>' +
        '</svg>' +
      '</section>' +

      '<section class="drawer-section">' +
        '<h3><span>Concrete Farm Playbook (' + row.farm_plan.length + ' Steps)</span><span class="pill pill-cat">Risk: ' + esc(fs.risk_tier) + '</span></h3>' +
        '<div class="farm-summary-strip">' +
          '<span>Route: <strong>' + esc(fs.primary_chain) + (fs.secondary_chain ? ' + ' + esc(fs.secondary_chain) : '') + '</strong></span>' +
          '<span>Capital: <strong>$' + fs.capital_usd + '</strong></span>' +
          '<span>Est. Gas: <strong>~' + fmtGas(fs.est_total_gas_usd) + '</strong></span>' +
          '<span>Hold: <strong>' + fs.hold_days + 'd</strong></span>' +
          '<span>Time: <strong>' + fs.setup_minutes + 'm setup, ' + fs.weekly_minutes + 'm/wk</strong></span>' +
        '</div>' +
        '<div class="step-list">' + stepsHtml + '</div>' +
      '</section>' +

      '<section class="drawer-section">' +
        '<h3><span>' + esc(compsLabel) + '</span></h3>' +
        '<table class="comps-mini-table"><thead><tr><th>Live Protocol</th><th class="num">Market Cap</th><th class="num">TVL</th><th class="num">MCap/TVL</th></tr></thead><tbody>' + compsHtml + '</tbody></table>' +
      '</section>';

    $('drawer-backdrop').hidden = false;
    $('detail-drawer').hidden = false;
    renderTable();
  }

  function closeDetail() {
    state.detailSlug = null;
    $('drawer-backdrop').hidden = true;
    $('detail-drawer').hidden = true;
    renderTable();
  }

  function syncUi() {
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      const on = btn.getAttribute('data-view') === state.view;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('filter-search').value = state.search;
    $('filter-category').value = state.category;
    $('filter-chain').value = state.chain;
    $('filter-growth').value = state.growth;
    $('filter-gas').value = state.gas;
    $('filter-gas').disabled = state.view === 'live';
    $('sort-select').options[0].textContent = state.view === 'live' ? 'Sort: Market Cap' : 'Sort: Implied Value';
    $('sort-select').value = state.sort;
    $('ctrl-mode').value = state.model.mode;
    $('ctrl-base-scale').value = String(state.model.baseScale);
    $('ctrl-growth-w').value = String(state.model.growthWeight);
    $('ctrl-mat-span').value = String(state.model.maturitySpan);
    $('ctrl-chain-step').value = String(state.model.chainStep);
    $('val-mode-label').textContent = state.model.mode === 'peer' ? 'Peer-Calibrated' : 'Uniform Global';
    $('val-base-scale').textContent = state.model.baseScale.toFixed(2) + 'x';
    $('val-growth-w').textContent = state.model.growthWeight.toFixed(2);
    $('val-mat-span').textContent = state.model.maturitySpan.toFixed(2);
    $('val-chain-step').textContent = '+' + (state.model.chainStep * 100).toFixed(1) + '%';
    $('insights-row').hidden = !state.insightsOpen;
    $('toggle-insights-btn').setAttribute('aria-expanded', state.insightsOpen ? 'true' : 'false');
    $('model-sandbox').hidden = !state.sandboxOpen;
    $('toggle-sandbox-btn').setAttribute('aria-expanded', state.sandboxOpen ? 'true' : 'false');
  }

  function applyQueryParams() {
    const q = new URLSearchParams(window.location.search);
    const v = q.get('view');
    if (v && ['board', 'watchlist', 'early', 'live'].includes(v)) state.view = v;
    if (q.get('category')) state.category = q.get('category');
    if (q.get('chain')) state.chain = q.get('chain');
    if (q.get('growth')) state.growth = q.get('growth');
    if (q.get('gas')) state.gas = q.get('gas');
    if (q.get('sort')) state.sort = q.get('sort');
    if (q.get('q')) state.search = q.get('q');
    if (q.get('sandbox') === '1') {
      state.sandboxOpen = true;
      state.insightsOpen = false;
    }
    if (q.get('charts') === '0' || state.view === 'live') state.insightsOpen = false;
    if (q.get('charts') === '1') state.insightsOpen = true;
    if (q.get('detail')) state.detailSlug = q.get('detail');
  }

  function bindEvents() {
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.view = btn.getAttribute('data-view');
        syncUi();
        renderTable();
      });
    });
    $('filter-search').addEventListener('input', function (e) { state.search = e.target.value; renderTable(); });
    $('filter-category').addEventListener('change', function (e) { state.category = e.target.value; renderTable(); });
    $('filter-chain').addEventListener('change', function (e) { state.chain = e.target.value; renderTable(); });
    $('filter-growth').addEventListener('change', function (e) { state.growth = e.target.value; renderTable(); });
    $('filter-gas').addEventListener('change', function (e) { state.gas = e.target.value; renderTable(); });
    $('sort-select').addEventListener('change', function (e) { state.sort = e.target.value; renderTable(); });
    $('clear-filters-btn').addEventListener('click', function () {
      state.search = ''; state.category = 'all'; state.chain = 'all'; state.growth = 'all'; state.gas = 'all'; state.sort = 'rank';
      syncUi(); renderTable();
    });
    $('toggle-insights-btn').addEventListener('click', function () { state.insightsOpen = !state.insightsOpen; syncUi(); });
    $('toggle-sandbox-btn').addEventListener('click', function () { state.sandboxOpen = !state.sandboxOpen; syncUi(); });

    function onModelChange() {
      state.model.mode = $('ctrl-mode').value;
      state.model.baseScale = parseFloat($('ctrl-base-scale').value);
      state.model.growthWeight = parseFloat($('ctrl-growth-w').value);
      state.model.maturitySpan = parseFloat($('ctrl-mat-span').value);
      state.model.chainStep = parseFloat($('ctrl-chain-step').value);
      recomputeBoard();
      syncUi();
      renderKpis();
      renderTable();
      if (state.detailSlug) openDetail(state.detailSlug);
    }
    ['ctrl-mode', 'ctrl-base-scale', 'ctrl-growth-w', 'ctrl-mat-span', 'ctrl-chain-step'].forEach(function (id) {
      $(id).addEventListener('input', onModelChange);
    });
    $('reset-model-btn').addEventListener('click', function () {
      state.model = { mode: 'peer', baseScale: 1.0, growthWeight: DATA.params.growth_weight, maturitySpan: DATA.params.maturity_span, chainStep: DATA.params.chain_step };
      recomputeBoard(); syncUi(); renderKpis(); renderTable();
      if (state.detailSlug) openDetail(state.detailSlug);
    });

    $('table-body').addEventListener('click', function (e) {
      const btn = e.target.closest('[data-open-slug]');
      if (btn) { e.stopPropagation(); openDetail(btn.getAttribute('data-open-slug')); return; }
      const tr = e.target.closest('tr[data-slug]');
      if (tr) openDetail(tr.getAttribute('data-slug'));
    });
    $('drawer-backdrop').addEventListener('click', closeDetail);
    $('detail-drawer').addEventListener('click', function (e) { if (e.target.closest('#drawer-close-btn')) closeDetail(); });
    $('detail-drawer').addEventListener('change', function (e) {
      const cb = e.target.closest('.step-check');
      if (!cb) return;
      const k = cb.getAttribute('data-step-key');
      if (cb.checked) state.checkedSteps.add(k); else state.checkedSteps.delete(k);
      const card = cb.closest('.step-card');
      if (card) card.classList.toggle('is-done', cb.checked);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.detailSlug) closeDetail(); });
  }

  recomputeBoard();
  populateSelects();
  applyQueryParams();
  renderMasthead();
  renderKpis();
  renderSectorChart();
  renderCoverageCard();
  syncUi();
  renderTable();
  bindEvents();
  if (state.detailSlug) openDetail(state.detailSlug);
})();
