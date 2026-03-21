/**
 * KegLevel Demo — Mock API Layer
 * Intercepts all fetch() calls to /api/* and returns in-memory mock responses.
 * State is persisted to localStorage so it survives refreshes and is shared
 * across pages (main app + BatchFlow) on the same origin.
 * Loaded before app.js so the override is in place when the app boots.
 */
"use strict";

(function () {
  const STORE_KEY = "keglevel_demo_state";

  /* ------------------------------------------------------------------ */
  /*  UUID helper                                                        */
  /* ------------------------------------------------------------------ */
  function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Default data (used on first visit or after reset)                  */
  /* ------------------------------------------------------------------ */
  function createDefaults() {
    const bevs = [
      { id: uuid(), name: "Hazy Horizon IPA",    style: "New England IPA",  abv: 6.8, ibu: 45, srm: 6  },
      { id: uuid(), name: "West Coast Crusher",  style: "West Coast IPA",   abv: 7.2, ibu: 65, srm: 8  },
      { id: uuid(), name: "Midnight Oat Stout",  style: "Oatmeal Stout",    abv: 5.4, ibu: 30, srm: 35 },
      { id: uuid(), name: "Bavarian Sun Hefe",   style: "Hefeweizen",       abv: 4.9, ibu: 12, srm: 4  },
      { id: uuid(), name: "Crisp Lager",         style: "Pilsner",          abv: 4.5, ibu: 28, srm: 3  },
    ];
    const kgs = [
      { id: uuid(), name: "Keg 01", title: "Keg 01", beverage_id: bevs[0].id, beverage_name: bevs[0].name, style: bevs[0].style, abv: bevs[0].abv, starting_volume_liters: 18.93, maximum_full_volume_liters: 18.93, tare_weight_kg: 7.0, starting_total_weight_kg: 26.2, current_dispensed_liters: 4.73, total_dispensed_pulses: 24123, tap_index: 0, tapped_date: "2026-03-01", fill_date: "2026-02-28", notes: "" },
      { id: uuid(), name: "Keg 02", title: "Keg 02", beverage_id: bevs[1].id, beverage_name: bevs[1].name, style: bevs[1].style, abv: bevs[1].abv, starting_volume_liters: 9.46, maximum_full_volume_liters: 9.46, tare_weight_kg: 3.6, starting_total_weight_kg: 13.2, current_dispensed_liters: 2.66, total_dispensed_pulses: 13566, tap_index: 1, tapped_date: "2026-03-05", fill_date: "2026-03-04", notes: "" },
      { id: uuid(), name: "Keg 03", title: "Keg 03", beverage_id: bevs[2].id, beverage_name: bevs[2].name, style: bevs[2].style, abv: bevs[2].abv, starting_volume_liters: 18.93, maximum_full_volume_liters: 18.93, tare_weight_kg: 7.0, starting_total_weight_kg: 26.2, current_dispensed_liters: 14.23, total_dispensed_pulses: 72573, tap_index: 2, tapped_date: "2026-02-15", fill_date: "2026-02-14", notes: "" },
      { id: uuid(), name: "Keg 04", title: "Keg 04", beverage_id: bevs[3].id, beverage_name: bevs[3].name, style: bevs[3].style, abv: bevs[3].abv, starting_volume_liters: 18.93, maximum_full_volume_liters: 18.93, tare_weight_kg: 4.0, starting_total_weight_kg: 23.2, current_dispensed_liters: 1.89, total_dispensed_pulses: 9639, tap_index: 3, tapped_date: "2026-03-10", fill_date: "2026-03-09", notes: "" },
      { id: uuid(), name: "Keg 05", title: "Keg 05", beverage_id: bevs[4].id, beverage_name: bevs[4].name, style: bevs[4].style, abv: bevs[4].abv, starting_volume_liters: 9.46, maximum_full_volume_liters: 9.46, tare_weight_kg: 3.6, starting_total_weight_kg: 13.2, current_dispensed_liters: 7.06, total_dispensed_pulses: 36006, tap_index: 4, tapped_date: "2026-02-20", fill_date: "2026-02-19", notes: "" },
    ];
    const cfg = {
      k_factors: [5100, 5100, 5100, 5100, 5100],
      active_taps: 5,
      tap_labels: ["Tap 1", "Tap 2", "Tap 3", "Tap 4", "Tap 5"],
      mdns_hostname: "keglevel",
    };
    const bf = {
      columns: {
        on_rotation: [bevs[0].id, bevs[1].id],
        on_deck: [bevs[4].id],
        fermenting: [bevs[3].id],
        lagering_or_finishing: [bevs[2].id],
      },
      titles: { rotation: "On Rotation", deck: "On Deck", fermenting: "Fermenting", finishing: "Lagering / Finishing" },
      collapsed: {},
    };
    return { beverages: bevs, kegs: kgs, config: cfg, batchflow: bf };
  }

  /* ------------------------------------------------------------------ */
  /*  localStorage persistence                                          */
  /* ------------------------------------------------------------------ */
  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.beverages && s.kegs && s.config && s.batchflow) return s;
      }
    } catch (_) {}
    return null;
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        beverages: beverages,
        kegs: kegs,
        config: config,
        batchflow: batchflow,
      }));
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ */
  /*  Initialize state (from localStorage or defaults)                   */
  /* ------------------------------------------------------------------ */
  const saved = loadState();
  const defaults = saved || createDefaults();
  const beverages = defaults.beverages;
  const kegs = defaults.kegs;
  const config = defaults.config;
  let batchflow = defaults.batchflow;

  if (!saved) persist();

  /* ------------------------------------------------------------------ */
  /*  Temperature simulation                                             */
  /* ------------------------------------------------------------------ */
  let currentTempF = 38.0;
  function fluctuateTemp() {
    currentTempF += (Math.random() - 0.5) * 0.6;
    currentTempF = Math.max(36, Math.min(42, currentTempF));
  }

  /* ------------------------------------------------------------------ */
  /*  Pour state (per-tap pouring flag with auto-clear)                  */
  /* ------------------------------------------------------------------ */
  const pouringUntil = [0, 0, 0, 0, 0];

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */
  function findKegOnTap(tapIndex) {
    return kegs.find((k) => k.tap_index === tapIndex) || null;
  }

  function bevById(id) {
    return beverages.find((b) => b.id === id) || null;
  }

  function kegById(id) {
    return kegs.find((k) => k.id === id) || null;
  }

  function nextKegNumber() {
    let max = 0;
    kegs.forEach((k) => {
      const m = (k.name || "").match(/^Keg\s+(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return max + 1;
  }

  function buildTapState(tapIndex) {
    const keg = findKegOnTap(tapIndex);
    const bev = keg ? bevById(keg.beverage_id) : null;
    const remaining = keg
      ? Math.max(0, keg.starting_volume_liters - keg.current_dispensed_liters)
      : 0;
    const pouring = Date.now() < pouringUntil[tapIndex];
    return {
      index: tapIndex,
      dispensed_liters: keg ? keg.current_dispensed_liters : 0,
      remaining_liters: remaining,
      starting_volume_liters: keg ? keg.starting_volume_liters : 0,
      maximum_full_volume_liters: keg ? keg.maximum_full_volume_liters : 18.93,
      pouring: pouring,
      flow_rate_lpm: pouring ? 1.8 : 0,
      lifetime_pulses: keg ? keg.total_dispensed_pulses : 0,
      keg_id: keg ? keg.id : "",
      keg_name: keg ? (keg.title || keg.name) : "",
      beverage_name: bev ? bev.name : (keg ? keg.beverage_name : ""),
      style: bev ? bev.style : (keg ? keg.style : ""),
      abv: bev ? bev.abv : (keg ? keg.abv : 0),
      ibu: bev ? bev.ibu : null,
      srm: bev ? bev.srm : null,
      tap_label: config.tap_labels[tapIndex] || `Tap ${tapIndex + 1}`,
    };
  }

  function ok(data, status) {
    return { data: data, status: status || 200 };
  }

  function err(msg, status) {
    return { data: { error: msg }, status: status || 400 };
  }

  /* ------------------------------------------------------------------ */
  /*  Route handler                                                      */
  /* ------------------------------------------------------------------ */
  function route(method, path, body) {
    /* --- State ---------------------------------------------------- */
    if (method === "GET" && (path === "/api/state" || path === "/api/state/fast")) {
      fluctuateTemp();
      const taps = [];
      for (let i = 0; i < config.active_taps; i++) taps.push(buildTapState(i));
      return ok({
        taps: taps,
        temperature: {
          celsius: parseFloat(((currentTempF - 32) * 5 / 9).toFixed(1)),
          fahrenheit: parseFloat(currentTempF.toFixed(1)),
          sensor_available: true,
        },
        active_taps: config.active_taps,
        any_pouring: pouringUntil.some((t) => Date.now() < t),
        ip: "192.168.1.100",
        version: "1.5.0-demo",
        calibration: { standby: false, locked_tap: -1, pulses: 0 },
        wifi_mode: "sta",
      });
    }

    /* --- Version -------------------------------------------------- */
    if (method === "GET" && path === "/api/version") {
      return ok({ version: "1.5.0-demo" });
    }

    /* --- Config --------------------------------------------------- */
    if (method === "GET" && path === "/api/config") {
      return ok(Object.assign({}, config));
    }
    if (method === "PUT" && path === "/api/config") {
      Object.assign(config, body);
      persist();
      return ok({ status: "ok", config: Object.assign({}, config) });
    }

    /* --- Kegs ----------------------------------------------------- */
    if (method === "GET" && path === "/api/kegs") {
      return ok(kegs.slice());
    }
    if (method === "POST" && path === "/api/kegs") {
      const nextNum = nextKegNumber();
      const autoName = "Keg " + String(nextNum).padStart(2, "0");
      const keg = Object.assign(
        {
          id: uuid(),
          name: autoName,
          title: autoName,
          tap_index: -1,
          current_dispensed_liters: 0,
          total_dispensed_pulses: 0,
          tapped_date: "",
          fill_date: "",
          notes: "",
          tare_weight_kg: 4.5,
          starting_total_weight_kg: 23.5,
          maximum_full_volume_liters: 19,
          starting_volume_liters: 18.93,
        },
        body
      );
      keg.name = autoName;
      keg.title = autoName;
      kegs.push(keg);
      persist();
      return ok(keg, 201);
    }

    const kegMatch = path.match(/^\/api\/kegs\/(.+)$/);
    if (kegMatch) {
      const keg = kegById(kegMatch[1]);
      if (!keg) return err("Keg not found", 404);
      if (method === "GET") return ok(Object.assign({}, keg));
      if (method === "PUT") {
        Object.assign(keg, body);
        persist();
        return ok(Object.assign({}, keg));
      }
      if (method === "DELETE") {
        const idx = kegs.indexOf(keg);
        if (idx >= 0) kegs.splice(idx, 1);
        persist();
        return ok({ status: "ok", deleted: kegMatch[1] });
      }
    }

    /* --- Beverages ------------------------------------------------ */
    if (method === "GET" && path === "/api/beverages") {
      return ok(beverages.slice());
    }
    if (method === "POST" && path === "/api/beverages") {
      const bev = Object.assign(
        { id: uuid(), name: "New Beverage", style: "", abv: 0, ibu: null, srm: null },
        body
      );
      beverages.push(bev);
      persist();
      return ok(bev, 201);
    }

    const bevMatch = path.match(/^\/api\/beverages\/(.+)$/);
    if (bevMatch) {
      const bev = bevById(bevMatch[1]);
      if (!bev) return err("Beverage not found", 404);
      if (method === "GET") return ok(Object.assign({}, bev));
      if (method === "PUT") {
        Object.assign(bev, body);
        persist();
        return ok(Object.assign({}, bev));
      }
      if (method === "DELETE") {
        const idx = beverages.indexOf(bev);
        if (idx >= 0) beverages.splice(idx, 1);
        persist();
        return ok({ status: "ok", deleted: bevMatch[1] });
      }
    }

    /* --- Taps ----------------------------------------------------- */
    if (method === "GET" && path === "/api/taps") {
      const result = [];
      for (let i = 0; i < 5; i++) {
        const keg = findKegOnTap(i);
        result.push({
          index: i,
          active: i < config.active_taps,
          label: config.tap_labels[i] || `Tap ${i + 1}`,
          k_factor: config.k_factors[i] || 5100,
          keg_id: keg ? keg.id : "",
          keg_name: keg ? (keg.title || keg.name) : "",
          dispensed_liters: keg ? keg.current_dispensed_liters : 0,
        });
      }
      return ok(result);
    }

    const tapPut = path.match(/^\/api\/taps\/(\d+)$/);
    if (tapPut && method === "PUT") {
      const ti = parseInt(tapPut[1], 10);
      if (body.keg_id !== undefined) {
        kegs.forEach((k) => { if (k.tap_index === ti) k.tap_index = -1; });
        if (body.keg_id) {
          const keg = kegById(body.keg_id);
          if (keg) keg.tap_index = ti;
        }
      }
      if (body.label !== undefined) config.tap_labels[ti] = body.label;
      if (body.k_factor !== undefined) config.k_factors[ti] = body.k_factor;
      persist();
      return ok({ status: "ok", tap: ti });
    }

    /* --- Pour adjust ---------------------------------------------- */
    const adjustMatch = path.match(/^\/api\/taps\/(\d+)\/adjust$/);
    if (adjustMatch && method === "POST") {
      const ti = parseInt(adjustMatch[1], 10);
      const liters = parseFloat(body?.liters) || 0;
      const keg = findKegOnTap(ti);
      if (keg && liters > 0) {
        const remaining = Math.max(0, keg.starting_volume_liters - keg.current_dispensed_liters);
        const actual = Math.min(liters, remaining);
        keg.current_dispensed_liters += actual;
        keg.total_dispensed_pulses += Math.round(actual * (config.k_factors[ti] || 5100));
        pouringUntil[ti] = Date.now() + 1500;
        persist();
      }
      return ok({ status: "ok", tap: ti, adjusted_liters: liters });
    }

    /* --- Tap reset ------------------------------------------------ */
    const tapReset = path.match(/^\/api\/taps\/(\d+)\/reset$/);
    if (tapReset && method === "POST") {
      const ti = parseInt(tapReset[1], 10);
      kegs.forEach((k) => { if (k.tap_index === ti) k.tap_index = -1; });
      persist();
      return ok({ status: "ok", tap: ti });
    }

    /* --- BatchFlow ------------------------------------------------ */
    if (method === "GET" && path === "/api/batchflow") {
      return ok(JSON.parse(JSON.stringify(batchflow)));
    }
    if (method === "PUT" && path === "/api/batchflow") {
      batchflow = body;
      persist();
      return ok({ status: "ok" });
    }

    /* --- Alerts (stub) -------------------------------------------- */
    if (method === "GET" && path === "/api/alerts/config") {
      return ok({
        mailgun_api_key: "***",
        mailgun_domain: "",
        from_email: "",
        to_email: "",
        push_enabled: false,
        push_interval: "daily",
        conditional_enabled: false,
        low_volume_threshold_liters: 0,
        low_temp_threshold_f: 27,
        high_temp_threshold_f: 200,
      });
    }
    if (method === "PUT" && path === "/api/alerts/config") {
      return ok({ status: "ok", alerts: body });
    }
    if (method === "POST" && path === "/api/alerts/test") {
      return ok({ status: "ok", message: "Demo mode — no email sent." });
    }

    /* --- Calibration stubs --------------------------------------- */
    if (path === "/api/calibration/standby" && method === "POST") {
      return ok({ status: "ok", standby: body?.active ?? false });
    }
    if (path === "/api/calibration/reset" && method === "POST") {
      return ok({ status: "ok" });
    }

    /* --- History (empty) ----------------------------------------- */
    if (method === "GET" && path === "/api/history") {
      return ok([]);
    }

    /* --- Fallback ------------------------------------------------ */
    return err("Not found (demo)", 404);
  }

  /* ------------------------------------------------------------------ */
  /*  Monkey-patch window.fetch                                          */
  /* ------------------------------------------------------------------ */
  const _realFetch = window.fetch;

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);

    if (!url.includes("/api/")) {
      return _realFetch.call(this, input, init);
    }

    let pathname;
    try {
      pathname = new URL(url, window.location.origin).pathname;
    } catch (_) {
      pathname = url;
    }

    const method = ((init && init.method) || "GET").toUpperCase();
    let body = null;
    if (init && init.body) {
      try { body = JSON.parse(init.body); } catch (_) { body = null; }
    }

    const result = route(method, pathname, body);

    return new Response(JSON.stringify(result.data), {
      status: result.status,
      statusText: result.status === 200 ? "OK" : result.status === 201 ? "Created" : "Error",
      headers: { "Content-Type": "application/json" },
    });
  };

  console.log("%c[KegLevel Demo] Mock API active — state persisted to localStorage", "color:#ffc107;font-weight:bold");
})();
