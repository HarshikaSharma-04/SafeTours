/**
 * The map page shown inside a WebView (iframe on the web): Leaflet plus free raster tiles, with no API key.
 *
 * Why not a native map: on Android, react-native-maps needs a Google Maps key inside the built app, so a missing
 * key meant a blank map. This page needs no key and no billing account, and looks the same on every platform.
 *
 * Messages, as JSON:
 *   app -> page  window.SafeToursMap.receive({ type: 'data' | 'camera' | 'select' | 'mapType' | 'inset', ... })
 *   page -> app  { type: 'ready' | 'zone' | 'place' | 'destination' | 'region' | 'tiles', ... }
 *
 * Text from other users (community reports) reaches this page, so it only ever goes in through textContent.
 */
const leaflet = require('./leafletBundle');

// Keyless sources only. CARTO's basemaps were tried first and now answer with an "API KEY REQUIRED" watermark image
// (HTTP 200, so no tile error fires): check any new source by eye, not by status code.
const BASES = [
  {
    name: 'osm',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: '© OpenStreetMap contributors' },
  },
  {
    name: 'osm-hot',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    options: { subdomains: 'abc', maxZoom: 19, attribution: '© OpenStreetMap contributors, HOT' },
  },
];

const SATELLITE = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  options: { maxZoom: 19, attribution: 'Imagery © Esri' },
};

const LABELS = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  options: { maxZoom: 19 },
};

// Runs before Leaflet, so a failure while the page starts still reaches the app instead of leaving a silent blank map.
const ERROR_HOOK = `
window.onerror = function (message, source, line) {
  var text = JSON.stringify({ type: 'error', message: String(message) + ' (line ' + line + ')' });
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(text);
  else if (window.parent && window.parent !== window) window.parent.postMessage(text, '*');
};
`;

const PAGE_CSS = `
html, body, #map { height: 100%; width: 100%; margin: 0; padding: 0; }
#map {
  background-color: #eef0f2;
  background-image: linear-gradient(#dfe3e6 1px, transparent 1px), linear-gradient(90deg, #dfe3e6 1px, transparent 1px);
  background-size: 48px 48px;
}
.leaflet-control-attribution { font-size: 9px; }
.st-dot { position: relative; width: 36px; height: 36px; }
.st-dot .ring { position: absolute; left: 5px; top: 5px; width: 26px; height: 26px; border-radius: 13px; opacity: .25; }
.st-dot .core { position: absolute; left: 11px; top: 11px; width: 14px; height: 14px; border-radius: 7px; border: 2px solid #fff; box-sizing: border-box; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.st-incident { width: 24px; height: 24px; border-radius: 12px; border: 2px solid #fff; box-sizing: border-box; box-shadow: 0 1px 4px rgba(0,0,0,.4); color: #fff; font: bold 14px/20px sans-serif; text-align: center; }
.st-popup-title { font: bold 13px sans-serif; margin-bottom: 2px; }
.st-popup-body { font: 12px sans-serif; max-width: 220px; }
#tile-note { position: absolute; left: 50%; transform: translateX(-50%); top: 45%; z-index: 500; display: none; max-width: 78%; padding: 8px 12px; border-radius: 12px; background: rgba(40,40,40,.86); color: #fff; font: 12px sans-serif; text-align: center; pointer-events: none; }
`;

// Runs in the page, not in the app. Written against plain browser APIs and Leaflet only.
const PAGE_SCRIPT = `
(function () {
  var BASES = __BASES__, SATELLITE = __SATELLITE__, LABELS = __LABELS__;

  function post(msg) {
    var text = JSON.stringify(msg);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(text);
    else if (window.parent && window.parent !== window) window.parent.postMessage(text, '*');
  }

  // One canvas for every shape: thousands of hexagons stay smooth, and a second canvas on top would swallow taps.
  var renderer = L.canvas({ padding: 0.3, tolerance: 8 });
  var map = L.map('map', { renderer: renderer, zoomControl: false, minZoom: 3, maxZoom: 19, worldCopyJump: true });
  map.setView([18.922, 72.8347], 14);

  var layers = {
    zones: L.layerGroup().addTo(map),
    highlight: L.layerGroup().addTo(map),
    route: L.layerGroup().addTo(map),
    places: L.layerGroup().addTo(map),
    incidents: L.layerGroup().addTo(map),
    destination: L.layerGroup().addTo(map),
    user: L.layerGroup().addTo(map),
  };

  // Base tiles: OpenStreetMap first, the HOT style if it fails, and a plain note if neither answers. The risk cells and
  // pins are drawn by this page, so they stay usable with no tiles at all.
  var note = document.getElementById('tile-note');
  var baseLayer = null, labelLayer = null, baseIndex = 0, mapType = 'standard', errors = 0, loaded = false;

  function tilesFailed() {
    note.style.display = 'block';
    post({ type: 'tiles', status: 'failed' });
  }

  function attach(layer) {
    layer.on('tileload', function () {
      if (!loaded) post({ type: 'tiles', status: 'ok', source: mapType === 'hybrid' ? 'satellite' : BASES[baseIndex].name });
      loaded = true;
      errors = 0;
      note.style.display = 'none';
    });
    layer.on('tileerror', function () {
      errors += 1;
      if (loaded || errors < 6) return;
      errors = 0;
      if (mapType !== 'hybrid' && baseIndex < BASES.length - 1) {
        baseIndex += 1;
        showBase();
      } else {
        tilesFailed();
      }
    });
    return layer;
  }

  function showBase() {
    if (baseLayer) map.removeLayer(baseLayer);
    if (labelLayer) map.removeLayer(labelLayer);
    baseLayer = null;
    labelLayer = null;
    loaded = false;
    errors = 0;
    if (mapType === 'hybrid') {
      baseLayer = attach(L.tileLayer(SATELLITE.url, SATELLITE.options)).addTo(map);
      labelLayer = L.tileLayer(LABELS.url, LABELS.options).addTo(map);
    } else {
      baseLayer = attach(L.tileLayer(BASES[baseIndex].url, BASES[baseIndex].options)).addTo(map);
    }
  }
  showBase();

  function popupNode(title, body) {
    var root = document.createElement('div');
    var t = document.createElement('div');
    t.className = 'st-popup-title';
    t.textContent = title || '';
    root.appendChild(t);
    if (body) {
      var b = document.createElement('div');
      b.className = 'st-popup-body';
      b.textContent = body;
      root.appendChild(b);
    }
    return root;
  }

  function dotIcon(color) {
    var root = document.createElement('div');
    root.className = 'st-dot';
    var ring = document.createElement('div');
    ring.className = 'ring';
    ring.style.background = color;
    var core = document.createElement('div');
    core.className = 'core';
    core.style.background = color;
    root.appendChild(ring);
    root.appendChild(core);
    return L.divIcon({ html: root, className: '', iconSize: [36, 36], iconAnchor: [18, 18] });
  }

  function toLatLngs(points) {
    return (points || []).map(function (p) { return [p.latitude, p.longitude]; });
  }

  var zonesById = {};

  function drawZones(zones) {
    layers.zones.clearLayers();
    zonesById = {};
    (zones || []).forEach(function (z) {
      var style = { color: z.stroke, weight: 0.5, fillColor: z.fill, fillOpacity: z.fillOpacity, opacity: 0.5 };
      var shape = z.polygon && z.polygon.length >= 3
        ? L.polygon(toLatLngs(z.polygon), style)
        : L.circle([z.latitude, z.longitude], Object.assign({ radius: z.radius || 200 }, style));
      shape.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        post({ type: 'zone', id: z.id });
      });
      zonesById[z.id] = z;
      layers.zones.addLayer(shape);
    });
  }

  function drawSelection(id) {
    layers.highlight.clearLayers();
    var z = id && zonesById[id];
    if (!z) return;
    if (z.polygon && z.polygon.length >= 3) {
      L.polygon(toLatLngs(z.polygon), { color: '#000', weight: 3, fill: false, interactive: false }).addTo(layers.highlight);
    } else {
      L.circle([z.latitude, z.longitude], { radius: z.radius || 200, color: '#000', weight: 3, fill: false, interactive: false }).addTo(layers.highlight);
    }
  }

  function drawPlaces(places) {
    layers.places.clearLayers();
    (places || []).forEach(function (p) {
      var pin = L.circleMarker([p.latitude, p.longitude], { radius: 8, color: '#fff', weight: 2, fillColor: p.color || '#2563eb', fillOpacity: 1 });
      pin.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        post({ type: 'place', id: p.id });
      });
      layers.places.addLayer(pin);
    });
  }

  function drawIncidents(incidents) {
    layers.incidents.clearLayers();
    (incidents || []).forEach(function (i) {
      var root = document.createElement('div');
      root.className = 'st-incident';
      root.style.background = i.color;
      root.textContent = '!';
      var marker = L.marker([i.latitude, i.longitude], { icon: L.divIcon({ html: root, className: '', iconSize: [24, 24], iconAnchor: [12, 12] }) });
      marker.bindPopup(popupNode(i.title, i.description));
      layers.incidents.addLayer(marker);
    });
  }

  function drawDestination(d) {
    layers.destination.clearLayers();
    if (!d) return;
    var marker = L.marker([d.latitude, d.longitude], { icon: dotIcon('#e11d48') });
    marker.on('click', function () { post({ type: 'destination' }); });
    layers.destination.addLayer(marker);
  }

  function drawRoute(route) {
    layers.route.clearLayers();
    if (!route || !route.points || route.points.length < 2) return;
    L.polyline(toLatLngs(route.points), { color: '#fff', weight: 8, opacity: 0.85, interactive: false }).addTo(layers.route);
    L.polyline(toLatLngs(route.points), { color: route.color || '#2563eb', weight: 5, dashArray: route.dashed ? '8 8' : null, interactive: false }).addTo(layers.route);
  }

  var userMarker = null;
  function drawUser(u, color) {
    if (!u) {
      layers.user.clearLayers();
      userMarker = null;
      return;
    }
    if (userMarker) {
      userMarker.setLatLng([u.latitude, u.longitude]);
      return;
    }
    userMarker = L.marker([u.latitude, u.longitude], { icon: dotIcon(color || '#8b4f2b'), zIndexOffset: 1000, keyboard: false });
    userMarker.bindPopup(popupNode('Your location', 'You are here'));
    layers.user.addLayer(userMarker);
  }

  function regionBounds(r) {
    return L.latLngBounds(
      [r.latitude - r.latitudeDelta / 2, r.longitude - r.longitudeDelta / 2],
      [r.latitude + r.latitudeDelta / 2, r.longitude + r.longitudeDelta / 2]
    );
  }

  // A WebView can start with no size on a phone. Fitting a camera then gives minimum zoom (the whole world), so the
  // camera waits until the map really has a size.
  var pendingCamera = null;

  function hasSize() {
    var el = map.getContainer();
    return el.clientWidth > 0 && el.clientHeight > 0;
  }

  function moveCamera(region, ms) {
    if (!region) return;
    if (!hasSize()) {
      pendingCamera = region;
      return;
    }
    map.invalidateSize({ animate: false });
    var bounds = regionBounds(region);
    map.fitBounds(bounds, ms ? { animate: true, duration: ms / 1000 } : { animate: false });
  }

  function onViewportChange() {
    if (!hasSize()) return;
    map.invalidateSize({ animate: false });
    if (pendingCamera) {
      var region = pendingCamera;
      pendingCamera = null;
      moveCamera(region);
    }
  }

  // Startup camera moves can leave the base tiles stuck at an old position, all of them off-screen, until the next drag.
  // That reads as a blank map, so it is repaired here. Tiles that failed to load still count as in view: with no
  // connection this must not keep asking for them again.
  function baseTilesInView() {
    var box = map.getContainer().getBoundingClientRect();
    var tiles = map.getContainer().querySelectorAll('.leaflet-tile');
    if (tiles.length === 0) return true; // still loading
    for (var i = 0; i < tiles.length; i += 1) {
      var r = tiles[i].getBoundingClientRect();
      if (r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top) return true;
    }
    return false;
  }

  function repairBaseTiles() {
    if (!baseLayer || !hasSize() || map._animatingZoom || baseTilesInView()) return;
    baseLayer.redraw();
    if (labelLayer) labelLayer.redraw();
  }

  map.on('moveend', function () { setTimeout(repairBaseTiles, 400); });
  setInterval(repairBaseTiles, 3000);

  window.addEventListener('resize', onViewportChange);
  if (window.ResizeObserver) new ResizeObserver(onViewportChange).observe(map.getContainer());

  map.on('moveend', function () {
    var b = map.getBounds(), c = map.getCenter();
    post({
      type: 'region',
      region: { latitude: c.lat, longitude: c.lng, latitudeDelta: b.getNorth() - b.getSouth(), longitudeDelta: b.getEast() - b.getWest() },
    });
  });

  window.SafeToursMap = {
    receive: function (msg) {
      if (msg.type === 'data') {
        if ('zones' in msg) drawZones(msg.zones);
        if ('places' in msg) drawPlaces(msg.places);
        if ('incidents' in msg) drawIncidents(msg.incidents);
        if ('destination' in msg) drawDestination(msg.destination);
        if ('route' in msg) drawRoute(msg.route);
        if ('user' in msg) drawUser(msg.user, msg.userColor);
        if ('selectedId' in msg) drawSelection(msg.selectedId);
      } else if (msg.type === 'select') {
        drawSelection(msg.id);
      } else if (msg.type === 'camera') {
        moveCamera(msg.region, msg.ms);
      } else if (msg.type === 'mapType') {
        if (msg.mapType !== mapType) {
          mapType = msg.mapType;
          showBase();
        }
      } else if (msg.type === 'inset') {
        var bottom = document.querySelectorAll('.leaflet-bottom');
        for (var i = 0; i < bottom.length; i += 1) bottom[i].style.bottom = (msg.bottom || 0) + 'px';
      }
    },
  };

  window.addEventListener('message', function (e) {
    try {
      window.SafeToursMap.receive(typeof e.data === 'string' ? JSON.parse(e.data) : e.data);
    } catch (err) {
      /* not one of ours */
    }
  });

  post({ type: 'ready', width: map.getContainer().clientWidth, height: map.getContainer().clientHeight });
})();
`;

function pageScript() {
  return PAGE_SCRIPT
    .replace('__BASES__', JSON.stringify(BASES))
    .replace('__SATELLITE__', JSON.stringify(SATELLITE))
    .replace('__LABELS__', JSON.stringify(LABELS));
}

// A literal "</script" inside an inline script would end it early.
const inline = (code) => code.replace(/<\/script/gi, '<\\/script');

function buildMapHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>${leaflet.css}</style>
<style>${PAGE_CSS}</style>
</head>
<body>
<div id="map"></div>
<div id="tile-note">Base map not available right now. Risk cells and pins are still shown.</div>
<script>${ERROR_HOOK}</script>
<script>${inline(leaflet.js)}</script>
<script>${inline(pageScript())}</script>
</body>
</html>`;
}

module.exports = { buildMapHtml, pageScript };
