(function (globalRef) {
  const state = {
    phase: 'idle',
    reasonCode: null,
    lastError: null,
    lifecycle: {
      running: false,
      setupCalls: 0,
      updateCalls: 0,
      drawCalls: 0,
      frameCount: 0,
      lastDeltaSeconds: 0
    }
  };
  let cachedManifest = null;
  let cachedRuntimeConfig = null;
  let cachedRootUrl = '.';
  let mountedRuntime = null;
  let auraRuntime = null;

  function normalizeCount(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return 0;
    return Math.floor(numeric);
  }

  function normalizeDeltaSeconds(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return 0;
    return Number(numeric.toFixed(6));
  }

  function cloneLifecycle(lifecycle) {
    const source = lifecycle && typeof lifecycle === 'object' ? lifecycle : {};
    return {
      running: source.running === true,
      setupCalls: normalizeCount(source.setupCalls),
      updateCalls: normalizeCount(source.updateCalls),
      drawCalls: normalizeCount(source.drawCalls),
      frameCount: normalizeCount(source.frameCount),
      lastDeltaSeconds: normalizeDeltaSeconds(source.lastDeltaSeconds)
    };
  }

  function setState(phase, reasonCode, error) {
    state.phase = phase;
    state.reasonCode = reasonCode || null;
    state.lastError = error || null;
  }

  function createError(reasonCode, message, layer, retryable, details) {
    const error = new Error(message);
    error.ok = false;
    error.reasonCode = reasonCode;
    error.layer = layer;
    error.retryable = Boolean(retryable);
    error.details = details || {};
    return error;
  }

  function normalizeError(error, fallbackReasonCode, fallbackMessage, fallbackLayer, fallbackRetryable) {
    if (error && typeof error === 'object' && typeof error.reasonCode === 'string') {
      return error;
    }
    return createError(
      fallbackReasonCode,
      fallbackMessage,
      fallbackLayer,
      fallbackRetryable,
      { cause: String(error && error.message ? error.message : error) }
    );
  }

  async function captureFailure(fallback, operation) {
    try {
      return await operation();
    } catch (error) {
      const normalized = normalizeError(
        error,
        fallback.reasonCode,
        fallback.message,
        fallback.layer,
        fallback.retryable
      );
      setState('error', normalized.reasonCode, {
        reasonCode: normalized.reasonCode,
        layer: normalized.layer || fallback.layer,
        retryable: normalized.retryable === true,
        details: normalized.details || {}
      });
      throw normalized;
    }
  }

  async function readJson(path, missingCode, parseCode) {
    let response;
    try {
      response = await fetch(path, { cache: 'no-store' });
    } catch (error) {
      throw createError(missingCode, 'Failed to fetch ' + path + '.', 'loader', false, { cause: String(error) });
    }
    if (!response || response.ok !== true) {
      throw createError(missingCode, path + ' not found.', 'loader', false, { status: response ? response.status : null });
    }
    try {
      return await response.json();
    } catch (error) {
      throw createError(parseCode, path + ' is not valid JSON.', 'loader', false, { cause: String(error) });
    }
  }

  function normalizePath(path) {
    if (typeof path !== 'string') return '';
    return path.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  function clampUnit(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    if (numeric <= 0) return 0;
    if (numeric >= 1) return 1;
    return numeric;
  }

  function createUnitColor(r, g, b, a) {
    return {
      r: clampUnit(r, 0),
      g: clampUnit(g, 0),
      b: clampUnit(b, 0),
      a: clampUnit(a == null ? 1 : a, 1)
    };
  }

  function createByteColor(r, g, b, a) {
    return {
      r: Math.max(0, Math.min(255, Math.round(Number(r) || 0))),
      g: Math.max(0, Math.min(255, Math.round(Number(g) || 0))),
      b: Math.max(0, Math.min(255, Math.round(Number(b) || 0))),
      a: Math.max(0, Math.min(255, Math.round(Number.isFinite(Number(a)) ? Number(a) : 255)))
    };
  }

  function normalizeColor(value, fallback) {
    const source = value && typeof value === 'object' ? value : null;
    const base = fallback && typeof fallback === 'object' ? fallback : createUnitColor(1, 1, 1, 1);
    if (!source) {
      return createUnitColor(base.r, base.g, base.b, base.a);
    }

    const rawR = Number(source.r);
    const rawG = Number(source.g);
    const rawB = Number(source.b);
    const rawA = source.a == null ? base.a : Number(source.a);
    const treatAsByteRange = [rawR, rawG, rawB, rawA].some((component) => Number.isFinite(component) && component > 1);

    if (treatAsByteRange) {
      return createUnitColor(
        Number.isFinite(rawR) ? rawR / 255 : base.r,
        Number.isFinite(rawG) ? rawG / 255 : base.g,
        Number.isFinite(rawB) ? rawB / 255 : base.b,
        Number.isFinite(rawA) ? rawA / 255 : base.a
      );
    }

    return createUnitColor(
      Number.isFinite(rawR) ? rawR : base.r,
      Number.isFinite(rawG) ? rawG : base.g,
      Number.isFinite(rawB) ? rawB : base.b,
      Number.isFinite(rawA) ? rawA : base.a
    );
  }

  function colorToCss(value, fallback) {
    const normalized = normalizeColor(value, fallback);
    return 'rgba('
      + Math.round(normalized.r * 255) + ', '
      + Math.round(normalized.g * 255) + ', '
      + Math.round(normalized.b * 255) + ', '
      + normalized.a + ')';
  }

  function normalizeCanvasSize(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return Math.max(1, Math.floor(numeric));
  }

  function normalizePositiveNumber(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return numeric;
  }

  function toFinite(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function toPositive(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  }

  function clamp01(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 1;
    if (numeric <= 0) return 0;
    if (numeric >= 1) return 1;
    return numeric;
  }

  function isObject(value) {
    return value != null && typeof value === 'object';
  }

  function normalizeMouseButton(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return 0;
    return Math.floor(numeric);
  }

    function sanitizeAssetSourcePath(value) {
      return String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '');
    }

  function isImageMediaType(value) {
    return typeof value === 'string' && value.startsWith('image/');
  }

  function normalizeTextAlign(value) {
    if (value === 'center' || value === 'right' || value === 'left') {
      return value;
    }
    return 'left';
  }

  function normalizeKeyName(value) {
    if (typeof value !== 'string' || value.length === 0) {
      return null;
    }
    const key = value.toLowerCase();
    switch (key) {
      case ' ':
      case 'spacebar':
        return 'space';
      case 'left':
      case 'arrowleft':
        return 'arrowleft';
      case 'right':
      case 'arrowright':
        return 'arrowright';
      case 'up':
      case 'arrowup':
        return 'arrowup';
      case 'down':
      case 'arrowdown':
        return 'arrowdown';
      case 'return':
        return 'enter';
      default:
        return key;
    }
  }

  function rectIntersects(a, b) {
    const ax = Number(a && a.x);
    const ay = Number(a && a.y);
    const aw = Number(a && a.w);
    const ah = Number(a && a.h);
    const bx = Number(b && b.x);
    const by = Number(b && b.y);
    const bw = Number(b && b.w);
    const bh = Number(b && b.h);

    if (![ax, ay, aw, ah, bx, by, bw, bh].every((value) => Number.isFinite(value))) {
      return false;
    }

    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  function resolveTarget(target) {
    if (typeof target === 'string') {
      return document.querySelector(target);
    }
    if (target && typeof target.appendChild === 'function') {
      return target;
    }
    return document.getElementById('aura-root') || document.body;
  }

  function ensureManifestValid(manifest) {
    if (!manifest || manifest.schema !== 'aurajs.web-build-manifest.v1') {
      throw createError(
        'web_manifest_schema_unsupported',
        'Manifest schema major version is unsupported.',
        'loader',
        false,
        { schema: manifest && manifest.schema }
      );
    }
    if (!manifest.entrypoints || typeof manifest.entrypoints.bundle !== 'string' || manifest.entrypoints.bundle.length === 0) {
      throw createError('web_manifest_validation_failed', 'Manifest bundle entrypoint is missing.', 'loader', false, {});
    }
  }

  function ensureRuntimeConfigValid(runtimeConfig) {
    if (!runtimeConfig || runtimeConfig.schema !== 'aurajs.web-runtime-config.v1') {
      throw createError(
        'web_runtime_config_validation_failed',
        'Runtime config schema major version is unsupported.',
        'loader',
        false,
        { schema: runtimeConfig && runtimeConfig.schema }
      );
    }
  }

  function loadScript(path) {
    return new Promise((resolvePromise, rejectPromise) => {
      const script = document.createElement('script');
      script.src = path;
      script.async = false;
      script.onload = function () { resolvePromise(); };
      script.onerror = function () {
        rejectPromise(createError('web_bundle_load_failed', 'Failed to load ' + path + '.', 'loader', true, { path }));
      };
      document.head.appendChild(script);
    });
  }

  function createBrowserAuraSurface(runtimeConfig) {
    const defaultColor = createUnitColor(1, 1, 1, 1);
    let currentRuntimeConfig = runtimeConfig && typeof runtimeConfig === 'object' ? runtimeConfig : {};
    let currentCanvasConfig = currentRuntimeConfig.canvas && typeof currentRuntimeConfig.canvas === 'object'
      ? currentRuntimeConfig.canvas
      : {};
    let currentManifest = { assets: [] };
    let currentRootUrl = '.';

    const auraRef = globalRef.aura && typeof globalRef.aura === 'object'
      ? globalRef.aura
      : {};
    globalRef.aura = auraRef;

    const inputState = {
      down: new Set(),
      pendingPressed: new Set(),
      pendingReleased: new Set(),
      framePressed: new Set(),
      frameReleased: new Set(),
      mouseDown: new Set(),
      pendingMousePressed: new Set(),
      pendingMouseReleased: new Set(),
      frameMousePressed: new Set(),
      frameMouseReleased: new Set()
    };

    const assetState = {
      bySourcePath: new Map(),
      byOutputPath: new Map(),
      loaded: new Map(),
      storageFallback: new Map()
    };

    const runtime = {
      canvas: null,
      mountTarget: null,
      context2d: null,
      configuredWidth: normalizeCanvasSize(currentCanvasConfig.width, 1280),
      configuredHeight: normalizeCanvasSize(currentCanvasConfig.height, 720),
      resizeMode: currentCanvasConfig.resizeMode === 'fixed' ? 'fixed' : 'fit-container',
      pixelRatio: 1,
      width: normalizeCanvasSize(currentCanvasConfig.width, 1280),
      height: normalizeCanvasSize(currentCanvasConfig.height, 720),
      transformDepth: 0,
      worldTransformActive: false,
      listenersAttached: false,
      keydownListener: null,
      keyupListener: null,
      blurListener: null,
      resizeListener: null,
      mousemoveListener: null,
      mousedownListener: null,
      mouseupListener: null,
      wheelListener: null
    };

    function ensureStyleObject(node) {
      if (!node || typeof node !== 'object') return null;
      if (!node.style || typeof node.style !== 'object') {
        node.style = {};
      }
      return node.style;
    }

    function ensureCanvasContext() {
      if (!runtime.canvas) return null;
      if (!runtime.context2d && typeof runtime.canvas.getContext === 'function') {
        runtime.context2d = runtime.canvas.getContext('2d');
      }
      return runtime.context2d;
    }

    function normalizeAssetKey(value) {
      return sanitizeAssetSourcePath(value);
    }

    function indexManifestAssets(manifest, rootUrl) {
      currentManifest = manifest && typeof manifest === 'object' ? manifest : { assets: [] };
      currentRootUrl = typeof rootUrl === 'string' && rootUrl.length > 0
        ? rootUrl.replace(/\/$/, '')
        : '.';
      assetState.bySourcePath.clear();
      assetState.byOutputPath.clear();
      const entries = Array.isArray(currentManifest.assets) ? currentManifest.assets : [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const outputPath = normalizePath(entry.path);
        if (outputPath.length > 0) {
          assetState.byOutputPath.set(outputPath, entry);
        }
        const sourcePath = normalizeAssetKey(entry.sourcePath || outputPath);
        if (sourcePath.length > 0) {
          assetState.bySourcePath.set(sourcePath, entry);
        }
      }
    }

    function buildAssetUrl(entryPath) {
      const normalized = normalizePath(entryPath);
      const root = currentRootUrl && currentRootUrl.length > 0 ? currentRootUrl : '.';
      return root + '/' + normalized;
    }

    function resolveAssetEntry(source) {
      const normalizedSource = normalizeAssetKey(source);
      if (normalizedSource.length === 0) return null;
      if (assetState.bySourcePath.has(normalizedSource)) {
        return assetState.bySourcePath.get(normalizedSource);
      }
      const outputPath = normalizePath(normalizedSource);
      if (assetState.byOutputPath.has(outputPath)) {
        return assetState.byOutputPath.get(outputPath);
      }
      return null;
    }

    function resolveAssetSourcePath(source) {
      if (typeof source === 'string') {
        return normalizeAssetKey(source);
      }
      if (source && typeof source === 'object') {
        if (typeof source.sourcePath === 'string') return normalizeAssetKey(source.sourcePath);
        if (typeof source.path === 'string') return normalizeAssetKey(source.path);
        if (typeof source.name === 'string') return normalizeAssetKey(source.name);
      }
      return '';
    }

    function resolveLoadedAsset(source) {
      const key = resolveAssetSourcePath(source);
      if (key.length === 0) return null;
      return assetState.loaded.get(key) || null;
    }

    function rememberLoadedAsset(sourcePath, handle) {
      const key = normalizeAssetKey(sourcePath);
      if (key.length === 0 || !handle || typeof handle !== 'object') return handle;
      handle.sourcePath = key;
      if (typeof handle.path !== 'string' || handle.path.length === 0) {
        handle.path = key;
      }
      assetState.loaded.set(key, handle);
      return handle;
    }

    async function fetchAssetResponse(entry) {
      if (!entry || typeof entry !== 'object') return null;
      const assetUrl = buildAssetUrl(entry.path);
      let response;
      try {
        response = await fetch(assetUrl, { cache: 'force-cache' });
      } catch (_) {
        return null;
      }
      if (!response || response.ok !== true) {
        return null;
      }
      return response;
    }

    async function readAssetBytes(entry) {
      const response = await fetchAssetResponse(entry);
      if (!response || typeof response.arrayBuffer !== 'function') {
        return null;
      }
      try {
        return new Uint8Array(await response.arrayBuffer());
      } catch (_) {
        return null;
      }
    }

    async function readAssetText(entry) {
      const response = await fetchAssetResponse(entry);
      if (!response || typeof response.text !== 'function') {
        return null;
      }
      try {
        return await response.text();
      } catch (_) {
        return null;
      }
    }

    async function loadImageHandle(sourcePath, entry) {
      const existing = resolveLoadedAsset(sourcePath);
      if (existing && existing.image) {
        return existing;
      }
      const ImageCtor = typeof globalRef.Image === 'function' ? globalRef.Image : null;
      const handle = existing || {
        kind: 'image',
        path: sourcePath,
        sourcePath: sourcePath,
        resolvedPath: entry && typeof entry.path === 'string' ? normalizePath(entry.path) : sourcePath,
        mediaType: entry && typeof entry.mediaType === 'string' ? entry.mediaType : 'image/png',
        image: null,
        width: 0,
        height: 0
      };
      if (!ImageCtor || !entry) {
        return rememberLoadedAsset(sourcePath, handle);
      }
      try {
        const image = await new Promise(function (resolvePromise, rejectPromise) {
          const node = new ImageCtor();
          node.onload = function () { resolvePromise(node); };
          node.onerror = function () { rejectPromise(new Error('image_load_failed')); };
          node.src = buildAssetUrl(entry.path);
        });
        handle.image = image;
        handle.width = normalizeCanvasSize(image.naturalWidth || image.width, 1);
        handle.height = normalizeCanvasSize(image.naturalHeight || image.height, 1);
      } catch (_) {}
      return rememberLoadedAsset(sourcePath, handle);
    }

    async function loadAssetRecord(source) {
      if (Array.isArray(source)) {
        const loaded = [];
        for (const entry of source) {
          const next = await loadAssetRecord(entry);
          if (next) loaded.push(next);
        }
        return loaded;
      }
      const sourcePath = resolveAssetSourcePath(source);
      if (sourcePath.length === 0) return null;
      const existing = resolveLoadedAsset(sourcePath);
      if (existing) return existing;
      const entry = resolveAssetEntry(sourcePath);
      if (!entry) return null;
      if (isImageMediaType(entry.mediaType)) {
        return await loadImageHandle(sourcePath, entry);
      }
      const bytes = await readAssetBytes(entry);
      if (!bytes) {
        return rememberLoadedAsset(sourcePath, {
          kind: 'asset',
          path: sourcePath,
          sourcePath: sourcePath,
          resolvedPath: normalizePath(entry.path),
          mediaType: entry.mediaType,
          bytes: new Uint8Array()
        });
      }
      const handle = {
        kind: entry.mediaType && entry.mediaType.startsWith('audio/') ? 'sound' : 'asset',
        path: sourcePath,
        sourcePath: sourcePath,
        resolvedPath: normalizePath(entry.path),
        mediaType: entry.mediaType,
        bytes: bytes
      };
      if (entry.mediaType === 'application/json') {
        const text = typeof TextDecoder === 'function'
          ? new TextDecoder('utf-8').decode(bytes)
          : String.fromCharCode.apply(null, Array.from(bytes));
        handle.text = text;
        try {
          handle.json = JSON.parse(text);
        } catch (_) {
          handle.json = null;
        }
      } else if (typeof entry.mediaType === 'string' && entry.mediaType.startsWith('text/')) {
        handle.text = typeof TextDecoder === 'function'
          ? new TextDecoder('utf-8').decode(bytes)
          : String.fromCharCode.apply(null, Array.from(bytes));
      }
      return rememberLoadedAsset(sourcePath, handle);
    }

    function normalizeMousePosition(event) {
      const source = event && typeof event === 'object' ? event : {};
      if (Number.isFinite(Number(source.offsetX)) && Number.isFinite(Number(source.offsetY))) {
        return {
          x: Number(source.offsetX),
          y: Number(source.offsetY)
        };
      }
      const canvas = runtime.canvas;
      const rect = canvas && typeof canvas.getBoundingClientRect === 'function'
        ? canvas.getBoundingClientRect()
        : null;
      const clientX = toFinite(source.clientX, auraRef.input.mouse.x);
      const clientY = toFinite(source.clientY, auraRef.input.mouse.y);
      if (rect) {
        return {
          x: clientX - toFinite(rect.left, 0),
          y: clientY - toFinite(rect.top, 0)
        };
      }
      return {
        x: clientX,
        y: clientY
      };
    }

    function syncMousePosition(event) {
      const point = normalizeMousePosition(event);
      auraRef.input.mouse.x = point.x;
      auraRef.input.mouse.y = point.y;
    }

    function syncCanvasSize(notifyResize) {
      let width = runtime.configuredWidth;
      let height = runtime.configuredHeight;
      if (runtime.resizeMode === 'fit-container') {
        const containerWidth = runtime.mountTarget
          ? normalizeCanvasSize(runtime.mountTarget.clientWidth, 0)
          : 0;
        const containerHeight = runtime.mountTarget
          ? normalizeCanvasSize(runtime.mountTarget.clientHeight, 0)
          : 0;
        if (containerWidth > 0 && containerHeight > 0) {
          width = containerWidth;
          height = containerHeight;
        }
      }

      runtime.width = normalizeCanvasSize(width, runtime.configuredWidth);
      runtime.height = normalizeCanvasSize(height, runtime.configuredHeight);
      runtime.pixelRatio = Math.min(Math.max(normalizePositiveNumber(globalRef.devicePixelRatio, 1), 1), 2);

      auraRef.window.width = runtime.width;
      auraRef.window.height = runtime.height;
      auraRef.window.pixelRatio = runtime.pixelRatio;

      if (runtime.canvas) {
        runtime.canvas.width = Math.max(1, Math.round(runtime.width * runtime.pixelRatio));
        runtime.canvas.height = Math.max(1, Math.round(runtime.height * runtime.pixelRatio));
        runtime.canvas.tabIndex = 0;
        const style = ensureStyleObject(runtime.canvas);
        if (style) {
          style.width = runtime.width + 'px';
          style.height = runtime.height + 'px';
          style.display = 'block';
        }
      }

      if (notifyResize && typeof auraRef.onResize === 'function') {
        auraRef.onResize(runtime.width, runtime.height);
      }
    }

    function resetDrawState() {
      const ctx = ensureCanvasContext();
      if (!ctx) return;
      if (typeof ctx.setTransform === 'function') {
        ctx.setTransform(runtime.pixelRatio, 0, 0, runtime.pixelRatio, 0, 0);
      } else {
        if (typeof ctx.resetTransform === 'function') {
          ctx.resetTransform();
        }
        if (typeof ctx.scale === 'function') {
          ctx.scale(runtime.pixelRatio, runtime.pixelRatio);
        }
      }
      runtime.transformDepth = 0;
      runtime.worldTransformActive = false;
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }

    function applyWorldTransform() {
      const ctx = ensureCanvasContext();
      if (!ctx || runtime.worldTransformActive) return ctx;
      const camera = auraRef.camera && typeof auraRef.camera === 'object' ? auraRef.camera : null;
      if (camera) {
        const zoom = normalizePositiveNumber(camera.zoom, 1);
        const rotation = Number(camera.rotation) || 0;
        const x = Number(camera.x) || 0;
        const y = Number(camera.y) || 0;
        if (typeof ctx.scale === 'function' && zoom !== 1) {
          ctx.scale(zoom, zoom);
        }
        if (typeof ctx.rotate === 'function' && rotation !== 0) {
          ctx.rotate(rotation);
        }
        if (typeof ctx.translate === 'function' && (x !== 0 || y !== 0)) {
          ctx.translate(-x, -y);
        }
      }
      runtime.worldTransformActive = true;
      return ctx;
    }

    function ensureWorldTransform() {
      const ctx = ensureCanvasContext();
      if (!ctx) return null;
      return runtime.worldTransformActive ? ctx : applyWorldTransform();
    }

    function normalizeTextOptions(sizeOrOptions, colorMaybe) {
      if (sizeOrOptions && typeof sizeOrOptions === 'object' && !Array.isArray(sizeOrOptions)) {
        return sizeOrOptions;
      }
      if (Number.isFinite(Number(sizeOrOptions))) {
        return {
          size: Number(sizeOrOptions),
          color: colorMaybe
        };
      }
      return {};
    }

    function applyFont(options) {
      const ctx = ensureCanvasContext();
      const source = options && typeof options === 'object' ? options : {};
      const size = normalizePositiveNumber(source.size, 16);
      const family = typeof source.font === 'string' && source.font.trim().length > 0
        ? source.font.trim()
        : 'sans-serif';
      if (ctx) {
        ctx.font = size + 'px ' + family;
        ctx.textAlign = normalizeTextAlign(source.align);
        ctx.textBaseline = 'top';
      }
      return { size, align: normalizeTextAlign(source.align) };
    }

    function withScreenSpace(callback) {
      const ctx = ensureCanvasContext();
      if (!ctx || typeof callback !== 'function') return null;
      if (typeof ctx.save === 'function') {
        ctx.save();
      }
      if (typeof ctx.setTransform === 'function') {
        ctx.setTransform(runtime.pixelRatio, 0, 0, runtime.pixelRatio, 0, 0);
      } else {
        if (typeof ctx.resetTransform === 'function') {
          ctx.resetTransform();
        }
        if (typeof ctx.scale === 'function') {
          ctx.scale(runtime.pixelRatio, runtime.pixelRatio);
        }
      }
      try {
        return callback(ctx);
      } finally {
        if (typeof ctx.restore === 'function') {
          ctx.restore();
        }
      }
    }

    function resolveStorageBackend() {
      return globalRef.localStorage && typeof globalRef.localStorage.getItem === 'function'
        ? globalRef.localStorage
        : null;
    }

    function storageKey(key) {
      return 'aurajs:' + String(key || '');
    }

    function readStorage(key) {
      const normalizedKey = String(key || '');
      if (normalizedKey.length === 0) return null;
      const backend = resolveStorageBackend();
      const namespaced = storageKey(normalizedKey);
      let raw = null;
      if (backend) {
        try {
          raw = backend.getItem(namespaced);
        } catch (_) {
          raw = null;
        }
      } else if (assetState.storageFallback.has(namespaced)) {
        raw = assetState.storageFallback.get(namespaced);
      }
      if (raw == null) return null;
      try {
        return JSON.parse(raw);
      } catch (_) {
        return raw;
      }
    }

    function writeStorage(key, value) {
      const normalizedKey = String(key || '');
      if (normalizedKey.length === 0) return false;
      const payload = JSON.stringify(value);
      const backend = resolveStorageBackend();
      const namespaced = storageKey(normalizedKey);
      if (backend) {
        try {
          backend.setItem(namespaced, payload);
          return true;
        } catch (_) {
          return false;
        }
      }
      assetState.storageFallback.set(namespaced, payload);
      return true;
    }

    function deleteStorage(key) {
      const normalizedKey = String(key || '');
      if (normalizedKey.length === 0) return false;
      const namespaced = storageKey(normalizedKey);
      const backend = resolveStorageBackend();
      if (backend) {
        try {
          backend.removeItem(namespaced);
          return true;
        } catch (_) {
          return false;
        }
      }
      return assetState.storageFallback.delete(namespaced);
    }

    const camera = auraRef.camera && typeof auraRef.camera === 'object' ? auraRef.camera : {};
    let cameraBaseX = Number(camera.x) || 0;
    let cameraBaseY = Number(camera.y) || 0;
    let cameraBaseZoom = normalizePositiveNumber(camera.zoom, 1);
    let cameraBaseRotation = Number(camera.rotation) || 0;
    let cameraShakeX = 0;
    let cameraShakeY = 0;
    let cameraFollowState = null;
    let cameraDeadzone = null;
    let cameraBounds = null;
    let nextCameraEffectId = 1;
    let nextCameraListenerId = 1;
    const cameraEffects = [];
    const cameraEffectListeners = [];

    function applyCameraBounds() {
      if (!cameraBounds) return;
      const maxX = cameraBounds.x + cameraBounds.width;
      const maxY = cameraBounds.y + cameraBounds.height;
      cameraBaseX = Math.max(cameraBounds.x, Math.min(cameraBaseX, maxX));
      cameraBaseY = Math.max(cameraBounds.y, Math.min(cameraBaseY, maxY));
    }

    function normalizeFollowOptions(options) {
      if (options == null) {
        return {
          lerpX: 1,
          lerpY: 1,
          offsetX: 0,
          offsetY: 0
        };
      }
      if (!isObject(options)) return null;
      return {
        lerpX: clamp01(options.lerpX),
        lerpY: clamp01(options.lerpY),
        offsetX: toFinite(options.offsetX, 0),
        offsetY: toFinite(options.offsetY, 0)
      };
    }

    function normalizeDeadzone(value) {
      const input = isObject(value) ? value : null;
      const zoneWidth = toFinite(input && input.width, Number.NaN);
      const zoneHeight = toFinite(input && input.height, Number.NaN);
      if (!(zoneWidth > 0) || !(zoneHeight > 0)) return null;
      return {
        x: toFinite(input && input.x, 0),
        y: toFinite(input && input.y, 0),
        width: zoneWidth,
        height: zoneHeight
      };
    }

    function normalizeBounds(value) {
      const input = isObject(value) ? value : null;
      const zoneWidth = toFinite(input && input.width, Number.NaN);
      const zoneHeight = toFinite(input && input.height, Number.NaN);
      if (!(zoneWidth >= 0) || !(zoneHeight >= 0)) return null;
      return {
        x: toFinite(input && input.x, 0),
        y: toFinite(input && input.y, 0),
        width: zoneWidth,
        height: zoneHeight
      };
    }

    function resolveFollowTarget(target) {
      let source = target;
      if (typeof source === 'function') {
        try {
          source = source();
        } catch (_) {
          return null;
        }
      }
      if (!isObject(source)) return null;
      const x = toFinite(source.x, Number.NaN);
      const y = toFinite(source.y, Number.NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x: x, y: y };
    }

    function emitCameraEffectEvent(event) {
      if (cameraEffectListeners.length === 0) return;
      const ordered = cameraEffectListeners.slice().sort(function (a, b) {
        return (a.order - b.order) || (a.id - b.id);
      });
      for (const listener of ordered) {
        try {
          listener.callback(event);
        } catch (_) {}
      }
    }

    Object.defineProperties(camera, {
      x: {
        enumerable: true,
        configurable: false,
        get: function () { return cameraBaseX + cameraShakeX; },
        set: function (value) {
          const numeric = Number(value);
          if (Number.isFinite(numeric)) cameraBaseX = numeric;
        }
      },
      y: {
        enumerable: true,
        configurable: false,
        get: function () { return cameraBaseY + cameraShakeY; },
        set: function (value) {
          const numeric = Number(value);
          if (Number.isFinite(numeric)) cameraBaseY = numeric;
        }
      },
      zoom: {
        enumerable: true,
        configurable: false,
        get: function () { return cameraBaseZoom; },
        set: function (value) {
          const numeric = Number(value);
          if (Number.isFinite(numeric) && numeric > 0) cameraBaseZoom = numeric;
        }
      },
      rotation: {
        enumerable: true,
        configurable: false,
        get: function () { return cameraBaseRotation; },
        set: function (value) {
          const numeric = Number(value);
          if (Number.isFinite(numeric)) cameraBaseRotation = numeric;
        }
      }
    });

    camera.getState = function () {
      return {
        x: cameraBaseX + cameraShakeX,
        y: cameraBaseY + cameraShakeY,
        zoom: cameraBaseZoom,
        rotation: cameraBaseRotation,
        following: !!cameraFollowState,
        activeEffects: cameraEffects.length,
        deadzone: cameraDeadzone ? { x: cameraDeadzone.x, y: cameraDeadzone.y, width: cameraDeadzone.width, height: cameraDeadzone.height } : null,
        bounds: cameraBounds ? { x: cameraBounds.x, y: cameraBounds.y, width: cameraBounds.width, height: cameraBounds.height } : null
      };
    };

    camera.follow = function (target, options) {
      if (!(typeof target === 'function' || isObject(target))) {
        return { ok: false, reasonCode: 'invalid_follow_target' };
      }
      const normalized = normalizeFollowOptions(options);
      if (!normalized) return { ok: false, reasonCode: 'invalid_follow_options' };
      cameraFollowState = {
        target: target,
        lerpX: normalized.lerpX,
        lerpY: normalized.lerpY,
        offsetX: normalized.offsetX,
        offsetY: normalized.offsetY
      };
      return { ok: true, reasonCode: 'camera_follow_started' };
    };

    camera.stopFollow = function () {
      const stopped = !!cameraFollowState;
      cameraFollowState = null;
      return { ok: true, stopped: stopped, reasonCode: 'camera_follow_stopped' };
    };

    camera.setDeadzone = function (value, maybeHeight) {
      const normalized = isObject(value)
        ? normalizeDeadzone(value)
        : normalizeDeadzone({ width: value, height: maybeHeight });
      if (!normalized) return { ok: false, reasonCode: 'invalid_deadzone' };
      cameraDeadzone = normalized;
      return { ok: true, reasonCode: 'camera_deadzone_set' };
    };

    camera.clearDeadzone = function () {
      cameraDeadzone = null;
      return { ok: true, reasonCode: 'camera_deadzone_cleared' };
    };

    camera.setBounds = function (xOrBounds, y, boundsWidth, boundsHeight) {
      const normalized = isObject(xOrBounds)
        ? normalizeBounds(xOrBounds)
        : normalizeBounds({ x: xOrBounds, y: y, width: boundsWidth, height: boundsHeight });
      if (!normalized) return { ok: false, reasonCode: 'invalid_bounds' };
      cameraBounds = normalized;
      applyCameraBounds();
      return { ok: true, reasonCode: 'camera_bounds_set' };
    };

    camera.clearBounds = function () {
      cameraBounds = null;
      return { ok: true, reasonCode: 'camera_bounds_cleared' };
    };

    camera.pan = function (x, y, options) {
      const targetX = Number(x);
      const targetY = Number(y);
      if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
        return { ok: false, reasonCode: 'invalid_pan_target' };
      }
      if (options != null && !isObject(options)) return { ok: false, reasonCode: 'invalid_pan_options' };
      const duration = toPositive(options && options.duration, 0.25);
      if (!(duration > 0)) return { ok: false, reasonCode: 'invalid_pan_duration' };
      const effectId = nextCameraEffectId++;
      cameraEffects.push({
        id: effectId,
        type: 'pan',
        duration: duration,
        elapsed: 0,
        startX: cameraBaseX,
        startY: cameraBaseY,
        targetX: targetX,
        targetY: targetY
      });
      return { ok: true, effectId: effectId, reasonCode: 'camera_pan_started' };
    };
    camera.panTo = camera.pan;

    camera.zoomTo = function (value, options) {
      const targetZoom = Number(value);
      if (!Number.isFinite(targetZoom) || !(targetZoom > 0)) {
        return { ok: false, reasonCode: 'invalid_zoom_target' };
      }
      if (options != null && !isObject(options)) return { ok: false, reasonCode: 'invalid_zoom_options' };
      const duration = toPositive(options && options.duration, 0.25);
      if (!(duration > 0)) return { ok: false, reasonCode: 'invalid_zoom_duration' };
      const effectId = nextCameraEffectId++;
      cameraEffects.push({
        id: effectId,
        type: 'zoom',
        duration: duration,
        elapsed: 0,
        startZoom: cameraBaseZoom,
        targetZoom: targetZoom
      });
      return { ok: true, effectId: effectId, reasonCode: 'camera_zoom_started' };
    };

    camera.rotateTo = function (value, options) {
      const targetRotation = Number(value);
      if (!Number.isFinite(targetRotation)) {
        return { ok: false, reasonCode: 'invalid_rotation_target' };
      }
      if (options != null && !isObject(options)) return { ok: false, reasonCode: 'invalid_rotation_options' };
      const duration = toPositive(options && options.duration, 0.25);
      if (!(duration > 0)) return { ok: false, reasonCode: 'invalid_rotation_duration' };
      const effectId = nextCameraEffectId++;
      cameraEffects.push({
        id: effectId,
        type: 'rotate',
        duration: duration,
        elapsed: 0,
        startRotation: cameraBaseRotation,
        targetRotation: targetRotation
      });
      return { ok: true, effectId: effectId, reasonCode: 'camera_rotation_started' };
    };

    camera.shake = function (options) {
      const source = options == null ? {} : options;
      if (!isObject(source)) return { ok: false, reasonCode: 'invalid_shake_options' };
      const sharedIntensity = Number.isFinite(Number(source.intensity))
        ? Number(source.intensity)
        : null;
      const intensityX = toFinite(source.intensityX, sharedIntensity != null ? sharedIntensity : 6);
      const intensityY = toFinite(source.intensityY, sharedIntensity != null ? sharedIntensity : 6);
      if (!(intensityX >= 0) || !(intensityY >= 0)) {
        return { ok: false, reasonCode: 'invalid_shake_intensity' };
      }
      const duration = toPositive(source.duration, 0.3);
      if (!(duration > 0)) return { ok: false, reasonCode: 'invalid_shake_duration' };
      const frequency = toPositive(source.frequency, 30);
      if (!(frequency > 0)) return { ok: false, reasonCode: 'invalid_shake_frequency' };
      const effectId = nextCameraEffectId++;
      cameraEffects.push({
        id: effectId,
        type: 'shake',
        duration: duration,
        elapsed: 0,
        intensityX: intensityX,
        intensityY: intensityY,
        frequency: frequency,
        seed: effectId * 0.61803398875
      });
      return { ok: true, effectId: effectId, reasonCode: 'camera_shake_started' };
    };

    camera.clearEffects = function () {
      const cleared = cameraEffects.length;
      cameraEffects.length = 0;
      cameraShakeX = 0;
      cameraShakeY = 0;
      return { ok: true, cleared: cleared, reasonCode: 'camera_effects_cleared' };
    };

    camera.onEffectComplete = function (callback, order) {
      if (typeof callback !== 'function') {
        return { ok: false, reasonCode: 'invalid_effect_callback' };
      }
      const listener = {
        id: nextCameraListenerId++,
        callback: callback,
        order: Number.isFinite(Number(order)) ? Number(order) : 0
      };
      cameraEffectListeners.push(listener);
      return { ok: true, listenerId: listener.id, reasonCode: 'camera_effect_listener_registered' };
    };

    camera.offEffectComplete = function (listenerId) {
      if (!Number.isInteger(listenerId) || listenerId <= 0) return false;
      const index = cameraEffectListeners.findIndex(function (entry) {
        return entry.id === listenerId;
      });
      if (index < 0) return false;
      cameraEffectListeners.splice(index, 1);
      return true;
    };

    camera.update = function (dt) {
      const delta = Number(dt);
      if (!Number.isFinite(delta) || !(delta > 0)) {
        return { ok: false, reasonCode: 'invalid_dt' };
      }

      cameraShakeX = 0;
      cameraShakeY = 0;

      if (cameraFollowState) {
        const targetPoint = resolveFollowTarget(cameraFollowState.target);
        if (targetPoint) {
          let targetX = targetPoint.x + cameraFollowState.offsetX;
          let targetY = targetPoint.y + cameraFollowState.offsetY;

          if (cameraDeadzone) {
            const left = cameraBaseX + cameraDeadzone.x;
            const right = left + cameraDeadzone.width;
            const top = cameraBaseY + cameraDeadzone.y;
            const bottom = top + cameraDeadzone.height;

            if (targetX < left) targetX = targetX - cameraDeadzone.x;
            else if (targetX > right) targetX = targetX - cameraDeadzone.x - cameraDeadzone.width;
            else targetX = cameraBaseX;

            if (targetY < top) targetY = targetY - cameraDeadzone.y;
            else if (targetY > bottom) targetY = targetY - cameraDeadzone.y - cameraDeadzone.height;
            else targetY = cameraBaseY;
          }

          cameraBaseX += (targetX - cameraBaseX) * cameraFollowState.lerpX;
          cameraBaseY += (targetY - cameraBaseY) * cameraFollowState.lerpY;
        }
      }

      const completedEffects = [];
      for (const effect of cameraEffects) {
        effect.elapsed += delta;
        const progress = effect.duration <= 0 ? 1 : Math.min(effect.elapsed / effect.duration, 1);
        if (effect.type === 'pan') {
          cameraBaseX = effect.startX + ((effect.targetX - effect.startX) * progress);
          cameraBaseY = effect.startY + ((effect.targetY - effect.startY) * progress);
        } else if (effect.type === 'zoom') {
          cameraBaseZoom = effect.startZoom + ((effect.targetZoom - effect.startZoom) * progress);
        } else if (effect.type === 'rotate') {
          cameraBaseRotation = effect.startRotation + ((effect.targetRotation - effect.startRotation) * progress);
        } else if (effect.type === 'shake') {
          const amplitude = 1 - progress;
          const angle = (effect.seed + (effect.elapsed * effect.frequency)) * 6.283185307179586;
          cameraShakeX += Math.sin(angle) * effect.intensityX * amplitude;
          cameraShakeY += Math.cos(angle * 1.17) * effect.intensityY * amplitude;
        }
        if (progress >= 1) completedEffects.push(effect);
      }

      if (completedEffects.length > 0) {
        for (const completed of completedEffects) {
          const index = cameraEffects.indexOf(completed);
          if (index >= 0) cameraEffects.splice(index, 1);
        }
        completedEffects.sort(function (a, b) { return a.id - b.id; });
        for (const completed of completedEffects) {
          emitCameraEffectEvent({
            type: 'effect_complete',
            effectType: completed.type,
            effectId: completed.id,
            reasonCode: 'camera_effect_complete'
          });
        }
      }

      applyCameraBounds();

      return {
        ok: true,
        reasonCode: 'camera_updated',
        x: cameraBaseX + cameraShakeX,
        y: cameraBaseY + cameraShakeY,
        zoom: cameraBaseZoom,
        rotation: cameraBaseRotation,
        following: !!cameraFollowState,
        activeEffects: cameraEffects.length
      };
    };

    function attachListeners() {
      if (runtime.listenersAttached) return;
      runtime.listenersAttached = true;

      runtime.keydownListener = function (event) {
        const key = normalizeKeyName(event && (event.key || event.code));
        if (!key) return;
        if (!inputState.down.has(key)) {
          inputState.pendingPressed.add(key);
        }
        inputState.down.add(key);
        if (event && typeof event.preventDefault === 'function' && (key === 'space' || key.startsWith('arrow'))) {
          event.preventDefault();
        }
      };

      runtime.keyupListener = function (event) {
        const key = normalizeKeyName(event && (event.key || event.code));
        if (!key) return;
        inputState.down.delete(key);
        inputState.pendingReleased.add(key);
        if (event && typeof event.preventDefault === 'function' && (key === 'space' || key.startsWith('arrow'))) {
          event.preventDefault();
        }
      };

      runtime.mousemoveListener = function (event) {
        syncMousePosition(event);
      };

      runtime.mousedownListener = function (event) {
        syncMousePosition(event);
        const button = normalizeMouseButton(event && event.button);
        if (!inputState.mouseDown.has(button)) {
          inputState.pendingMousePressed.add(button);
        }
        inputState.mouseDown.add(button);
      };

      runtime.mouseupListener = function (event) {
        syncMousePosition(event);
        const button = normalizeMouseButton(event && event.button);
        inputState.mouseDown.delete(button);
        inputState.pendingMouseReleased.add(button);
      };

      runtime.wheelListener = function (event) {
        if (event && Number.isFinite(Number(event.deltaY))) {
          auraRef.input.mouse.scroll += Number(event.deltaY);
        }
      };

      runtime.blurListener = function () {
        inputState.down.clear();
        inputState.pendingPressed.clear();
        inputState.pendingReleased.clear();
        inputState.framePressed.clear();
        inputState.frameReleased.clear();
        inputState.mouseDown.clear();
        inputState.pendingMousePressed.clear();
        inputState.pendingMouseReleased.clear();
        inputState.frameMousePressed.clear();
        inputState.frameMouseReleased.clear();
        if (typeof auraRef.onBlur === 'function') {
          auraRef.onBlur();
        }
      };

      runtime.resizeListener = function () {
        syncCanvasSize(true);
      };

      if (typeof globalRef.addEventListener === 'function') {
        globalRef.addEventListener('keydown', runtime.keydownListener);
        globalRef.addEventListener('keyup', runtime.keyupListener);
        globalRef.addEventListener('mousemove', runtime.mousemoveListener);
        globalRef.addEventListener('mousedown', runtime.mousedownListener);
        globalRef.addEventListener('mouseup', runtime.mouseupListener);
        globalRef.addEventListener('wheel', runtime.wheelListener);
        globalRef.addEventListener('blur', runtime.blurListener);
        globalRef.addEventListener('resize', runtime.resizeListener);
      }
    }

    function detachListeners() {
      if (!runtime.listenersAttached) return;
      runtime.listenersAttached = false;
      if (typeof globalRef.removeEventListener === 'function') {
        globalRef.removeEventListener('keydown', runtime.keydownListener);
        globalRef.removeEventListener('keyup', runtime.keyupListener);
        globalRef.removeEventListener('mousemove', runtime.mousemoveListener);
        globalRef.removeEventListener('mousedown', runtime.mousedownListener);
        globalRef.removeEventListener('mouseup', runtime.mouseupListener);
        globalRef.removeEventListener('wheel', runtime.wheelListener);
        globalRef.removeEventListener('blur', runtime.blurListener);
        globalRef.removeEventListener('resize', runtime.resizeListener);
      }
    }

    auraRef.setup = typeof auraRef.setup === 'function' ? auraRef.setup : null;
    auraRef.update = typeof auraRef.update === 'function' ? auraRef.update : null;
    auraRef.draw = typeof auraRef.draw === 'function' ? auraRef.draw : null;
    auraRef.onResize = typeof auraRef.onResize === 'function' ? auraRef.onResize : null;
    auraRef.onFocus = typeof auraRef.onFocus === 'function' ? auraRef.onFocus : null;
    auraRef.onBlur = typeof auraRef.onBlur === 'function' ? auraRef.onBlur : null;
    auraRef.onQuit = typeof auraRef.onQuit === 'function' ? auraRef.onQuit : null;

    auraRef.rgba = function (r, g, b, a) {
      return createUnitColor(r, g, b, a == null ? 1 : a);
    };
    auraRef.rgb = function (r, g, b) {
      return createUnitColor(r, g, b, 1);
    };
    auraRef.color = auraRef.rgba;
    auraRef.Color = auraRef.Color && typeof auraRef.Color === 'object'
      ? auraRef.Color
      : {
        WHITE: createUnitColor(1, 1, 1, 1),
        BLACK: createUnitColor(0, 0, 0, 1),
        RED: createUnitColor(1, 0, 0, 1),
        YELLOW: createUnitColor(1, 1, 0, 1),
        TRANSPARENT: createUnitColor(0, 0, 0, 0)
      };
    auraRef.colors = auraRef.colors && typeof auraRef.colors === 'object'
      ? auraRef.colors
      : {
        white: createByteColor(255, 255, 255, 255),
        black: createByteColor(0, 0, 0, 255),
        red: createByteColor(255, 0, 0, 255),
        yellow: createByteColor(255, 255, 0, 255),
        transparent: createByteColor(0, 0, 0, 0)
      };

    auraRef.math = auraRef.math && typeof auraRef.math === 'object' ? auraRef.math : {};
    auraRef.math.clamp = typeof auraRef.math.clamp === 'function'
      ? auraRef.math.clamp
      : function (value, min, max) {
        const numeric = Number(value);
        const minValue = Number(min);
        const maxValue = Number(max);
        if (!Number.isFinite(numeric) || !Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
          return Number.isFinite(numeric) ? numeric : 0;
        }
        return Math.min(maxValue, Math.max(minValue, numeric));
      };

    auraRef.window = auraRef.window && typeof auraRef.window === 'object' ? auraRef.window : {};
    auraRef.window.width = runtime.width;
    auraRef.window.height = runtime.height;
    auraRef.window.pixelRatio = runtime.pixelRatio;
    auraRef.window.fps = 60;
    auraRef.window.setTitle = function (title) {
      if (typeof title === 'string') {
        document.title = title;
      }
    };
    auraRef.window.setSize = function (width, height) {
      runtime.configuredWidth = normalizeCanvasSize(width, runtime.configuredWidth);
      runtime.configuredHeight = normalizeCanvasSize(height, runtime.configuredHeight);
      syncCanvasSize(true);
      resetDrawState();
      return true;
    };
    auraRef.window.setFullscreen = function () {
      return false;
    };
    auraRef.window.getSize = function () {
      return { width: runtime.width, height: runtime.height };
    };
    auraRef.window.getPixelRatio = function () {
      return runtime.pixelRatio;
    };
    auraRef.window.getFPS = function () {
      return auraRef.window.fps;
    };
    auraRef.window.close = function () {
      return true;
    };

    auraRef.collision = auraRef.collision && typeof auraRef.collision === 'object' ? auraRef.collision : {};
    auraRef.collision.rectRect = function (a, b) {
      return rectIntersects(a, b);
    };
    auraRef.collide = auraRef.collide && typeof auraRef.collide === 'object' ? auraRef.collide : auraRef.collision;
    auraRef.collide.rectRect = auraRef.collision.rectRect;

    auraRef.camera = camera;

    auraRef.input = auraRef.input && typeof auraRef.input === 'object' ? auraRef.input : {};
    auraRef.input.isDown = function (name) {
      const key = normalizeKeyName(name);
      return key ? inputState.down.has(key) : false;
    };
    auraRef.input.isPressed = function (name) {
      const key = normalizeKeyName(name);
      return key ? inputState.framePressed.has(key) : false;
    };
    auraRef.input.isReleased = function (name) {
      const key = normalizeKeyName(name);
      return key ? inputState.frameReleased.has(key) : false;
    };
    auraRef.input.isKeyDown = function (name) {
      return auraRef.input.isDown(name);
    };
    auraRef.input.isKeyPressed = function (name) {
      return auraRef.input.isPressed(name);
    };
    auraRef.input.isKeyReleased = function (name) {
      return auraRef.input.isReleased(name);
    };
    auraRef.input.isGamepadConnected = typeof auraRef.input.isGamepadConnected === 'function'
      ? auraRef.input.isGamepadConnected
      : function () { return false; };
    auraRef.input.mouse = auraRef.input.mouse && typeof auraRef.input.mouse === 'object' ? auraRef.input.mouse : {};
    auraRef.input.mouse.x = Number(auraRef.input.mouse.x) || 0;
    auraRef.input.mouse.y = Number(auraRef.input.mouse.y) || 0;
    auraRef.input.mouse.scroll = Number(auraRef.input.mouse.scroll) || 0;
    auraRef.input.mouse.isDown = function (button) {
      return inputState.mouseDown.has(normalizeMouseButton(button));
    };
    auraRef.input.mouse.isPressed = function (button) {
      return inputState.frameMousePressed.has(normalizeMouseButton(button));
    };
    auraRef.input.mouse.isReleased = function (button) {
      return inputState.frameMouseReleased.has(normalizeMouseButton(button));
    };
    auraRef.input.isMouseDown = function (button) {
      return auraRef.input.mouse.isDown(button);
    };
    auraRef.input.isMousePressed = function (button) {
      return auraRef.input.mouse.isPressed(button);
    };
    auraRef.input.isMouseReleased = function (button) {
      return auraRef.input.mouse.isReleased(button);
    };
    auraRef.input.getMousePosition = function () {
      return { x: auraRef.input.mouse.x, y: auraRef.input.mouse.y };
    };

    auraRef.storage = auraRef.storage && typeof auraRef.storage === 'object' ? auraRef.storage : {};
    auraRef.storage.save = typeof auraRef.storage.save === 'function'
      ? auraRef.storage.save
      : function (key, value) { return writeStorage(key, value); };
    auraRef.storage.load = typeof auraRef.storage.load === 'function'
      ? auraRef.storage.load
      : function (key) { return readStorage(key); };
    auraRef.storage.delete = typeof auraRef.storage.delete === 'function'
      ? auraRef.storage.delete
      : function (key) { return deleteStorage(key); };
    auraRef.storage.keys = typeof auraRef.storage.keys === 'function'
      ? auraRef.storage.keys
      : function () {
        const prefix = 'aurajs:';
        const backend = resolveStorageBackend();
        const keys = [];
        if (backend && Number.isInteger(backend.length) && typeof backend.key === 'function') {
          for (let index = 0; index < backend.length; index += 1) {
            const nextKey = backend.key(index);
            if (typeof nextKey === 'string' && nextKey.startsWith(prefix)) {
              keys.push(nextKey.slice(prefix.length));
            }
          }
          keys.sort(function (a, b) { return a.localeCompare(b); });
          return keys;
        }
        for (const key of assetState.storageFallback.keys()) {
          if (key.startsWith(prefix)) {
            keys.push(key.slice(prefix.length));
          }
        }
        keys.sort(function (a, b) { return a.localeCompare(b); });
        return keys;
      };
    auraRef.storage.set = typeof auraRef.storage.set === 'function'
      ? auraRef.storage.set
      : function (key, value) { return writeStorage(key, value); };
    auraRef.storage.get = typeof auraRef.storage.get === 'function'
      ? auraRef.storage.get
      : function (key, fallback) {
        const value = readStorage(key);
        return value == null ? fallback : value;
      };

    auraRef.assets = auraRef.assets && typeof auraRef.assets === 'object' ? auraRef.assets : {};
    auraRef.assets.load = typeof auraRef.assets.load === 'function'
      ? auraRef.assets.load
      : async function (source) {
        return await loadAssetRecord(source);
      };
    auraRef.assets.exists = typeof auraRef.assets.exists === 'function'
      ? auraRef.assets.exists
      : function (name) {
        return !!resolveAssetEntry(name);
      };
    auraRef.assets.image = typeof auraRef.assets.image === 'function'
      ? auraRef.assets.image
      : function (name) {
        const sourcePath = resolveAssetSourcePath(name);
        const loaded = resolveLoadedAsset(sourcePath);
        if (loaded) return loaded;
        const entry = resolveAssetEntry(sourcePath);
        return rememberLoadedAsset(sourcePath, {
          kind: 'image',
          path: sourcePath,
          sourcePath: sourcePath,
          resolvedPath: entry && typeof entry.path === 'string' ? normalizePath(entry.path) : sourcePath,
          mediaType: entry && typeof entry.mediaType === 'string' ? entry.mediaType : 'image/png',
          image: null,
          width: 0,
          height: 0
        });
      };
    auraRef.assets.sound = typeof auraRef.assets.sound === 'function'
      ? auraRef.assets.sound
      : function (name) {
        const sourcePath = resolveAssetSourcePath(name);
        const loaded = resolveLoadedAsset(sourcePath);
        if (loaded) return loaded;
        const entry = resolveAssetEntry(sourcePath);
        return rememberLoadedAsset(sourcePath, {
          kind: 'sound',
          path: sourcePath,
          sourcePath: sourcePath,
          resolvedPath: entry && typeof entry.path === 'string' ? normalizePath(entry.path) : sourcePath,
          mediaType: entry && typeof entry.mediaType === 'string' ? entry.mediaType : 'audio/ogg'
        });
      };
    auraRef.assets.text = typeof auraRef.assets.text === 'function'
      ? auraRef.assets.text
      : function (name) {
        const loaded = resolveLoadedAsset(name);
        return loaded && typeof loaded.text === 'string' ? loaded.text : '';
      };
    auraRef.assets.json = typeof auraRef.assets.json === 'function'
      ? auraRef.assets.json
      : function (name) {
        const loaded = resolveLoadedAsset(name);
        return loaded && loaded.json && typeof loaded.json === 'object' ? loaded.json : {};
      };
    auraRef.assets.bytes = typeof auraRef.assets.bytes === 'function'
      ? auraRef.assets.bytes
      : function (name) {
        const loaded = resolveLoadedAsset(name);
        return loaded && loaded.bytes instanceof Uint8Array ? loaded.bytes : new Uint8Array();
      };
    auraRef.assets.loadText = typeof auraRef.assets.loadText === 'function'
      ? auraRef.assets.loadText
      : async function (name) {
        const loaded = await loadAssetRecord(name);
        return loaded && typeof loaded.text === 'string' ? loaded.text : '';
      };
    auraRef.assets.loadJson = typeof auraRef.assets.loadJson === 'function'
      ? auraRef.assets.loadJson
      : async function (name) {
        const loaded = await loadAssetRecord(name);
        return loaded && loaded.json && typeof loaded.json === 'object' ? loaded.json : null;
      };

    function drawResolvedImage(source, x, y, options, useSpriteFrame) {
      const ctx = ensureWorldTransform();
      if (!ctx || typeof ctx.drawImage !== 'function') return false;
      const handle = source && typeof source === 'object' && source.image
        ? source
        : auraRef.assets.image(source);
      if (!handle || !handle.image) return false;
      const opts = options && typeof options === 'object' ? { ...options } : {};
      const width = normalizePositiveNumber(opts.width, handle.width || handle.image.naturalWidth || handle.image.width || 1);
      const height = normalizePositiveNumber(opts.height, handle.height || handle.image.naturalHeight || handle.image.height || 1);
      const alpha = Number.isFinite(Number(opts.alpha)) ? Math.max(0, Math.min(1, Number(opts.alpha))) : 1;
      const frameX = useSpriteFrame ? Math.max(0, Number(opts.frameX) || 0) : 0;
      const frameY = useSpriteFrame ? Math.max(0, Number(opts.frameY) || 0) : 0;
      const frameW = useSpriteFrame
        ? normalizePositiveNumber(opts.frameW, handle.image.naturalWidth || handle.image.width || width)
        : (handle.image.naturalWidth || handle.image.width || width);
      const frameH = useSpriteFrame
        ? normalizePositiveNumber(opts.frameH, handle.image.naturalHeight || handle.image.height || height)
        : (handle.image.naturalHeight || handle.image.height || height);
      const drawX = Number(x) || 0;
      const drawY = Number(y) || 0;
      const flipX = opts.flipX === true;
      const flipY = opts.flipY === true;
      if (typeof ctx.save === 'function') ctx.save();
      ctx.globalAlpha = alpha;
      if (flipX || flipY) {
        if (typeof ctx.translate === 'function') {
          ctx.translate(drawX + (flipX ? width : 0), drawY + (flipY ? height : 0));
        }
        if (typeof ctx.scale === 'function') {
          ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
        }
        ctx.drawImage(handle.image, frameX, frameY, frameW, frameH, 0, 0, width, height);
      } else {
        ctx.drawImage(handle.image, frameX, frameY, frameW, frameH, drawX, drawY, width, height);
      }
      if (typeof ctx.restore === 'function') ctx.restore();
      return true;
    }

    auraRef.draw2d = auraRef.draw2d && typeof auraRef.draw2d === 'object' ? auraRef.draw2d : {};
    auraRef.draw2d.clear = function (colorOrR, g, b, a) {
      const ctx = ensureCanvasContext();
      if (!ctx) return;
      const fillColor = arguments.length > 1
        ? createUnitColor(colorOrR, g, b, a == null ? 1 : a)
        : normalizeColor(colorOrR, createUnitColor(0, 0, 0, 1));
      resetDrawState();
      ctx.clearRect(0, 0, runtime.width, runtime.height);
      ctx.fillStyle = colorToCss(fillColor, createUnitColor(0, 0, 0, 1));
      ctx.fillRect(0, 0, runtime.width, runtime.height);
      applyWorldTransform();
    };
    auraRef.draw2d.rect = function (x, y, w, h, color) {
      const ctx = ensureWorldTransform();
      if (!ctx) return;
      ctx.strokeStyle = colorToCss(color, defaultColor);
      ctx.lineWidth = 1;
      ctx.strokeRect(Number(x) || 0, Number(y) || 0, Number(w) || 0, Number(h) || 0);
    };
    auraRef.draw2d.rectOutline = auraRef.draw2d.rect;
    auraRef.draw2d.rectFill = function (x, y, w, h, color) {
      const ctx = ensureWorldTransform();
      if (!ctx) return;
      ctx.fillStyle = colorToCss(color, defaultColor);
      ctx.fillRect(Number(x) || 0, Number(y) || 0, Number(w) || 0, Number(h) || 0);
    };
    auraRef.draw2d.circle = function (x, y, radius, color) {
      const ctx = ensureWorldTransform();
      if (!ctx) return;
      ctx.beginPath();
      ctx.arc(Number(x) || 0, Number(y) || 0, Math.max(0, Number(radius) || 0), 0, Math.PI * 2);
      ctx.strokeStyle = colorToCss(color, defaultColor);
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    auraRef.draw2d.circleFill = function (x, y, radius, color) {
      const ctx = ensureWorldTransform();
      if (!ctx) return;
      ctx.beginPath();
      ctx.arc(Number(x) || 0, Number(y) || 0, Math.max(0, Number(radius) || 0), 0, Math.PI * 2);
      ctx.fillStyle = colorToCss(color, defaultColor);
      ctx.fill();
    };
    auraRef.draw2d.line = function (x1, y1, x2, y2, color, width) {
      const ctx = ensureWorldTransform();
      if (!ctx) return;
      ctx.beginPath();
      ctx.moveTo(Number(x1) || 0, Number(y1) || 0);
      ctx.lineTo(Number(x2) || 0, Number(y2) || 0);
      ctx.strokeStyle = colorToCss(color, defaultColor);
      ctx.lineWidth = normalizePositiveNumber(width, 1);
      ctx.stroke();
    };
    auraRef.draw2d.text = function (text, x, y, sizeOrOptions, colorMaybe) {
      const options = normalizeTextOptions(sizeOrOptions, colorMaybe);
      return withScreenSpace(function (ctx) {
        const config = applyFont(options);
        const source = options && typeof options === 'object' ? options : {};
        ctx.fillStyle = colorToCss(source.color, defaultColor);
        ctx.textAlign = config.align;
        ctx.textBaseline = 'top';
        ctx.fillText(String(text == null ? '' : text), Number(x) || 0, Number(y) || 0);
        return true;
      });
    };
    auraRef.draw2d.measureText = function (text, sizeOrOptions, colorMaybe) {
      const options = normalizeTextOptions(sizeOrOptions, colorMaybe);
      const source = options && typeof options === 'object' ? options : {};
      const size = normalizePositiveNumber(source.size, 16);
      const ctx = ensureCanvasContext();
      if (!ctx) {
        const fallbackWidth = String(text == null ? '' : text).length * size * 0.6;
        return { width: Number(fallbackWidth.toFixed(3)), height: size };
      }
      const measuredWidth = withScreenSpace(function () {
        applyFont(options);
        const metrics = ctx.measureText(String(text == null ? '' : text));
        return Number.isFinite(metrics && metrics.width)
          ? metrics.width
          : String(text == null ? '' : text).length * size * 0.6;
      });
      return { width: Number(Number(measuredWidth || 0).toFixed(3)), height: size };
    };
    auraRef.draw2d.image = typeof auraRef.draw2d.image === 'function'
      ? auraRef.draw2d.image
      : function (source, x, y, options) {
        return drawResolvedImage(source, x, y, options, false);
      };
    auraRef.draw2d.sprite = typeof auraRef.draw2d.sprite === 'function'
      ? auraRef.draw2d.sprite
      : function (source, x, y, options) {
        return drawResolvedImage(source, x, y, options, true);
      };
    auraRef.draw2d.pushTransform = function () {
      const ctx = ensureWorldTransform();
      if (!ctx || typeof ctx.save !== 'function') return;
      runtime.transformDepth += 1;
      ctx.save();
    };
    auraRef.draw2d.popTransform = function () {
      const ctx = ensureCanvasContext();
      if (!ctx || typeof ctx.restore !== 'function' || runtime.transformDepth <= 0) return;
      runtime.transformDepth -= 1;
      ctx.restore();
    };
    auraRef.draw2d.push = auraRef.draw2d.pushTransform;
    auraRef.draw2d.pop = auraRef.draw2d.popTransform;
    auraRef.draw2d.translate = function (x, y) {
      const ctx = ensureWorldTransform();
      if (!ctx || typeof ctx.translate !== 'function') return;
      ctx.translate(Number(x) || 0, Number(y) || 0);
    };
    auraRef.draw2d.rotate = function (angle) {
      const ctx = ensureWorldTransform();
      if (!ctx || typeof ctx.rotate !== 'function') return;
      ctx.rotate(Number(angle) || 0);
    };
    auraRef.draw2d.scale = function (x, y) {
      const ctx = ensureWorldTransform();
      if (!ctx || typeof ctx.scale !== 'function') return;
      const scaleX = Number.isFinite(Number(x)) ? Number(x) : 1;
      const scaleY = Number.isFinite(Number(y)) ? Number(y) : scaleX;
      ctx.scale(scaleX, scaleY);
    };

    return {
      aura: auraRef,
      setRuntimeConfig(nextRuntimeConfig) {
        currentRuntimeConfig = nextRuntimeConfig && typeof nextRuntimeConfig === 'object' ? nextRuntimeConfig : {};
        currentCanvasConfig = currentRuntimeConfig.canvas && typeof currentRuntimeConfig.canvas === 'object'
          ? currentRuntimeConfig.canvas
          : {};
        runtime.configuredWidth = normalizeCanvasSize(currentCanvasConfig.width, runtime.configuredWidth);
        runtime.configuredHeight = normalizeCanvasSize(currentCanvasConfig.height, runtime.configuredHeight);
        runtime.resizeMode = currentCanvasConfig.resizeMode === 'fixed' ? 'fixed' : 'fit-container';
        syncCanvasSize(false);
      },
      setManifest(nextManifest, rootUrl) {
        indexManifestAssets(nextManifest, rootUrl);
      },
      mount(canvas, mountTarget) {
        runtime.canvas = canvas || runtime.canvas;
        runtime.mountTarget = mountTarget || runtime.mountTarget;
        ensureCanvasContext();
        syncCanvasSize(false);
        resetDrawState();
        attachListeners();
        inputState.down.clear();
        inputState.pendingPressed.clear();
        inputState.pendingReleased.clear();
        inputState.framePressed.clear();
        inputState.frameReleased.clear();
        inputState.mouseDown.clear();
        inputState.pendingMousePressed.clear();
        inputState.pendingMouseReleased.clear();
        inputState.frameMousePressed.clear();
        inputState.frameMouseReleased.clear();
        auraRef.input.mouse.scroll = 0;
        if (runtime.canvas && typeof runtime.canvas.focus === 'function') {
          runtime.canvas.focus();
        }
        if (typeof auraRef.onFocus === 'function') {
          auraRef.onFocus();
        }
        return true;
      },
      beginFrame() {
        inputState.framePressed = new Set(inputState.pendingPressed);
        inputState.frameReleased = new Set(inputState.pendingReleased);
        inputState.pendingPressed.clear();
        inputState.pendingReleased.clear();
        inputState.frameMousePressed = new Set(inputState.pendingMousePressed);
        inputState.frameMouseReleased = new Set(inputState.pendingMouseReleased);
        inputState.pendingMousePressed.clear();
        inputState.pendingMouseReleased.clear();
        resetDrawState();
      },
      endFrame() {
        const ctx = ensureCanvasContext();
        if (ctx && typeof ctx.restore === 'function') {
          while (runtime.transformDepth > 0) {
            runtime.transformDepth -= 1;
            ctx.restore();
          }
        }
      },
      unmount() {
        detachListeners();
        inputState.down.clear();
        inputState.pendingPressed.clear();
        inputState.pendingReleased.clear();
        inputState.framePressed.clear();
        inputState.frameReleased.clear();
        inputState.mouseDown.clear();
        inputState.pendingMousePressed.clear();
        inputState.pendingMouseReleased.clear();
        inputState.frameMousePressed.clear();
        inputState.frameMouseReleased.clear();
        runtime.mountTarget = null;
        runtime.canvas = null;
        runtime.context2d = null;
        runtime.transformDepth = 0;
        runtime.worldTransformActive = false;
        return true;
      }
    };
  }

  function createDeterministicBootstrap() {
    return async function bootstrap(input) {
      const auraRef = auraRuntime && auraRuntime.aura
        ? auraRuntime.aura
        : (globalRef.aura && typeof globalRef.aura === 'object'
          ? globalRef.aura
          : (globalRef.aura = {}));
      const runtimeConfig = input && typeof input.runtimeConfig === 'object' && input.runtimeConfig
        ? input.runtimeConfig
        : {};
      const loopConfig = runtimeConfig.loop && typeof runtimeConfig.loop === 'object'
        ? runtimeConfig.loop
        : {};
      const maxDeltaSeconds = normalizePositiveNumber(loopConfig.maxDeltaMs, 50) / 1000;
      const fixedDeltaSeconds = Math.min(maxDeltaSeconds, 1 / 60);
      const requestFrame = typeof globalRef.requestAnimationFrame === 'function'
        ? globalRef.requestAnimationFrame.bind(globalRef)
        : function (callback) {
          return globalRef.setTimeout(function () {
            callback(Date.now());
          }, 16);
        };
      const cancelFrame = typeof globalRef.cancelAnimationFrame === 'function'
        ? globalRef.cancelAnimationFrame.bind(globalRef)
        : function (handle) {
          globalRef.clearTimeout(handle);
        };

      const runtimeState = {
        disposed: false,
        running: false,
        setupCalls: 0,
        updateCalls: 0,
        drawCalls: 0,
        frameCount: 0,
        lastDeltaSeconds: 0,
        rafHandle: null
      };

      function getLifecycle() {
        return {
          running: runtimeState.running && runtimeState.disposed === false,
          setupCalls: runtimeState.setupCalls,
          updateCalls: runtimeState.updateCalls,
          drawCalls: runtimeState.drawCalls,
          frameCount: runtimeState.frameCount,
          lastDeltaSeconds: runtimeState.lastDeltaSeconds
        };
      }

      function syncLifecycle() {
        state.lifecycle = cloneLifecycle(getLifecycle());
      }

      try {
        if (typeof auraRef.setup === 'function') {
          const setupResult = auraRef.setup();
          if (setupResult && typeof setupResult.then === 'function') {
            await setupResult;
          }
          runtimeState.setupCalls += 1;
        }
      } catch (error) {
        throw createError(
          'web_runtime_bootstrap_failed',
          'Runtime setup failed.',
          'runtime',
          true,
          { stage: 'setup', cause: String(error && error.message ? error.message : error) }
        );
      }

      runtimeState.running = true;
      syncLifecycle();

      function step() {
        if (runtimeState.running === false || runtimeState.disposed === true) {
          return;
        }
        runtimeState.frameCount += 1;
        runtimeState.lastDeltaSeconds = fixedDeltaSeconds;

        try {
          if (auraRuntime && typeof auraRuntime.beginFrame === 'function') {
            auraRuntime.beginFrame();
          }
          if (typeof auraRef.update === 'function') {
            auraRef.update(fixedDeltaSeconds);
            runtimeState.updateCalls += 1;
          }
          if (typeof auraRef.draw === 'function') {
            auraRef.draw();
            runtimeState.drawCalls += 1;
          }
          if (auraRuntime && typeof auraRuntime.endFrame === 'function') {
            auraRuntime.endFrame();
          }
        } catch (error) {
          runtimeState.running = false;
          syncLifecycle();
          const normalized = normalizeError(
            error,
            'web_runtime_bootstrap_failed',
            'Runtime lifecycle callback failed.',
            'runtime',
            true
          );
          setState('error', normalized.reasonCode, {
            reasonCode: normalized.reasonCode,
            layer: normalized.layer || 'runtime',
            retryable: normalized.retryable === true,
            details: normalized.details || {}
          });
          return;
        }

        syncLifecycle();
        runtimeState.rafHandle = requestFrame(step);
      }

      runtimeState.rafHandle = requestFrame(step);

      return {
        getLifecycle,
        async unmount() {
          if (runtimeState.disposed === true) {
            return true;
          }
          runtimeState.disposed = true;
          runtimeState.running = false;
          if (runtimeState.rafHandle != null) {
            cancelFrame(runtimeState.rafHandle);
            runtimeState.rafHandle = null;
          }
          if (auraRuntime && typeof auraRuntime.unmount === 'function') {
            auraRuntime.unmount();
          }
          syncLifecycle();
          return true;
        }
      };
    };
  }

  function resolveBootstrap() {
    if (typeof globalRef.__AURA_WEB_BOOTSTRAP__ === 'function') {
      return globalRef.__AURA_WEB_BOOTSTRAP__;
    }
    return createDeterministicBootstrap();
  }

  function getLifecycleSnapshot() {
    if (mountedRuntime && typeof mountedRuntime.getLifecycle === 'function') {
      try {
        return cloneLifecycle(mountedRuntime.getLifecycle());
      } catch (_) {
        return cloneLifecycle(state.lifecycle);
      }
    }
    return cloneLifecycle(state.lifecycle);
  }

  const loader = {
    async load(options) {
      return captureFailure(
        {
          reasonCode: 'web_loader_load_failed',
          message: 'Loader failed to initialize web runtime assets.',
          layer: 'loader',
          retryable: true
        },
        async function () {
          const opts = options || {};
          const rootUrl = typeof opts.rootUrl === 'string' && opts.rootUrl.length > 0
            ? opts.rootUrl.replace(/\/$/, '')
            : '.';
          cachedRootUrl = rootUrl;
          setState('loading', null, null);

          cachedManifest = await readJson(rootUrl + '/web-build-manifest.json', 'web_manifest_missing', 'web_manifest_parse_failed');
          cachedRuntimeConfig = await readJson(rootUrl + '/runtime-config.json', 'web_runtime_config_missing', 'web_runtime_config_parse_failed');
          ensureManifestValid(cachedManifest);
          ensureRuntimeConfigValid(cachedRuntimeConfig);

          if (!auraRuntime) {
            auraRuntime = createBrowserAuraSurface(cachedRuntimeConfig);
          } else if (typeof auraRuntime.setRuntimeConfig === 'function') {
            auraRuntime.setRuntimeConfig(cachedRuntimeConfig);
          }
          if (auraRuntime && typeof auraRuntime.setManifest === 'function') {
            auraRuntime.setManifest(cachedManifest, cachedRootUrl);
          }

          const bundleEntry = normalizePath(cachedManifest.entrypoints.bundle);
          if (bundleEntry.length === 0) {
            throw createError('web_entrypoint_missing', 'Bundle entrypoint is empty.', 'loader', false, {});
          }
          await loadScript(rootUrl + '/' + bundleEntry);
          setState('loaded', null, null);
          return true;
        }
      );
    },
    async mount(target, options) {
      return captureFailure(
        {
          reasonCode: 'web_loader_mount_failed',
          message: 'Loader mount sequence failed.',
          layer: 'loader',
          retryable: true
        },
        async function () {
          if (!cachedManifest || !cachedRuntimeConfig) {
            await loader.load(options || {});
          }

          if (mountedRuntime && typeof mountedRuntime.unmount === 'function') {
            await mountedRuntime.unmount();
            mountedRuntime = null;
          }

          setState('mounting', null, null);
          const opts = options && typeof options === 'object' ? options : {};
          const targetNode = resolveTarget(target == null ? opts.mount : target);
          if (!targetNode) {
            throw createError('web_loader_mount_target_invalid', 'Mount target was not found.', 'loader', false, {});
          }
          const canvas = targetNode.querySelector && targetNode.querySelector('canvas')
            ? targetNode.querySelector('canvas')
            : document.getElementById('aura-canvas');
          if (!canvas) {
            throw createError('web_loader_mount_failed', 'Canvas target was not found.', 'loader', true, {});
          }

          if (!auraRuntime) {
            auraRuntime = createBrowserAuraSurface(cachedRuntimeConfig || {});
          }
          if (auraRuntime && typeof auraRuntime.setManifest === 'function') {
            auraRuntime.setManifest(cachedManifest || {}, cachedRootUrl);
          }
          if (typeof auraRuntime.mount === 'function') {
            auraRuntime.mount(canvas, targetNode);
          }

          const bootstrap = resolveBootstrap();
          if (typeof bootstrap !== 'function') {
            throw createError('web_runtime_bootstrap_missing', 'Bundle did not expose required bootstrap function.', 'runtime', false, {});
          }

          let runtimeResult;
          try {
            runtimeResult = await bootstrap({
              canvas: canvas,
              runtimeConfig: cachedRuntimeConfig || {},
              manifest: cachedManifest || {}
            });
          } catch (error) {
            throw normalizeError(
              error,
              'web_runtime_bootstrap_failed',
              'Runtime bootstrap threw an exception.',
              'runtime',
              true
            );
          }

          if (!runtimeResult || typeof runtimeResult !== 'object') {
            throw createError('web_runtime_bootstrap_failed', 'Runtime bootstrap returned invalid payload.', 'runtime', false, {});
          }
          if (typeof runtimeResult.unmount !== 'function') {
            runtimeResult.unmount = async function () {
              return true;
            };
          }

          mountedRuntime = runtimeResult;
          state.lifecycle = getLifecycleSnapshot();
          setState('mounted', null, null);
          return true;
        }
      );
    },
    async unmount() {
      return captureFailure(
        {
          reasonCode: 'web_loader_unmount_failed',
          message: 'Loader unmount sequence failed.',
          layer: 'loader',
          retryable: true
        },
        async function () {
          setState('unmounting', null, null);
          if (mountedRuntime && typeof mountedRuntime.unmount === 'function') {
            await mountedRuntime.unmount();
          }
          mountedRuntime = null;
          state.lifecycle = cloneLifecycle(state.lifecycle);
          state.lifecycle.running = false;
          setState('unmounted', null, null);
          return true;
        }
      );
    },
    getState() {
      return {
        phase: state.phase,
        reasonCode: state.reasonCode,
        lastError: state.lastError ? { ...state.lastError } : null,
        lifecycle: getLifecycleSnapshot()
      };
    }
  };

  globalRef.AuraWebLoader = loader;
})(typeof window !== 'undefined' ? window : globalThis);
