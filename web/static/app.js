
/* GroundTruth — vanilla JS + Leaflet (OpenStreetMap) */
(() => {
  'use strict';

  const PARAMS = [
    'cleanliness',
    'road_condition',
    'street_lighting',
    'safety',
    'waterlogging'
  ];

  const LABELS = {
    cleanliness: 'Cleanliness',
    road_condition: 'Road condition',
    street_lighting: 'Street lighting',
    safety: 'Safety',
    waterlogging: 'Waterlogging'
  };

  const $ = (id) => document.getElementById(id);

  const state = {
    token: localStorage.getItem('gt_token'),
    user: null,
    reports: [],
    areas: [],
    param: 'all',
    selectedArea: null,
    selectedStreet: null,
    view: 'map',
    picking: false,
    draft: null,
    fitted: false,
    location: null,
    locationName: 'Finding your location…',
    radiusMeters: 10000
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[c]);

  const hexColor = (s) =>
    s >= 70 ? '#2F9E44' : s >= 50 ? '#E2891A' : '#C1442C';

  const label = (s) =>
    s >= 70 ? 'Good' : s >= 50 ? 'Fair' : 'Poor';

  const mean = (r) =>
    PARAMS.reduce((sum, p) => sum + Number(r[p] || 0), 0)
    / PARAMS.length;

  const val10 = (r) =>
    state.param === 'all' ? mean(r) : Number(r[state.param] || 0);

  let toastTimer;
  let refreshTimer = null;
  let refreshInProgress = false;
  let viewRequestId = 0;

  function toast(msg, ms = 4500) {
    const t = $('toast');
    if (!t) return;

    t.textContent = msg;
    t.hidden = false;

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.hidden = true;
    }, ms);
  }

  /* ---------- API ---------- */

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };

    if (state.token) {
      headers.Authorization = 'Bearer ' + state.token;
    }

    let body = opts.body;

    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }

    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers,
      body,
      cache: 'no-store'
    });

    let data = null;

    try {
      data = await res.json();
    } catch (_) {
      // Response may have an empty body.
    }

    if (!res.ok) {
      const err = new Error('Request failed');
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  /* ---------- Leaflet map ---------- */

  const map = L.map('map', {
    zoomControl: true
  }).setView([20.5937, 78.9629], 5); // India-wide fallback; replaced by device location when permitted

  L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors'
    }
  ).addTo(map);

  const markerLayer = L.layerGroup().addTo(map);
  const areaLayer = L.layerGroup();

  let draftMarker = null;

  function renderMarkers() {
    markerLayer.clearLayers();

    state.reports.forEach((r) => {
      const lat = Number(r.latitude);
      const lng = Number(r.longitude);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const score = val10(r) * 10;

      L.circleMarker([lat, lng], {
        radius: 7,
        fillColor: hexColor(score),
        color: '#fff',
        weight: 2,
        fillOpacity: 0.95
      })
        .bindTooltip(
          `${esc(r.street_name)} · ${val10(r).toFixed(1)}/10`
        )
        .on('click', () => selectArea(r.area, r.street_name))
        .addTo(markerLayer);
    });
  }

  /* ---------- Filters ---------- */

  function renderFilters() {
    const items = [
      ['all', 'All reports'],
      ...PARAMS.map((p) => [p, LABELS[p]])
    ];

    $('filters').innerHTML = items.map(([key, text]) => `
      <button
        class="fchip ${state.param === key ? 'on' : ''}"
        data-k="${key}"
      >${text}</button>
    `).join('');

    $('filters').querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.param = btn.dataset.k;
        renderFilters();
        renderMarkers();
        renderStreets();
      });
    });
  }

  /* ---------- Area scorecard ---------- */

  async function selectArea(areaId, street, fly = true) {
    if (!areaId) {
      toast('This spot is outside any scored area yet.');
      return;
    }

    state.selectedArea = areaId;
    state.selectedStreet = street || null;

    try {
      const d = await api(`/areas/${areaId}/`);

      // Ignore a late response if the user selected another area.
      if (String(state.selectedArea) !== String(areaId)) return;

      const st = street
        ? d.streets?.find((x) => x.street === street)
        : null;

      const bars = PARAMS.map((p) => {
        const v = Number(d['avg_' + p] ?? 0);
        const score = v * 10;

        return `
          <div class="bar">
            <span class="bl">${LABELS[p]}</span>
            <span class="tr">
              <i style="width:${Math.max(0, Math.min(100, score))}%;background:${hexColor(score)}"></i>
            </span>
            <span class="bv">${Math.round(score)}</span>
          </div>
        `;
      }).join('');

      const reps = (d.recent_reports || [])
        .slice(0, 3)
        .map((r) => `
          <div class="rep">
            ${r.photo_url
              ? `<img src="${esc(r.photo_url)}" alt="">`
              : '<span class="ph"></span>'}
            <div>
              <b>${esc(r.street_name || 'Unnamed')} · ${esc(r.username)}</b>
              ${esc(r.comment || 'Rated without comment.')}
            </div>
          </div>
        `).join('');

      $('scorecard').innerHTML = `
        <div class="sc-loc">Area score · ${d.report_count} reports</div>

        <div class="sc-name">${esc(d.name)}</div>

        <div class="sc-score">
          <span class="n">${Math.round(d.composite_score)}</span>
          <span class="d">/100</span>
          <span class="badge"
            style="background:${hexColor(d.composite_score)}">
            ${label(d.composite_score)}
          </span>
        </div>

        ${st ? `
          <div class="sc-loc" style="margin:-6px 0 10px">
            📍 ${esc(st.street)}:
            <b class="mono">${Math.round(st.score)}/100</b>
            from ${st.report_count} reports
          </div>
        ` : ''}

        ${bars}

        <div class="reports">${reps}</div>
      `;

      if (!street && fly) {
        map.flyTo(
          [d.center_lat, d.center_lng],
          14,
          { duration: 0.8 }
        );
      }
    } catch (e) {
      console.error('Scorecard loading failed:', e);
      toast('Could not load that area.');
    }
  }

  /* ---------- Street list ---------- */

  function renderStreets() {
    const bounds = map.getBounds();
    const groups = {};

    state.reports
      .filter((r) => {
        const lat = Number(r.latitude);
        const lng = Number(r.longitude);

        return Number.isFinite(lat)
          && Number.isFinite(lng)
          && bounds.contains([lat, lng]);
      })
      .forEach((r) => {
        const key = `${r.area}|${r.street_name}`;

        (groups[key] = groups[key] || []).push(r);
      });

    const rows = Object.values(groups)
      .map((reports) => ({
        area: reports[0].area,
        street: reports[0].street_name,
        area_name: reports[0].area_name,
        n: reports.length,
        score: reports.reduce((sum, r) => sum + val10(r), 0)
          / reports.length * 10,
        lat: reports.reduce((sum, r) => sum + Number(r.latitude), 0)
          / reports.length,
        lng: reports.reduce((sum, r) => sum + Number(r.longitude), 0)
          / reports.length
      }))
      .filter((r) => r.street)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    $('streets').innerHTML = rows.length
      ? rows.map((r, i) => `
          <div class="srow" data-i="${i}">
            <span class="sev" style="background:${hexColor(r.score)}"></span>
            <div>
              <div class="sn">${esc(r.street)}</div>
              <div class="sm">${esc(r.area_name)} · ${r.n} reports</div>
            </div>
            <span class="sv" style="color:${hexColor(r.score)}">
              ${Math.round(r.score)}
            </span>
          </div>
        `).join('')
      : '<div class="muted small">No reports in this view — zoom out.</div>';

    $('streets').querySelectorAll('.srow').forEach((el) => {
      el.addEventListener('click', () => {
        const r = rows[Number(el.dataset.i)];

        map.flyTo([r.lat, r.lng], 16, { duration: 0.7 });
        selectArea(r.area, r.street);
      });
    });
  }

  map.on('moveend', () => {
    if (state.view === 'map') renderStreets();
  });

  /* ---------- Official statistics ---------- */

  async function loadOfficial() {
    // The prototype only contains illustrative figures for a few named cities.
    // Never silently display Bengaluru figures for an unknown/current location.
    if (!state.cityName || !['Bengaluru', 'Delhi', 'Mumbai', 'Chennai'].includes(state.cityName)) {
      $('official').hidden = false;
      $('official').innerHTML = `<div class="official"><h3>Official statistics</h3><p class="muted small">No city-specific statistics are configured for this location in the prototype. Community reports below are filtered by your nearby location.</p></div>`;
      return;
    }
    try {
      const d = await api('/official-data/?city=' + encodeURIComponent(state.cityName));

      $('official').innerHTML = `
        <div class="official">
          <h3>
            Official statistics
            <span class="muted">${esc(d.city)}</span>
          </h3>

          <span class="tagill">Illustrative data</span>

          <table>
            ${(d.rows || []).map((r) => `
              <tr>
                <td>
                  ${esc(r.crime_head)}
                  <span class="muted small">per lakh</span>
                </td>
                <td>${esc(r.rate_per_lakh)}</td>
              </tr>
            `).join('')}
          </table>

          <p class="muted small" style="margin-top:8px">
            ${esc(d.granularity)}. Shown separately — never merged into
            community scores. ${esc(d.note)}
          </p>
        </div>
      `;
    } catch (e) {
      $('official').hidden = true;
      console.error('Official statistics failed:', e);
    }
  }

  /* ---------- Data loading ---------- */

  async function loadData() {
    if (!state.location) {
      // Do not silently fall back to the global Bengaluru demo dataset when
      // the user has not granted location access.
      state.reports = [];
      state.areas = [];
      state.selectedArea = null;
      state.selectedStreet = null;
      renderMarkers();
      renderStreets();
      $('scorecard').innerHTML = `<div class="sc-loc">Nearby area scores</div><div class="sc-name">Location access needed</div><p class="muted small">Allow location access in your browser to see reports within 10 km of you. Your map will not default to Bengaluru.</p>`;
      return;
    }

    const nearbyQuery = `?lat=${encodeURIComponent(state.location.lat)}&lng=${encodeURIComponent(state.location.lng)}&radius=${state.radiusMeters}`;
    const [reports, areas] = await Promise.all([
      api('/reports/' + nearbyQuery),
      api('/areas/' + nearbyQuery)
    ]);

    state.reports = reports;
    state.areas = areas;

    // Refresh all markers with the newest report data.
    renderMarkers();

    // Only fit seeded areas when geolocation was unavailable. With a device
    // location, keep the map centered on that location instead of snapping away.
    if (!state.location && state.areas.length && !state.fitted) {
      map.fitBounds(
        state.areas.map((a) => [
          Number(a.center_lat),
          Number(a.center_lng)
        ]),
        { padding: [60, 60] }
      );

      state.fitted = true;
    }

    if (!state.areas.length) {
      state.selectedArea = null;
      state.selectedStreet = null;
      $('scorecard').innerHTML = `<div class="sc-loc">Nearby area scores</div><div class="sc-name">No scored areas nearby yet</div><p class="muted small">Reports and area scores appear here when this location has data. Existing demo areas are currently seeded in Bengaluru.</p>`;
    }

    // Select the lowest-scoring area initially.
    if (!state.selectedArea && state.areas.length) {
      const worst = [...state.areas].sort(
        (a, b) => a.composite_score - b.composite_score
      )[0];

      state.selectedArea = worst.id;
      state.selectedStreet = null;
    }

    // Keep the selected area and street visible after refresh.
    if (state.selectedArea) {
      const exists = state.areas.some(
        (a) => String(a.id) === String(state.selectedArea)
      );

      if (exists) {
        await selectArea(
          state.selectedArea,
          state.selectedStreet,
          false
        );
      } else {
        state.selectedArea = null;
        state.selectedStreet = null;
      }
    }

    renderStreets();
  }

  /* ---------- Authentication ---------- */

  function renderUser() {
    $('userbox').innerHTML = state.user
      ? `
          <b>${esc(state.user.username)}</b>
          <span class="muted">
            ${state.user.is_authority ? 'Authority' : 'Citizen'}
          </span>
          <br>
          <button class="btn-ghost" id="signout">Sign out</button>
        `
      : '<button class="btn-ghost" id="signin">Sign in</button>';

    const signout = $('signout');
    if (signout) {
      signout.onclick = () => {
        state.token = null;
        state.user = null;

        localStorage.removeItem('gt_token');
        renderUser();
        setView();
      };
    }

    const signin = $('signin');
    if (signin) signin.onclick = () => openLogin();
  }

  function openLogin(msg) {
    $('lg-err').textContent = msg || '';
    $('modal-login').hidden = false;
  }

  async function login(username, password) {
    try {
      const t = await api('/auth/token/', {
        method: 'POST',
        json: { username, password }
      });

      state.token = t.access;
      localStorage.setItem('gt_token', t.access);

      state.user = await api('/me/');

      renderUser();
      $('modal-login').hidden = true;

      toast(`Signed in as ${state.user.username}`);
      await setView();

      return true;
    } catch (e) {
      $('lg-err').textContent = 'Wrong username or password.';
      return false;
    }
  }

  $('login-form').addEventListener('submit', (e) => {
    e.preventDefault();

    login(
      $('lg-user').value.trim(),
      $('lg-pass').value
    );
  });

  $('demo-citizen').onclick = () => login('demo', 'demo1234');
  $('demo-auth').onclick = () => login('admin', 'admin1234');

  $('login-close').onclick = () => {
    $('modal-login').hidden = true;
  };

  /* ---------- Report form ---------- */

  function buildSliders() {
    $('sliders').innerHTML = PARAMS.map((p) => `
      <div class="slider">
        <div class="sl-h">
          <span>${LABELS[p]}</span>
          <span class="mono" id="v-${p}">5</span>
        </div>
        <input type="range" min="0" max="10" value="5" id="s-${p}">
      </div>
    `).join('');

    PARAMS.forEach((p) => {
      $('s-' + p).addEventListener('input', (e) => {
        $('v-' + p).textContent = e.target.value;
      });
    });
  }

  function setDraft(lat, lng) {
    state.draft = { lat, lng };

    $('rp-loc').textContent =
      `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

    if (draftMarker) map.removeLayer(draftMarker);

    draftMarker = L.marker([lat, lng]).addTo(map);
  }

  function openReport() {
    if (!state.user) {
      openLogin('Sign in to submit a report.');
      return;
    }

    if (!state.draft) {
      const center = map.getCenter();
      setDraft(center.lat, center.lng);
    }

    $('rp-err').textContent = '';
    $('modal-report').hidden = false;
  }

  $('btn-new').onclick = openReport;

  $('rp-cancel').onclick = () => {
    $('modal-report').hidden = true;
  };

  $('rp-geo').onclick = () => {
    if (!navigator.geolocation) {
      $('rp-err').textContent =
        'Geolocation unavailable — use "Pick on map".';
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (p) => {
        setDraft(p.coords.latitude, p.coords.longitude);

        map.flyTo(
          [p.coords.latitude, p.coords.longitude],
          16
        );
      },
      () => {
        $('rp-err').textContent =
          'Location permission denied — use "Pick on map" instead.';
      }
    );
  };

  $('rp-pick').onclick = () => {
    $('modal-report').hidden = true;
    state.picking = true;
    $('pickbanner').hidden = false;
  };

  $('pick-cancel').onclick = () => {
    state.picking = false;
    $('pickbanner').hidden = true;
    $('modal-report').hidden = false;
  };

  map.on('click', (e) => {
    if (!state.picking) return;

    state.picking = false;
    $('pickbanner').hidden = true;

    setDraft(e.latlng.lat, e.latlng.lng);
    $('modal-report').hidden = false;
  });

  $('report-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!state.draft) {
      $('rp-err').textContent = 'Pick a location first.';
      return;
    }

    const fd = new FormData();

    fd.append('street_name', $('rp-street').value.trim());
    fd.append('latitude', state.draft.lat);
    fd.append('longitude', state.draft.lng);

    PARAMS.forEach((p) => {
      fd.append(p, $('s-' + p).value);
    });

    fd.append('comment', $('rp-comment').value.trim());

    const photo = $('rp-photo').files[0];
    if (photo) fd.append('photo', photo);

    const btn = $('rp-submit');
    btn.disabled = true;
    $('rp-err').textContent = '';

    try {
      const res = await api('/reports/', {
        method: 'POST',
        body: fd
      });

      const previous = state.areas.find(
        (a) => String(a.id) === String(res.area)
      );

      const previousScore = previous
        ? Math.round(previous.composite_score)
        : null;

      $('modal-report').hidden = true;
      $('report-form').reset();
      buildSliders();

      if (draftMarker) {
        map.removeLayer(draftMarker);
        draftMarker = null;
      }

      const pos = [
        Number(res.latitude),
        Number(res.longitude)
      ];

      state.draft = null;

      // Refresh the reports, markers, streets and scorecard.
      await loadData();

      if (res.area) {
        await selectArea(res.area, res.street_name || null, false);
      }

      map.flyTo(pos, 16, { duration: 0.8 });

      L.circleMarker(pos, {
        radius: 11,
        color: '#073C36',
        fillOpacity: 0,
        className: 'pulse'
      }).addTo(map);

      if (res.flagged) {
        toast(
          `Report held for moderation (${String(res.flag_reason || 'review')
            .replace(/_/g, ' ')}). It won't affect scores until reviewed.`,
          6500
        );
      } else if (res.area_score != null) {
        toast(
          `Report added. ${previous ? previous.name : 'Area'} score: ${
            previousScore ?? '—'
          } → ${Math.round(res.area_score)}`,
          6500
        );
      } else {
        toast('Report added (outside any scored area yet).');
      }
    } catch (err) {
      if (err.status === 401) {
        $('modal-report').hidden = true;
        openLogin('Your session expired — sign in again.');
      } else {
        $('rp-err').textContent = err.data
          ? Object.entries(err.data)
              .map(([k, v]) => `${k}: ${[].concat(v).join(' ')}`)
              .join(' · ')
          : 'Could not submit. Try again.';

        console.error('Report submission failed:', err);
      }
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- Authority dashboard ---------- */

  async function renderAuthority() {
    if (!state.user || !state.user.is_authority) {
      location.hash = '#/';
      openLogin(
        'The authority dashboard needs an authority account. Try the demo login below.'
      );
      return;
    }

    try {
      const d = await api('/authority/summary/');
      const k = d.kpis;

      $('kpis').innerHTML = [
        ['Active reports (30d)', k.active_reports_30d],
        ['Avg. area score', k.avg_area_score + '/100'],
        ['Streets flagged poor', k.streets_flagged_poor],
        ['Issues resolved', k.issues_resolved]
      ].map(([title, value]) => `
        <div class="kpi">
          <div class="l">${esc(title)}</div>
          <div class="v">${esc(value)}</div>
        </div>
      `).join('');

      areaLayer.clearLayers();

      (d.areas || []).forEach((a) => {
        const color = hexColor(a.composite_score);

        L.circle(
          [a.center_lat, a.center_lng],
          {
            radius: 350 + a.report_count * 14,
            color,
            fillColor: color,
            fillOpacity: 0.28,
            weight: 2
          }
        )
          .bindTooltip(
            `${esc(a.name)} · ${Math.round(a.composite_score)}/100 · ${a.report_count} reports`
          )
          .addTo(areaLayer);
      });

      $('issues').innerHTML = d.top_issues?.length
        ? d.top_issues.map((issue, index) => `
            <div class="issue">
              <span class="sev"
                style="background:${
                  issue.severity === 'poor'
                    ? 'var(--poor)'
                    : 'var(--warn)'
                }"></span>

              <div>
                <div class="sn">
                  ${esc(issue.label)} — ${esc(issue.area_name)}
                </div>
                <div class="sm">Reported repeatedly by residents</div>
              </div>

              <span class="sv cnt" style="margin-left:auto">
                ${esc(issue.count)}
              </span>

              <button class="btn-ghost" data-n="${index}">
                Resolve
              </button>
            </div>
          `).join('')
        : '<div class="muted small">No open recurring issues. 🎉</div>';

      $('issues').querySelectorAll('button[data-n]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const issue = d.top_issues[Number(btn.dataset.n)];
          btn.disabled = true;

          try {
            const result = await api('/authority/resolve/', {
              method: 'POST',
              json: {
                area: issue.area,
                parameter: issue.parameter
              }
            });

            toast(
              `Marked resolved: ${issue.label} in ${issue.area_name} (${result.resolved_reports} reports).`
            );

            await renderAuthority();
            await loadData();
          } catch (e) {
            console.error('Resolve failed:', e);
            toast('Could not resolve that issue.');
            btn.disabled = false;
          }
        });
      });
    } catch (e) {
      console.error('Authority dashboard failed:', e);
      toast('Could not load the authority dashboard.');
    }
  }

  /* ---------- Navigation ---------- */

  async function setView() {
    const requestId = ++viewRequestId;
    const auth = location.hash === '#/authority';

    state.view = auth ? 'authority' : 'map';

    $('nav-map').classList.toggle('active', !auth);
    $('nav-auth').classList.toggle('active', auth);

    $('kpis').hidden = !auth;
    $('panel-authority').hidden = !auth;
    $('panel-citizen').hidden = auth;
    $('filters').hidden = auth;

    if (auth) {
      map.removeLayer(markerLayer);
      areaLayer.addTo(map);
    } else {
      map.removeLayer(areaLayer);
      markerLayer.addTo(map);
    }

    // Allow the visible panel to settle before resizing Leaflet.
    await new Promise((resolve) => requestAnimationFrame(resolve));

    map.invalidateSize();

    try {
      if (auth) {
        await renderAuthority();
      } else {
        await loadData();
        renderMarkers();
        renderStreets();
      }
    } catch (e) {
      console.error('View refresh failed:', e);
      toast('Could not refresh the view. Check the server and try again.');
    }

    // Avoid applying layout updates for an outdated navigation request.
    if (requestId === viewRequestId) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      map.invalidateSize();

      if (!auth) renderStreets();
    }
  }

  window.addEventListener('hashchange', setView);

  /* ---------- Search ---------- */

  $('search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;

    const query = e.target.value.trim().toLowerCase();
    if (!query) return;

    const area = state.areas.find(
      (a) => a.name.toLowerCase().includes(query)
    );

    if (area) {
      map.flyTo([area.center_lat, area.center_lng], 14);
      selectArea(area.id);
      return;
    }

    const report = state.reports.find(
      (r) => (r.street_name || '').toLowerCase().includes(query)
    );

    if (report) {
      map.flyTo(
        [report.latitude, report.longitude],
        16
      );

      selectArea(report.area, report.street_name);
      return;
    }

    toast('No matching street or area.');
  });

  /* ---------- Automatic refresh ---------- */

  async function refreshGroundTruth() {
    // Do not refresh hidden tabs or overlap an existing refresh.
    if (
      refreshInProgress ||
      document.visibilityState !== 'visible'
    ) {
      return;
    }

    refreshInProgress = true;

    try {
      if (state.view === 'authority') {
        await renderAuthority();

        // Keep the authority view's map dimensions correct.
        map.invalidateSize();
      } else {
        await loadData();

        renderMarkers();
        renderStreets();
        map.invalidateSize();
      }
    } catch (e) {
      console.error('Automatic refresh failed:', e);
    } finally {
      refreshInProgress = false;
    }
  }

  // Refresh as soon as the user returns to this browser tab.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshGroundTruth();
    }
  });

  // Refresh periodically while the app is open.
  refreshTimer = setInterval(() => {
    refreshGroundTruth();
  }, 30000);

  // Optional: refresh immediately when network connectivity returns.
  window.addEventListener('online', refreshGroundTruth);

  /* ---------- Device location ---------- */

  function detectDeviceLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        state.locationName = 'Location unavailable';
        resolve();
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          state.location = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
          };
          state.locationName = 'Near your location';
          // Match only when close to one of the prototype's supported city
          // centres; do not guess a city for other coordinates.
          const knownCities = [
            { name: 'Bengaluru', lat: 12.9716, lng: 77.5946 },
            { name: 'Delhi', lat: 28.6139, lng: 77.2090 },
            { name: 'Mumbai', lat: 19.0760, lng: 72.8777 },
            { name: 'Chennai', lat: 13.0827, lng: 80.2707 }
          ];
          const distanceKm = (a, b) => {
            const rad = (n) => n * Math.PI / 180;
            const dLat = rad(b.lat - a.lat);
            const dLng = rad(b.lng - a.lng);
            const q = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
            return 6371 * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
          };
          const nearestCity = knownCities
            .map((city) => ({ ...city, distance: distanceKm(state.location, city) }))
            .sort((a, b) => a.distance - b.distance)[0];
          state.cityName = nearestCity && nearestCity.distance <= 35 ? nearestCity.name : null;
          if (state.cityName) state.locationName = state.cityName;
          map.setView([state.location.lat, state.location.lng], 13);
          state.fitted = true;
          resolve();
        },
        (error) => {
          console.warn('Device location unavailable:', error.message);
          state.location = null;
          state.locationName = 'Location permission needed';
          state.cityName = null;
          resolve();
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
      );
    });
  }

  /* ---------- Boot ---------- */

  async function boot() {
    buildSliders();
    renderFilters();

    if (state.token) {
      try {
        state.user = await api('/me/');
      } catch (e) {
        state.token = null;
        localStorage.removeItem('gt_token');
      }
    }

    renderUser();

    await detectDeviceLocation();
    const cityChip = document.querySelector('.chip-city');
    if (cityChip) cityChip.textContent = '📍 ' + state.locationName;
    await loadOfficial();

    try {
      await setView();
    } catch (e) {
      console.error('Application startup failed:', e);
      toast('Could not reach the API. Is the server running?');
    }
  }

  boot();
})();
