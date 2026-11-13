/* 出差小助手 · 前端 */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    plan: null,
    sortBy: 'score',
    filters: { tier1: false, budget: false, withPrice: false, lodging: false },
    selectedId: null,
    pendingPrice: null,
    travelOpen: false,
    loading: false
  };

  /** 地图对象 */
  let map = null;
  const layers = { factory: null, radius: null, hotels: null };
  const markerById = new Map();

  /* ============ 工具 ============ */
  const fmtKm = (m) => (Number.isFinite(m) ? (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`) : '—');
  const fmtPrice = (p) => (Number.isFinite(p) ? `¥${Math.round(p)}` : '待核价');
  const fmtDur = (min) => {
    if (!Number.isFinite(min) || min <= 0) return '—';
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    if (h > 0) return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
    return `${m} 分钟`;
  };
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer = null;
  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 5000 : 2600);
  }

  function banner(html, kind = '') {
    const el = $('#banner');
    if (!html) {
      el.classList.add('hidden');
      return;
    }
    el.innerHTML = html;
    el.className = `banner ${kind}`;
  }

  /* ============ 初始化 ============ */
  function initMap() {
    map = L.map('map', {
      center: [31.3, 120.6],
      zoom: 11,
      zoomControl: true,
      attributionControl: true
    });

    // 高德瓦片（GCJ-02），与高德 POI 坐标同一坐标系，不需要转换
    L.tileLayer(
      'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        minZoom: 4,
        attribution: '底图 © 高德地图'
      }
    ).addTo(map);

    layers.hotels = L.layerGroup().addTo(map);
    layers.factory = L.layerGroup().addTo(map);
    layers.radius = L.layerGroup().addTo(map);

    // 点击空白处取消选中
    map.on('click', () => selectHotel(null));
  }

  async function loadConfig() {
    try {
      const cfg = await (await fetch('/api/config')).json();
      const d = cfg.defaults || {};
      if (d.radiusKm) $('#radiusKm').value = d.radiusKm;
      if (d.priceMin != null) $('#priceMin').value = d.priceMin;
      if (d.priceMax != null) $('#priceMax').value = d.priceMax;
      if (d.city) $('#city').value = d.city;
      if (d.from) $('#from').value = d.from;
    } catch {
      toast('读取配置失败，服务是否已启动？', true);
    }
  }

  async function checkHealth() {
    try {
      const h = await (await fetch('/api/health')).json();
      if (h.ok) return;
      banner(
        `<strong>高德 key 目前不可用：</strong>${esc(h.error || '未知错误')}` +
          (h.hint ? `<br>${esc(h.hint)}` : '') +
          `<br>修好之前可以点右侧「先看演示效果」，界面和交互都是完整的。`,
        'error'
      );
    } catch {
      banner('连不上本地服务，请确认 <code>node server.mjs</code> 还在运行。', 'error');
    }
  }

  /* ============ 打分（与 lib/hotels.mjs 的 scoreHotel 保持一致） ============ */
  function computeScore(h, { radiusMeters, priceMin, priceMax }) {
    const dist = Number.isFinite(h.distance) ? h.distance : radiusMeters;
    const distScore = 40 * Math.max(0, 1 - Math.min(dist, radiusMeters) / Math.max(radiusMeters, 1));
    let brandScore = 0;
    if (h.brand) brandScore = h.brand.tier === 1 ? 35 : h.brand.tier === 2 ? 22 : 10;
    let priceScore = 8;
    if (Number.isFinite(h.price)) {
      if (h.price >= priceMin && h.price <= priceMax) priceScore = 20;
      else if (h.price < priceMin) priceScore = 14;
      else {
        const over = (h.price - priceMax) / Math.max(priceMax, 1);
        priceScore = over <= 0.2 ? 12 : over <= 0.5 ? 6 : 2;
      }
    }
    const ratingScore = Number.isFinite(h.rating) ? (h.rating / 5) * 5 : 0;
    return {
      total: Math.round((distScore + brandScore + priceScore + ratingScore) * 10) / 10,
      distScore: Math.round(distScore * 10) / 10,
      brandScore,
      priceScore,
      ratingScore: Math.round(ratingScore * 10) / 10
    };
  }

  /* ============ 视图 ============ */
  function visibleHotels() {
    if (!state.plan) return [];
    const { priceMin, priceMax } = state.plan.query;
    const radiusMeters = state.plan.query.radiusKm * 1000;
    let rows = state.plan.hotels.slice();
    const f = state.filters;
    if (!f.lodging) rows = rows.filter((h) => h.isProper !== false);
    if (f.tier1) rows = rows.filter((h) => h.brand && h.brand.tier === 1);
    if (f.budget) rows = rows.filter((h) => h.inBudget === true);
    if (f.withPrice) rows = rows.filter((h) => Number.isFinite(h.price));

    const sorters = {
      score: (a, b) => b.score.total - a.score.total,
      distance: (a, b) => a.distance - b.distance,
      price: (a, b) => (Number.isFinite(a.price) ? a.price : Infinity) - (Number.isFinite(b.price) ? b.price : Infinity),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0)
    };
    const cmp = sorters[state.sortBy] || sorters.score;
    rows.sort((a, b) => cmp(a, b) || a.distance - b.distance);
    rows.forEach((h) => {
      h.score = computeScore(h, { radiusMeters, priceMin, priceMax });
    });
    return rows;
  }

  function renderSummary() {
    const box = $('#summary');
    if (!state.plan) return;
    const p = state.plan;
    const warnings = p.warnings || [];
    // 统计跟着当前筛选走，避免"顶部 20 家、列表 18 家"这种对不上
    const rows = visibleHotels();
    const withPrice = rows.filter((h) => Number.isFinite(h.price)).length;
    const hasPrice = withPrice > 0;
    const inBudget = rows.filter((h) => h.inBudget === true).length;
    const preferred = rows.filter((h) => h.brand?.tier === 1).length;
    const top = rows.length ? rows.reduce((a, b) => (b.score.total > a.score.total ? b : a)) : null;

    box.innerHTML = `
      <div class="summary-grid">
        <div class="stat"><div class="k">范围内酒店</div><div class="v">${rows.length}<small> 家</small></div></div>
        <div class="stat"><div class="k">${
          hasPrice ? `预算内 (¥${p.query.priceMin}-${p.query.priceMax})` : '价格待核价'
        }</div><div class="v">${hasPrice ? inBudget : rows.length}<small> 家</small></div></div>
        <div class="stat"><div class="k">常住品牌</div><div class="v">${preferred}<small> 家</small></div></div>
      </div>
      <div class="factory-line">
        <span class="factory-dest">目的地：<b>${esc(p.factory.name)}</b></span>
        ${p.factory.address ? `<span class="factory-addr" title="${esc(p.factory.address)}">${esc(p.factory.address)}</span>` : ''}
        <span class="factory-stats">半径 ${p.query.radiusKm} km ｜ 已报价 ${withPrice} 家${
          top ? ` ｜ 综合首选 <b>${esc(top.name)}</b>（${fmtKm(top.distance)}${Number.isFinite(top.price) ? `，${fmtPrice(top.price)}` : ''}）` : ''
        }</span>
        ${
          hasPrice
            ? ''
            : '<span class="price-hint">还没拿到价格。点卡片上的「携程核价」查到实价后，用「补录房价」记下来。</span>'
        }
      </div>
      ${
        warnings.length
          ? `<details class="warnings"><summary>${warnings.length} 条提示</summary>${warnings
              .map((w) => `<div>· ${esc(w)}</div>`)
              .join('')}</details>`
          : ''
      }
    `;
  }

  function renderCandidates() {
    const box = $('#candidates');
    const c = state.plan?.candidates || [];
    if (!state.plan || c.length < 2) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = `
      <h4>定位到的地点（点一下可切换）</h4>
      ${c
        .map(
          (x) => `<button type="button" class="candidate${x.id === state.plan.factory.id ? ' active' : ''}" data-id="${esc(x.id)}"
            data-lng="${x.lng}" data-lat="${x.lat}" data-name="${esc(x.name)}">
            <span>
              <span class="cname">${esc(x.name)}</span><br>
              <span class="caddr">${esc(x.address || x.cityname || '')}</span>
            </span>
          </button>`
        )
        .join('')}
    `;
    $$('.candidate', box).forEach((btn) => {
      btn.addEventListener('click', () => {
        submitPlan({
          factory: state.plan.query.factory,
          city: state.plan.query.city,
          from: state.plan.query.from,
          factoryId: btn.dataset.id,
          factoryLng: Number(btn.dataset.lng),
          factoryLat: Number(btn.dataset.lat),
          factoryName: btn.dataset.name
        });
      });
    });
  }

  function renderTravel() {
    const box = $('#travel');
    const t = state.plan?.travel;
    if (!t) {
      box.innerHTML = '';
      return;
    }

    const bestDrive = t.driving?.length ? t.driving.reduce((a, b) => (a.distance <= b.distance ? a : b)) : null;
    const bestTransit = t.transit?.length ? t.transit.reduce((a, b) => (a.durationMin <= b.durationMin ? a : b)) : null;

    // 收起时的一行摘要，让用户不展开也知道大概
    const bits = [];
    if (bestDrive) bits.push(`自驾 ${fmtKm(bestDrive.distance)} · ${fmtDur(bestDrive.durationMin)}`);
    if (bestTransit) bits.push(`公共交通 ${fmtKm(bestTransit.distance)} · ${fmtDur(bestTransit.durationMin)}`);
    if (!bits.length && t.straightKm) bits.push(`直线 ${t.straightKm} km`);
    if (!bits.length) bits.push('展开看方案');

    const parts = [];

    if (bestDrive) {
      parts.push(`
        <div class="travel-card">
          <h4>自驾 <span class="tag">${fmtKm(bestDrive.distance)}</span></h4>
          <div class="travel-opt"><b>约 ${fmtDur(bestDrive.durationMin)}</b><span>过路费 ¥${bestDrive.tolls}</span><span>红绿灯 ${bestDrive.trafficLights}</span></div>
        </div>`);
    }

    if (bestTransit) {
      const legs = bestTransit.legs.map((l) => esc(l.name)).filter(Boolean).join(' → ');
      parts.push(`
        <div class="travel-card">
          <h4>高铁/公共交通 <span class="tag">${fmtKm(bestTransit.distance)}</span></h4>
          <div class="travel-opt"><b>约 ${fmtDur(bestTransit.durationMin)}</b>${
            bestTransit.cost ? `<span>票价约 ¥${Math.round(bestTransit.cost)}</span>` : ''
          }</div>
          ${legs ? `<div class="travel-legs">${legs}</div>` : ''}
        </div>`);
    }

    // 方案都没拿到时，至少把失败原因显示出来
    if (!parts.length && t.notes?.length) {
      parts.push(`<div class="travel-card"><div class="travel-notes">${t.notes.map(esc).join('<br>')}</div></div>`);
    }

    const links = [];
    if (t.links?.train) links.push(`<a href="${esc(t.links.train)}" target="_blank" rel="noopener">12306 查车次</a>`);
    if (t.links?.flight) links.push(`<a href="${esc(t.links.flight)}" target="_blank" rel="noopener">携程查机票</a>`);
    if (links.length) {
      parts.push(`<div class="travel-card"><h4>出发地 → ${esc(t.to || '')}</h4><div class="travel-links">${links.join('')}</div></div>`);
    }

    box.innerHTML = `
      <details class="travel-details"${state.travelOpen ? ' open' : ''}>
        <summary>
          <span class="travel-title">怎么去</span>
          <span class="travel-summary-text">${esc(bits.join(' ｜ '))}</span>
        </summary>
        <div class="travel-body">${parts.join('')}</div>
      </details>`;

    const details = $('.travel-details', box);
    if (details) details.addEventListener('toggle', () => { state.travelOpen = details.open; });
  }

  function hotelCard(h, idx) {
    const badges = [];
    if (h.brand) badges.push(`<span class="badge tier${h.brand.tier}">${esc(h.brand.group)}</span>`);
    else badges.push('<span class="badge">未识别连锁</span>');
    if (h.star && h.star !== '酒店' && h.star !== '住宿') badges.push(`<span class="badge star">${esc(h.star)}</span>`);
    if (h.inBudget === true) badges.push('<span class="badge budget">预算内</span>');
    if (h.priceSource === 'manual') badges.push('<span class="badge manual">已核价</span>');

    const priceText = Number.isFinite(h.price) ? fmtPrice(h.price) : '待核价';
    const priceClass = Number.isFinite(h.price)
      ? h.inBudget === false && h.price > state.plan.query.priceMax
        ? 'over'
        : ''
      : 'none';
    // 起价对应的是哪个房型，必须跟在价格旁边，否则会误以为是能订到的价格
    const roomNote = h.priceNote && h.priceNote.includes('·') ? h.priceNote.split('·')[1] : '';
    const priceTitle = h.priceNote || '';

    const links = h.links || {};
    const actions = [];
    if (links.ctrip) actions.push(`<a class="ctrip" href="${esc(links.ctrip)}" target="_blank" rel="noopener">携程核价</a>`);
    else if (links.ctripFallback) actions.push(`<a class="ctrip" href="${esc(links.ctripFallback)}" target="_blank" rel="noopener">携程搜</a>`);
    if (links.amapPoi) actions.push(`<a href="${esc(links.amapPoi)}" target="_blank" rel="noopener">高德详情</a>`);
    actions.push(`<button type="button" data-action="price" data-id="${esc(h.id)}">补录房价</button>`);

    return `
      <article class="hotel${state.selectedId === h.id ? ' active' : ''}${h.inBudget === false ? ' out-budget' : ''}" data-id="${esc(h.id)}">
        <div class="hotel-top">
          <span class="hotel-no ${h.band}">${idx}</span>
          <span class="hotel-name">${esc(h.name)}</span>
          <span class="hotel-price ${priceClass}"${priceTitle ? ` title="${esc(priceTitle)}"` : ''}>${priceText}${
            roomNote ? `<small class="price-note">${esc(roomNote)}</small>` : ''
          }</span>
        </div>
        <div class="hotel-meta">
          <span class="dist">${fmtKm(h.distance)}</span>
          ${badges.join('')}
          ${Number.isFinite(h.rating) ? `<span>评分 ${h.rating}</span>` : ''}
          <span>综合 ${h.score.total}</span>
        </div>
        ${h.address ? `<div class="hotel-addr">${esc(h.address)}${h.tel ? ` · ${esc(h.tel)}` : ''}</div>` : h.tel ? `<div class="hotel-addr">${esc(h.tel)}</div>` : ''}
        <div class="hotel-actions">${actions.join('')}</div>
      </article>`;
  }

  function renderList() {
    const box = $('#list');
    if (!state.plan) {
      box.innerHTML = '';
      return;
    }
    const rows = visibleHotels();
    if (!rows.length) {
      box.innerHTML = `<div class="summary-empty"><strong>没有符合条件的酒店</strong><p>试试放宽半径或价格区间，或取消上面的筛选。</p></div>`;
      return;
    }
    box.innerHTML = rows.map((h, i) => hotelCard(h, i + 1)).join('');

    $$('.hotel', box).forEach((el) => {
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-action="price"]') || ev.target.closest('a')) return;
        selectHotel(el.dataset.id);
      });
    });
    $$('[data-action="price"]', box).forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openPriceDialog(btn.dataset.id);
      });
    });
  }

  function priceLabel(h) {
    if (Number.isFinite(h.price)) return `¥${Math.round(h.price)}`;
    return '价?';
  }

  function renderMap() {
    if (!state.plan) return;
    layers.hotels.clearLayers();
    markerById.clear();

    const f = state.plan.factory;
    const radiusMeters = state.plan.query.radiusKm * 1000;

    // 厂家
    layers.factory.clearLayers();
    L.marker([f.lat, f.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="factory-pin"><span>厂</span></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 22]
      }),
      zIndexOffset: 1000
    })
      .addTo(layers.factory)
      .bindPopup(`<b>${esc(f.name)}</b><br>${esc(f.address || '')}<br><span style="color:#6b7684">目的地厂家</span>`);

    // 半径圈
    layers.radius.clearLayers();
    [
      { r: radiusMeters, color: '#1f6feb', dash: '6 6', label: `${state.plan.query.radiusKm}km` },
      { r: radiusMeters / 2, color: '#8aa9e0', dash: '3 6', label: `${(state.plan.query.radiusKm / 2).toFixed(1)}km` }
    ].forEach((c) => {
      L.circle([f.lat, f.lng], {
        radius: c.r,
        color: c.color,
        weight: 1,
        dashArray: c.dash,
        fill: false
      }).addTo(layers.radius);
    });

    // 酒店
    const rows = visibleHotels();
    rows.forEach((h, i) => {
      const cls = `amap-pin band-${h.band}${h.brand?.tier === 1 ? ' tier1' : ''}${state.selectedId === h.id ? ' selected' : ''}`;
      const icon = L.divIcon({
        className: '',
        html: `<div class="${cls}"><span class="no">${i + 1}</span><span class="p">${priceLabel(h)}</span></div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      });
      const marker = L.marker([h.lat, h.lng], {
        icon,
        zIndexOffset: h.brand?.tier === 1 ? 500 : 0,
        title: h.name
      })
        .addTo(layers.hotels)
        .bindPopup(
          `<b>${esc(h.name)}</b><br>` +
            `${Number.isFinite(h.price) ? `房价 ${fmtPrice(h.price)}${h.priceSource === 'manual' ? '（已核价）' : '（高德人均）'}` : '价格待核价'}<br>` +
            `直线距离 ${fmtKm(h.distance)}${h.brand ? ` · ${esc(h.brand.group)}` : ''}<br>` +
            `<span style="color:#6b7684">${esc(h.address || '')}</span>` +
            (h.tel ? `<br>电话 ${esc(h.tel)}` : '')
        );
      marker.on('click', () => selectHotel(h.id, { fromMap: true }));
      markerById.set(h.id, marker);
    });

    fitAll();
  }

  function fitAll() {
    if (!state.plan) return;
    const pts = [[state.plan.factory.lat, state.plan.factory.lng]];
    visibleHotels().forEach((h) => pts.push([h.lat, h.lng]));
    if (pts.length === 1) {
      map.setView(pts[0], 14);
      return;
    }
    map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15 });
  }

  function selectHotel(id, opts = {}) {
    if (state.selectedId === id) {
      if (id && opts.fromMap) {
        const m = markerById.get(id);
        if (m) m.openPopup();
      }
      return;
    }
    state.selectedId = id;

    $$('.hotel').forEach((el) => el.classList.toggle('active', el.dataset.id === id));

    // 更新地图标记的选中态（不重建标记，避免时闪）
    markerById.forEach((marker, hid) => {
      const inner = marker.getElement?.()?.querySelector('.amap-pin');
      if (inner) inner.classList.toggle('selected', hid === id);
    });

    if (id) {
      const h = visibleHotels().find((x) => x.id === id);
      if (h) {
        map.flyTo([h.lat, h.lng], Math.max(map.getZoom(), 14), { duration: 0.6 });
        const marker = markerById.get(id);
        if (marker) setTimeout(() => marker.openPopup(), 400);
        const card = $(`.hotel[data-id="${CSS.escape(id)}"]`);
        if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  function renderAll() {
    renderSummary();
    renderCandidates();
    renderTravel();
    renderList();
    renderMap();
    $('#filters').classList.toggle('hidden', !state.plan);
    const has = Boolean(state.plan);
    $('#exportBtn').disabled = !has;
    $('#openTabsBtn').disabled = !has;
    $('#livePriceBtn').disabled = !has;
    $('#liveBar').classList.toggle('hidden', !has);
  }

  /* ============ 交互 ============ */
  async function submitPlan(overrides = {}) {
    if (state.loading) return;
    const payload = {
      factory: $('#factory').value.trim(),
      city: $('#city').value.trim(),
      from: $('#from').value.trim(),
      radiusKm: Number($('#radiusKm').value) || 10,
      priceMin: Number($('#priceMin').value) || 0,
      priceMax: Number($('#priceMax').value) || 0,
      ...overrides
    };
    if (!payload.factory && payload.factoryLng === undefined) {
      toast('先填目的地厂家', true);
      $('#factory').focus();
      return;
    }

    state.loading = true;
    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = '查询中…';
    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        toast(data.error || '查询失败', true);
        if (data.hint) banner(`${esc(data.error)}<br>${esc(data.hint)}`, 'error');
        return;
      }
      state.plan = data;
      state.selectedId = null;
      if (data.factory.city && !$('#city').value) $('#city').value = data.factory.city;
      banner('');
      renderAll();
      toast(`找到 ${data.hotels.length} 家酒店`);
    } catch (e) {
      toast(`请求失败：${e.message}`, true);
    } finally {
      state.loading = false;
      btn.disabled = false;
      btn.textContent = '查酒店';
    }
  }

  async function loadDemo() {
    try {
      const res = await fetch('/api/demo');
      if (!res.ok) {
        toast('演示数据未生成，先跑 node scripts/selftest.mjs', true);
        return;
      }
      const data = await res.json();
      state.plan = data;
      state.selectedId = null;
      renderAll();
      banner(
        '<strong>当前显示的是演示数据</strong>：酒店名称取自常见连锁品牌，坐标是合成的。key 配好后同样的界面会显示真实酒店、真实距离和价格。',
        'ok'
      );
      toast('这是演示数据，key 配好后就是真实结果');
    } catch (e) {
      toast(`读取演示数据失败：${e.message}`, true);
    }
  }

  function openPriceDialog(id) {
    const h = state.plan?.hotels.find((x) => x.id === id);
    if (!h) return;
    state.pendingPrice = h;
    $('#priceDialogTitle').textContent = h.name;
    $('#priceInput').value = Number.isFinite(h.price) ? h.price : '';
    $('#priceNote').value = h.priceNote || '';
    $('#priceDialog').classList.remove('hidden');
    setTimeout(() => $('#priceInput').focus(), 30);
  }

  function closePriceDialog() {
    $('#priceDialog').classList.add('hidden');
    state.pendingPrice = null;
  }

  async function savePrice() {
    const h = state.pendingPrice;
    if (!h) return;
    const price = Number($('#priceInput').value);
    if (!Number.isFinite(price) || price <= 0) {
      toast('填一个有效价格', true);
      return;
    }
    try {
      const res = await fetch('/api/price', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: h.id,
          price,
          name: h.name,
          source: $('#priceSource').value,
          note: $('#priceNote').value.trim()
        })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '保存失败');

      h.price = Math.round(price);
      h.priceSource = 'manual';
      h.priceNote = $('#priceNote').value.trim();
      h.inBudget = price >= state.plan.query.priceMin && price <= state.plan.query.priceMax;

      closePriceDialog();
      renderAll();
      toast(`已把「${h.name}」记为 ${fmtPrice(price)}`);
    } catch (e) {
      toast(`保存失败：${e.message}`, true);
    }
  }

  /* ============ 携程实时价 ============ */

  const fmtDate = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function updateNightLabel() {
    const ci = $('#liveCheckin').value;
    const co = $('#liveCheckout').value;
    if (!ci || !co) {
      $('#liveNight').textContent = '';
      return;
    }
    const nights = Math.round((new Date(co) - new Date(ci)) / 86400000);
    $('#liveNight').textContent = nights > 0 ? `${nights} 晚` : '日期不对';
  }

  function initLiveDates() {
    const ci = $('#liveCheckin');
    const co = $('#liveCheckout');
    if (!ci.value) ci.value = fmtDate(new Date(Date.now() + 86400000));
    if (!co.value) co.value = fmtDate(new Date(Date.now() + 2 * 86400000));

    ci.addEventListener('change', () => {
      // 退房必须晚于入住，否则自动顺延一天
      if (!co.value || co.value <= ci.value) {
        const d = new Date(ci.value);
        d.setDate(d.getDate() + 1);
        co.value = fmtDate(d);
      }
      updateNightLabel();
    });
    co.addEventListener('change', () => {
      if (co.value <= ci.value) {
        const d = new Date(ci.value);
        d.setDate(d.getDate() + 1);
        co.value = fmtDate(d);
      }
      updateNightLabel();
    });
    updateNightLabel();
  }

  async function ctripLogin() {
    const btn = $('#ctripLoginBtn');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '登录中…';
    try {
      const res = await fetch('/api/ctrip/login', { method: 'POST' });
      const data = await res.json();
      if (data.started || data.code === 'LOGIN_IN_PROGRESS') {
        banner(
          '已打开登录窗口。<strong>请在弹出的 Chrome 窗口里扫码登录携程</strong>，登录成功后这里会自动检测。'
        );
        toast('已打开登录窗口，请扫码');
        pollCtripLogin(btn, old);
        return;
      }
      throw new Error(data.error || '打开登录窗口失败');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = old;
      toast(`登录失败：${e.message}`, true);
    }
  }

  /** 轮询 /api/ctrip/status，直到登录窗口关闭（loginCtrip 流程结束）再看结果 */
  function pollCtripLogin(btn, old) {
    const deadline = Date.now() + 6 * 60 * 1000; // 比后端的 5 分钟多留一点余量
    const timer = setInterval(async () => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = old;
        toast('没检测到登录完成，请重试', true);
        return;
      }
      let st = null;
      try {
        st = await (await fetch('/api/ctrip/status')).json();
      } catch {
        return; // 服务暂时不可用，下一轮再试
      }
      if (st.loggingIn) return; // 登录窗口还开着，继续等扫码
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = old;
      if (st.loggedIn) {
        banner('');
        toast('携程登录成功，可以查实时价了');
      } else {
        banner('没检测到登录成功。<strong>请再点一次「登录携程」，在弹出的窗口里扫码。</strong>', 'error');
        toast('登录没成功，请重试', true);
      }
    }, 2500);
  }

  async function fetchLivePrices() {
    if (!state.plan || state.loading) return;

    const rows = visibleHotels().filter((h) => h.isProper !== false);
    if (!rows.length) {
      toast('当前没有可匹配的酒店', true);
      return;
    }

    // 先确认登录态，免得白等 50 秒
    try {
      const st = await (await fetch('/api/ctrip/status')).json();
      if (!st.loggedIn) {
        banner(
          '<strong>还没登录携程，实时价用不了。</strong><br>点下方「登录携程」扫码登录一次（登录态会记住，之后不用再登）。',
          'error'
        );
        toast('需要先登录携程', true);
        return;
      }
    } catch {
      /* 拿不到状态就继续试 */
    }

    const address = state.plan.factory.address || state.plan.factory.name || '';
    if (!address) {
      toast('这家厂家没有地址信息，查不了实时价', true);
      return;
    }

    const btn = $('#livePriceBtn');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '查询中…';
    toast('正在打开携程查周边实时价，约 50 秒，别关窗口…');

    try {
      const res = await fetch('/api/ctrip/live', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address,
          city: state.plan.factory.city || state.plan.query.city || '',
          checkin: $('#liveCheckin').value,
          checkout: $('#liveCheckout').value,
          hotels: rows.map((h) => ({ id: h.id, name: h.name }))
        })
      });
      const data = await res.json();
      if (!data.ok) {
        toast(data.error || '查价失败', true);
        if (data.hint) banner(esc(data.hint), 'error');
        return;
      }
      showLiveDialog(data, rows);
    } catch (e) {
      toast(`查价失败：${e.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  function showLiveDialog(data, rows) {
    const matched = data.matched || [];
    const byId = new Map(rows.map((h) => [h.id, h]));

    $('#liveTitle').textContent = matched.length ? `携程实价 ${matched.length} 家` : '没匹配到价格';
    const sec = data.cached ? '来自缓存' : `用了 ${Math.round((data.elapsedMs || 0) / 1000)} 秒`;
    $('#liveSub').textContent = `${data.address} → 「${data.pickedSuggestion || '-'}」，携程返回 ${data.scraped} 家有价，匹配上 ${matched.length} 家（${sec}）`;

    const list = $('#liveList');
    if (!matched.length) {
      list.innerHTML =
        '<div class="live-empty">一家都没匹配上。<br>可能是这个地址在携程搜不到周边酒店，试试把厂家地址写得更具体。</div>';
      $('#liveSave').disabled = true;
    } else {
      $('#liveSave').disabled = false;
      const sorted = matched.slice().sort((a, b) => (byId.get(a.id)?.distance ?? 0) - (byId.get(b.id)?.distance ?? 0));
      list.innerHTML = sorted
        .map((m) => {
          const h = byId.get(m.id);
          const pct = Math.round(m.score * 100);
          const checked = pct >= 85 ? ' checked' : '';
          const low = pct < 85 ? ' low' : '';
          return `<label class="live-row${low}">
            <input type="checkbox" data-id="${esc(m.id)}" data-price="${m.price}" data-room="${esc(m.room || '')}"${checked} />
            <span class="lname">${esc(m.name)}
              <span class="lorig">携程：${esc(m.matchedName)}</span>
            </span>
            <span class="lprice">¥${m.price}${m.room ? `<small class="lroom">${esc(m.room)}</small>` : '<small class="lroom">最低房型</small>'}</span>
            <span class="lscore">${pct}%</span>
          </label>`;
        })
        .join('');
    }
    updateLiveSaveLabel();
    $('#liveDialog').classList.remove('hidden');
  }

  function updateLiveSaveLabel() {
    const n = $$('#liveList input:checked').length;
    $('#liveSave').textContent = n ? `写入 ${n} 家` : '写入';
    $('#liveSave').disabled = n === 0;
  }

  function closeLiveDialog() {
    $('#liveDialog').classList.add('hidden');
  }

  async function applyLivePrices() {
    const picks = $$('#liveList input:checked').map((el) => ({
      id: el.dataset.id,
      price: Number(el.dataset.price),
      room: el.dataset.room || '',
      source: '携程'
    }));
    if (!picks.length) return;

    const byId = new Map(state.plan.hotels.map((h) => [h.id, h]));
    const payload = picks.map((p) => ({ ...p, name: byId.get(p.id)?.name || '' }));

    try {
      const res = await fetch('/api/prices/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: payload })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '写入失败');

      for (const p of payload) {
        const h = byId.get(p.id);
        if (!h) continue;
        h.price = Math.round(p.price);
        h.priceSource = 'manual';
        // 把房型也存下来，否则过几天自己都忘了这个价是哪个房型的
        h.priceNote = p.room ? `携程起价·${p.room}` : '携程起价';
        h.inBudget = h.price >= state.plan.query.priceMin && h.price <= state.plan.query.priceMax;
      }

      closeLiveDialog();
      renderAll();
      toast(`已写入 ${data.applied} 家的携程起价（记得核对房型）`);
    } catch (e) {
      toast(`写入失败：${e.message}`, true);
    }
  }

  /* ============ 批量核价（打开携程页面手工看） ============ */

  /** 降级方案：一次打开几家酒店的携程页面，自己看一眼再补录 */
  function openPriceTabs() {
    if (!state.plan) return;
    const rows = visibleHotels().slice(0, 5);
    const urls = rows.map((h) => h.links?.ctrip || h.links?.ctripFallback).filter(Boolean);
    if (!urls.length) {
      toast('这些酒店没有携程链接', true);
      return;
    }
    toast(`正在打开 ${urls.length} 个携程页面（浏览器可能要求允许弹窗）`);
    urls.forEach((u, i) => setTimeout(() => window.open(u, '_blank'), i * 400));
  }

  function exportCsv() {
    if (!state.plan) return;
    const rows = visibleHotels();
    const head = ['序号', '酒店名称', '品牌', '距离(米)', '房价(元)', '价格来源', '是否预算内', '高德评分', '综合分', '地址', '电话', '经度', '纬度', '高德POI'];
    const lines = [head.join(',')];
    rows.forEach((h, i) => {
      const cells = [
        i + 1,
        h.name,
        h.brand ? h.brand.group : '',
        h.distance,
        Number.isFinite(h.price) ? Math.round(h.price) : '',
        h.priceSource === 'manual' ? '人工核价' : '',
        h.inBudget === true ? '是' : h.inBudget === false ? '否' : '',
        Number.isFinite(h.rating) ? h.rating : '',
        h.score.total,
        h.address || '',
        h.tel || '',
        h.lng,
        h.lat,
        h.links?.amapPoi || ''
      ];
      lines.push(cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','));
    });
    // \uFEFF 让 Excel 正确识别 UTF-8
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `酒店_${state.plan.factory.name}_${state.plan.query.radiusKm}km.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ============ 绑定 ============ */
  function bind() {
    $('#searchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      submitPlan();
    });

    $('#demoBtn').addEventListener('click', loadDemo);
    $('#exportBtn').addEventListener('click', exportCsv);
    $('#openTabsBtn').addEventListener('click', openPriceTabs);

    // 携程实时价
    $('#ctripLoginBtn').addEventListener('click', ctripLogin);
    $('#livePriceBtn').addEventListener('click', fetchLivePrices);
    $('#liveCancel').addEventListener('click', closeLiveDialog);
    $('#liveSave').addEventListener('click', applyLivePrices);
    $('#liveList').addEventListener('change', updateLiveSaveLabel);
    $('#liveDialog').addEventListener('click', (e) => {
      if (e.target === $('#liveDialog')) closeLiveDialog();
    });

    $$('#sortGroup button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.sortBy = btn.dataset.sort;
        $$('#sortGroup button').forEach((b) => b.classList.toggle('active', b === btn));
        renderList();
        renderMap();
      });
    });

    $$('#filterGroup input').forEach((input) => {
      input.addEventListener('change', () => {
        state.filters[input.dataset.filter] = input.checked;
        renderSummary();
        renderList();
        renderMap();
      });
    });

    $$('.map-tools button').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!state.plan) return;
        if (btn.dataset.zoom === 'fit') fitAll();
        else map.flyTo([state.plan.factory.lat, state.plan.factory.lng], 14, { duration: 0.6 });
      });
    });

    $('#priceCancel').addEventListener('click', closePriceDialog);
    $('#priceSave').addEventListener('click', savePrice);
    $('#priceDialog').addEventListener('click', (e) => {
      if (e.target === $('#priceDialog')) closePriceDialog();
    });
    $('#priceInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') savePrice();
      if (e.key === 'Escape') closePriceDialog();
    });

    // Ctrl/Cmd+Enter 直接搜
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitPlan();
    });
  }

  async function boot() {
    initMap();
    bind();
    initLiveDates();
    await loadConfig();
    await checkHealth();

    // 支持用 URL 直接带上查询条件（方便存书签），?demo=1 则直接看演示数据
    const params = new URLSearchParams(location.search);
    if (params.get('city')) $('#city').value = params.get('city');
    if (params.get('from')) $('#from').value = params.get('from');
    if (params.get('factory')) $('#factory').value = params.get('factory');
    if (params.get('radiusKm')) $('#radiusKm').value = params.get('radiusKm');
    if (params.get('priceMin')) $('#priceMin').value = params.get('priceMin');
    if (params.get('priceMax')) $('#priceMax').value = params.get('priceMax');
    if (params.get('demo') === '1') loadDemo();
    else if (params.get('auto') === '1' && params.get('factory')) submitPlan();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
