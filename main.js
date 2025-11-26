// Supabase configuration (ESM import via esm.sh for GitHub Pages)
var SUPABASE_URL = 'https://oggnnptinplbdmkhkaqh.supabase.co';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nZ25ucHRpbnBsYmRta2hrYXFoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQxMTg0MDYsImV4cCI6MjA3OTY5NDQwNn0.0X6PJMoEP6YvU_4g3qn6glHU1Qiuq507gFq79TnyQPQ';
var supabase = null;

// Define the bounds of UP Diliman (approximate)
var bounds = [
    [14.645541284855522, 121.05357969734676], // southwest corner
    [14.662347587500506, 121.07857195809305]  // northeast corner
];

// Default center for the map (UP Diliman)
var defaultCenter = [14.6556, 121.0733];

// Map reference (will be initialized after DOM loads)
var map = null;

// Keep track of pins (id -> { id, name, marker })
var pins = {};
// Build rich HTML for marker popup
function renderPopupContent(name, landmarkText, latlng) {
    var coords = latlng ? (Math.round(latlng.lat * 10000) / 10000 + ", " + Math.round(latlng.lng * 10000) / 10000) : '';
    var lm = landmarkText ? ('<div class="popup-sub">' + landmarkText + '</div>') : '';
    var ts = new Date().toLocaleString();
    return (
        '<div class="popup-card">' +
            '<div class="popup-title">' + (name || 'Unnamed pin') + '</div>' +
            lm +
            (coords ? '<div class="popup-meta">' + coords + '</div>' : '') +
            '<div class="popup-time">Updated ' + ts + '</div>' +
        '</div>'
    );
}

// LocalStorage key for persistence
var PINS_STORE_KEY = 'hazardmap-pins-v1';

// Persist current pins (id, name, lat, lng)
function savePins() {
    var arr = [];
    Object.keys(pins).forEach(function(id) {
        var p = pins[id];
        if (p && p.marker) {
            var ll = p.marker.getLatLng();
            arr.push({ id: id, name: p.name, lat: ll.lat, lng: ll.lng });
        }
    });
    var payload = { version: 1, pins: arr };
    try { localStorage.setItem(PINS_STORE_KEY, JSON.stringify(payload)); } catch (e) {}
}

// Restore pins from storage (re-run landmark lookup for fresh data)
function loadPins() {
    var raw = null;
    try { raw = localStorage.getItem(PINS_STORE_KEY); } catch (e) { raw = null; }
    if (!raw) return;
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    if (!data || !data.pins || !Array.isArray(data.pins)) return;
    data.pins.forEach(function(stored) {
        if (!stored || !stored.id || typeof stored.lat !== 'number' || typeof stored.lng !== 'number') return;
        // Avoid recreating if somehow already present
        if (pins[stored.id]) return;
        var marker = L.marker([stored.lat, stored.lng]).addTo(map);
        var nm = stored.name || 'Unnamed pin';
        marker.bindPopup(renderPopupContent(nm, null, { lat: stored.lat, lng: stored.lng }));
        pins[stored.id] = { id: stored.id, name: nm, marker: marker };
        addPinToList(stored.id, nm, marker);
        // Allow renaming again
        marker.on('dblclick', function() {
            var current = marker.getPopup() ? marker.getPopup().getContent() : '';
            var newName = prompt('Rename pin:', current);
            if (newName === null) return;
            newName = newName.trim();
            if (newName === '') newName = 'Unnamed pin';
            marker.bindPopup(renderPopupContent(newName, null, marker.getLatLng())).openPopup();
            pins[stored.id].name = newName;
            updatePinNameInList(stored.id, newName);
            savePins();
        });
    });
}

// Fetch shared pins from Supabase then cache locally; fallback to local if unavailable
async function fetchPinsFromSupabase() {
    if (!supabase) { loadPins(); return; }
    try {
        var result = await supabase.from('pins').select('*').order('created_at');
        if (result.error) { console.warn('Supabase fetch error; fallback to local:', result.error); loadPins(); return; }
        var rows = result.data || [];
        rows.forEach(function(row) {
            if (!row || !row.id || typeof row.lat !== 'number' || typeof row.lng !== 'number') return;
            if (pins[row.id]) return;
            var marker = L.marker([row.lat, row.lng]).addTo(map);
            var nm = row.name || 'Unnamed pin';
            marker.bindPopup(renderPopupContent(nm, null, { lat: row.lat, lng: row.lng }));
            pins[row.id] = { id: row.id, name: nm, marker: marker };
            addPinToList(row.id, nm, marker);
            marker.on('dblclick', function() {
                var current = marker.getPopup() ? marker.getPopup().getContent() : '';
                var newName = prompt('Rename pin:', current);
                if (newName === null) return;
                newName = newName.trim();
                if (newName === '') newName = 'Unnamed pin';
                marker.bindPopup(renderPopupContent(newName, null, marker.getLatLng())).openPopup();
                pins[row.id].name = newName;
                updatePinNameInList(row.id, newName);
                savePins();
                supabase.from('pins').update({ name: newName, updated_at: new Date().toISOString() }).eq('id', row.id).then(function(r){ if(r.error) console.warn('Supabase rename failed:', r.error); });
            });
        });
        savePins();
    } catch (e) {
        console.warn('Supabase fetch exception:', e);
        loadPins();
    }
}

// Realtime subscription to reflect other users' changes
function initRealtimePins() {
    if (!supabase) return;
    supabase.channel('public:pins')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pins' }, function(payload) {
            var row = payload.new;
            if (!row || pins[row.id]) return;
            var marker = L.marker([row.lat, row.lng]).addTo(map);
            var nm = row.name || 'Unnamed pin';
            marker.bindPopup(nm);
            pins[row.id] = { id: row.id, name: nm, marker: marker };
            addPinToList(row.id, nm, marker);
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'pins' }, function(payload) {
            var row = payload.new;
            if (!row || !pins[row.id]) return;
            pins[row.id].name = row.name || 'Unnamed pin';
            updatePinNameInList(row.id, pins[row.id].name);
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'pins' }, function(payload) {
            var id = payload.old.id;
            var p = pins[id];
            if (!p) return;
            try { p.marker.remove(); } catch (e) {}
            delete pins[id];
            var item = pinListContainer ? pinListContainer.querySelector('[data-pin-id="' + id + '"]') : null;
            if (item && item.parentNode) item.parentNode.removeChild(item);
            savePins();
        })
        .subscribe(function(status) {
            if (status === 'SUBSCRIBED') console.log('Realtime pins subscribed');
        });
}

// Reference to the hazard list container (left sidebar). Will be set after DOM loads.
var pinListContainer = null;

// Sidebar tab behavior: switch visible tab panel and update aria attributes
function initSidebarTabs() {
    try {
        var tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tab-button'));
        tabButtons.forEach(function(btn) {
            btn.addEventListener('click', function() {
                activateTab(btn);
            });
            btn.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    activateTab(btn);
                }
            });
        });

        function activateTab(button) {
            var allButtons = document.querySelectorAll('.tab-button');
            allButtons.forEach(function(b) {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            button.classList.add('active');
            button.setAttribute('aria-selected', 'true');

            var panels = document.querySelectorAll('.tab-panel');
            panels.forEach(function(p) { p.hidden = true; });
            var targetId = button.getAttribute('aria-controls');
            var target = document.getElementById(targetId);
            if (target) target.hidden = false;
        }
    } catch (e) { /* fail silently if sidebar not present */ }
}

// initialize sidebar tabs and theme toggle on load
document.addEventListener('DOMContentLoaded', async function() {
    // Wait for Leaflet to be available
    if (typeof L === 'undefined') {
        console.error('Leaflet not loaded');
        return;
    }

    // Initialize Supabase via ESM import (works on GitHub Pages)
    try {
        const mod = await import('https://esm.sh/@supabase/supabase-js@2.45.4?target=es2022');
        if (mod && mod.createClient) {
            supabase = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
            var st = document.getElementById('conn-status');
            if (st) st.textContent = 'Connected to Supabase';
        } else {
            console.warn('Supabase module missing createClient; using local-only pins');
            var st2 = document.getElementById('conn-status');
            if (st2) st2.textContent = 'Local-only mode';
        }
    } catch (e) {
        console.warn('Supabase ESM import failed; using local-only pins:', e);
        var st3 = document.getElementById('conn-status');
        if (st3) st3.textContent = 'Local-only mode';
    }
    
    // Set DOM reference after elements are ready
    pinListContainer = document.getElementById('hazard-list');
    
    // Initialize map
    map = L.map('map', {
        center: defaultCenter,
        zoom: 16,
        minZoom: 15,
        maxZoom: 19,
        maxBounds: bounds,
        maxBoundsViscosity: 0.8
    });
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19,
        maxNativeZoom: 19
    }).addTo(map);
    
    map.whenReady(function() {
        setTimeout(function() {
            try { map.invalidateSize(); } catch (e) {}
            try { map.setView(defaultCenter, map.getZoom()); } catch (e) {}
        }, 50);
    });
    
    window.addEventListener('resize', function() {
        try { map.invalidateSize(); } catch (e) {}
        try { map.setView(defaultCenter, map.getZoom()); } catch (e) {}
    });
    
    initSidebarTabs(); 
    initThemeToggle();
    initNameDialog();
    // Fetch shared pins first; fallback to local cache.
    fetchPinsFromSupabase().then(function(){ initRealtimePins(); });
    
    // Add pin on map click (must be after map is initialized)
    map.on('click', function(e) {
        // Make sure pins stay within bounds
        if (
            e.latlng.lat >= bounds[0][0] && e.latlng.lat <= bounds[1][0] &&
            e.latlng.lng >= bounds[0][1] && e.latlng.lng <= bounds[1][1]
        ) {
            // Open name dialog; continue after user confirms
            openNameDialog('', async function(name) {
                name = (name || '').trim();
                if (name === '') name = 'Unnamed pin';
                var marker = L.marker([e.latlng.lat, e.latlng.lng]).addTo(map);
                marker.bindPopup(renderPopupContent(name, null, e.latlng)).openPopup();

            // Attempt remote insert; fallback local id if unavailable
            (async function createAndRegister(){
                var id = null;
                if (supabase) {
                    try {
                        var ins = await supabase.from('pins').insert({ name: name, lat: e.latlng.lat, lng: e.latlng.lng }).select();
                        if (!ins.error && ins.data && ins.data.length > 0) {
                            id = ins.data[0].id;
                        } else if (ins.error) {
                            console.warn('Supabase insert failed, using local id:', ins.error);
                        }
                    } catch (err) {
                        console.warn('Supabase insert exception, using local id:', err);
                    }
                }
                if (!id) id = 'pin-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
                pins[id] = { id: id, name: name, marker: marker };
                addPinToList(id, name, marker);
                savePins();
                marker.on('dblclick', function() {
                    var current = pins[id] ? pins[id].name : '';
                    openNameDialog(current, function(newName) {
                        if (newName === null) return;
                        newName = (newName || '').trim();
                        if (newName === '') newName = 'Unnamed pin';
                        marker.bindPopup(renderPopupContent(newName, null, marker.getLatLng())).openPopup();
                        pins[id].name = newName;
                        updatePinNameInList(id, newName);
                        savePins();
                        if (supabase) {
                            supabase.from('pins').update({ name: newName, updated_at: new Date().toISOString() }).eq('id', id).then(function(r){ if(r.error) console.warn('Supabase rename failed:', r.error); });
                        }
                    });
                });
            })();
            });
        } else {
            alert("You can't place a pin outside UP Diliman!");
        }
    });
});

// Theme toggle: persists user's choice in localStorage and updates UI
function applyTheme(theme) {
    if (theme === 'light') {
        document.documentElement.classList.add('light-mode');
    } else {
        document.documentElement.classList.remove('light-mode');
    }
    var btn = document.getElementById('theme-toggle');
    if (btn) {
        btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
        btn.textContent = theme === 'light' ? '☀️' : '🌙';
    }
}

function initThemeToggle() {
    try {
        var stored = null;
        try { stored = localStorage.getItem('hazardmap-theme'); } catch (e) { stored = null; }
        var initial = stored || 'dark';
        applyTheme(initial);

        var btn = document.getElementById('theme-toggle');
        if (!btn) return;
        btn.addEventListener('click', function() {
            var isLight = document.documentElement.classList.contains('light-mode');
            var next = isLight ? 'dark' : 'light';
            applyTheme(next);
            try { localStorage.setItem('hazardmap-theme', next); } catch (e) {}
        });
    } catch (e) { /* ignore */ }
}

// Query OpenStreetMap via Overpass for the closest building and the nearest named POI.
// Returns a Promise resolving to { building: {name,dist}|null, poi: {name,dist}|null }
function getBuildingAndPOI(latlng, radiusMeters) {
    radiusMeters = radiusMeters || 300;
    var lat = latlng.lat;
    var lon = latlng.lng;
    var url = 'https://overpass-api.de/api/interpreter';

    function fetchOverpass(query) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query)
        }).then(function(resp) {
            if (!resp.ok) return null;
            return resp.json();
        }).catch(function() { return null; });
    }

    // Query for buildings and named features in parallel to reduce total time
    var qBuilding = '[out:json][timeout:15];(node(around:' + radiusMeters + ',' + lat + ',' + lon + ')["building"];way(around:' + radiusMeters + ',' + lat + ',' + lon + ')["building"];relation(around:' + radiusMeters + ',' + lat + ',' + lon + ')["building"];);out center tags;';
    var qNamed = '[out:json][timeout:15];(node(around:' + radiusMeters + ',' + lat + ',' + lon + ')["name"];way(around:' + radiusMeters + ',' + lat + ',' + lon + ')["name"];relation(around:' + radiusMeters + ',' + lat + ',' + lon + ')["name"];);out center tags;';

    return Promise.all([fetchOverpass(qBuilding), fetchOverpass(qNamed)]).then(function(results) {
        var jsonB = results[0];
        var jsonN = results[1];
        var out = { building: null, poi: null };

        function capitalize(s) {
            if (!s) return s;
            return s.charAt(0).toUpperCase() + s.slice(1);
        }

        function getTypeFromTags(tags, preferBuilding) {
            if (!tags) return null;
            // Prefer obvious POI keys for readable type
            var keys = ['amenity','tourism','shop','leisure','historic','landuse','office','man_made','building'];
            if (preferBuilding) {
                // ensure 'building' is considered first when preferBuilding
                keys = ['building','amenity','tourism','shop','leisure','historic','landuse','office','man_made'];
            }
            for (var i=0;i<keys.length;i++) {
                var k = keys[i];
                if (tags[k]) {
                    var v = tags[k];
                    // ignore boolean 'yes' for building
                    if (k === 'building' && v.toLowerCase() === 'yes') continue;
                    // make a readable label: e.g. amenity=library -> 'Library'
                    if (k === 'building') return 'Building' + (v && v.toLowerCase() !== 'yes' ? ' ('+v+')' : '');
                    if (k === 'landuse') return capitalize(v);
                    return capitalize(v.replace('_',' '));
                }
            }
            return null;
        }

        if (jsonB && jsonB.elements && jsonB.elements.length > 0) {
            var nearestB = null;
            var minDistB = Infinity;
            jsonB.elements.forEach(function(el) {
                var elLat = el.lat;
                var elLon = el.lon;
                if ((!elLat || !elLon) && el.center) {
                    elLat = el.center.lat;
                    elLon = el.center.lon;
                }
                if (elLat && elLon) {
                    // skip elements not currently visible on the map
                    try {
                        var pt = L.latLng(elLat, elLon);
                        if (map && map.getBounds && !map.getBounds().contains(pt)) return;
                    } catch (e) {
                        // if Leaflet isn't available for some reason, fall back to including the element
                    }
                    var d = latlng.distanceTo(L.latLng(elLat, elLon));
                    if (d < minDistB) {
                        // only include buildings that have an explicit name tag
                        if (el.tags && el.tags.name) {
                            minDistB = d;
                            var displayName = el.tags.name;
                            var typeLabel = getTypeFromTags(el.tags, true) || 'Building';
                            nearestB = { name: displayName, dist: d, type: typeLabel };
                        }
                    }
                }
            });
            if (nearestB) out.building = nearestB;
        }

        if (jsonN && jsonN.elements && jsonN.elements.length > 0) {
            var nearestN = null;
            var minDistN = Infinity;
            jsonN.elements.forEach(function(el) {
                var elLat = el.lat;
                var elLon = el.lon;
                if ((!elLat || !elLon) && el.center) {
                    elLat = el.center.lat;
                    elLon = el.center.lon;
                }
                if (elLat && elLon) {
                    // skip elements not currently visible on the map
                    try {
                        var pt2 = L.latLng(elLat, elLon);
                        if (map && map.getBounds && !map.getBounds().contains(pt2)) return;
                    } catch (e) {}
                    var d = latlng.distanceTo(L.latLng(elLat, elLon));
                    if (d < minDistN) {
                        // only include named elements
                        if (el.tags && el.tags.name) {
                            minDistN = d;
                            var displayName = el.tags.name;
                            var typeLabel = getTypeFromTags(el.tags, false) || 'Place';
                            nearestN = { name: displayName, dist: d, type: typeLabel };
                        }
                    }
                }
            });
            if (nearestN) out.poi = nearestN;
        }

        // If both are null, try Nominatim for a fallback name (address/display)
        if (!out.building && !out.poi) {
            return reverseGeocodeName(latlng).then(function(r) {
                if (r) out.poi = r;
                return out;
            }).catch(function() { return out; });
        }

        // If building exists but poi doesn't, attempt reverse geocode for poi (address)
        if (out.building && !out.poi) {
            return reverseGeocodeName(latlng).then(function(r) {
                if (r) out.poi = r;
                return out;
            }).catch(function() { return out; });
        }

        return out;
    }).catch(function() { return { building: null, poi: null }; });
}

// Fallback: use Nominatim reverse geocoding to get a nearby display name
function reverseGeocodeName(latlng) {
    var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' + latlng.lat + '&lon=' + latlng.lng;
    return fetch(url).then(function(resp) {
        if (!resp.ok) return null;
        return resp.json();
    }).then(function(data) {
        if (!data) return null;
        if (data.name) return { name: data.name, dist: 0 };
        if (data.display_name) return { name: data.display_name, dist: 0 };
        return null;
    }).catch(function() { return null; });
}

function addPinToList(id, name, marker) {
    if (!pinListContainer) return;

    // remove the placeholder 'No hazards listed yet.' when first item is added
    var firstPlaceholder = pinListContainer.querySelector('.muted');
    if (firstPlaceholder) firstPlaceholder.remove();

    var item = document.createElement('div');
    item.className = 'pin-item';
    item.setAttribute('data-pin-id', id);
    // make the item focusable for keyboard users so hover-style reveal also works with focus
    item.setAttribute('tabindex', '0');

    // delete button (placed on the left)
    var del = document.createElement('button');
    del.className = 'pin-delete';
    del.setAttribute('aria-label', 'Delete pin ' + name);
    del.innerHTML = '<svg class="icon-trash" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M9 3h6a1 1 0 0 1 1 1v2h4a1 1 0 1 1 0 2h-1.05l-1.02 12.24A3 3 0 0 1 15.94 23H8.06a3 3 0 0 1-2.99-2.76L4.05 8H3a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1Zm1 3h4V5h-4v1ZM6.06 8l.97 11.64A1 1 0 0 0 8.06 21h7.88a1 1 0 0 0 1.03-.96L18.94 8H6.06ZM10 10a1 1 0 0 1 1 1v7a1 1 0 1 1-2 0v-7a1 1 0 0 1 1-1Zm4 0a1 1 0 0 1 1 1v7a1 1 0 1 1-2 0v-7a1 1 0 0 1 1-1Z"/></svg>';
    del.style.marginRight = '8px';
    del.addEventListener('click', function(ev) {
        ev.stopPropagation();
        openDeleteDialog(function(confirmed){
            if (!confirmed) return;
            try { marker.remove(); } catch (e) { if (map.hasLayer(marker)) map.removeLayer(marker); }
            delete pins[id];
            if (item.parentNode) item.parentNode.removeChild(item);
            savePins();
            if (supabase) {
                supabase.from('pins').delete().eq('id', id).then(function(r){ if(r.error) console.warn('Supabase delete failed:', r.error); });
            }
        });
    });
    item.appendChild(del);

    var label = document.createElement('span');
    label.className = 'pin-label';
    label.textContent = name;
    item.appendChild(label);

    // find nearest landmark to this marker using Overpass (async)
    var landmarkSpan = document.createElement('span');
    landmarkSpan.className = 'pin-landmark';
    landmarkSpan.textContent = 'Searching...';
    // color handled via CSS
    // do the async lookup and update the UI when ready
    (function(marker, landmarkSpan) {
        var latlng = marker.getLatLng();
        getBuildingAndPOI(latlng, 400).then(function(res) {
            if (!res) {
                landmarkSpan.textContent = 'No landmark';
                return;
            }
            var parts = [];
            if (res.building && res.building.name) {
                parts.push((res.building.type || 'Building') + ': ' + res.building.name + ' (' + Math.round(res.building.dist) + ' m)');
            }
            if (res.poi && res.poi.name) {
                // avoid duplicating same label
                var poiLabel = res.poi.name;
                if (!res.building || (res.building.name !== poiLabel)) {
                    parts.push('Nearest: ' + (res.poi.type || 'Place') + ': ' + poiLabel + ' (' + Math.round(res.poi.dist) + ' m)');
                }
            }
            if (parts.length === 0) {
                landmarkSpan.textContent = 'No nearby named landmark';
            } else {
                landmarkSpan.textContent = parts.join(' • ');
            }
                try {
                    var pinEntry = pins[id] || pins[row && row.id] || null; // best-effort lookup
                    var mk = pinEntry ? pinEntry.marker : marker;
                    var nmNow = pinEntry ? pinEntry.name : name;
                    if (mk) mk.bindPopup(renderPopupContent(nmNow, landmarkSpan.textContent, mk.getLatLng()));
                } catch (e) {}
        }).catch(function() {
            landmarkSpan.textContent = 'No landmark';
        });
    })(marker, landmarkSpan);
    // landmark info goes on the right
    var controls = document.createElement('span');
    controls.style.float = 'right';
    controls.appendChild(landmarkSpan);
    item.appendChild(controls);

    // click list item to pan to marker and open popup
    item.addEventListener('click', function() {
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 16));
        marker.openPopup();
    });

    pinListContainer.appendChild(item);
}

function updatePinNameInList(id, newName) {
    if (!pinListContainer) return;
    var item = pinListContainer.querySelector('[data-pin-id="' + id + '"]');
    if (item) {
        var label = item.querySelector('.pin-label');
        if (label) label.textContent = newName;
    }
}

// Delete confirmation dialog helpers
function openDeleteDialog(onDone) {
    var dlg = document.getElementById('delete-dialog');
    var btnConfirm = document.getElementById('delete-dialog-confirm');
    var btnCancel = document.getElementById('delete-dialog-cancel');
    if (!dlg || !btnConfirm || !btnCancel) { onDone && onDone(false); return; }
    dlg.hidden = false; dlg.setAttribute('aria-hidden', 'false');
    var close = function(result){ dlg.hidden = true; dlg.setAttribute('aria-hidden', 'true'); onDone && onDone(result); };
    btnConfirm.onclick = function(){ close(true); };
    btnCancel.onclick = function(){ close(false); };
    document.addEventListener('keydown', function esc(e){ if(e.key==='Escape'){ document.removeEventListener('keydown', esc); close(false); } });
    document.querySelector('#delete-dialog .name-dialog-backdrop').onclick = function(){ close(false); };
}

// Lightweight name dialog helpers
function initNameDialog() {
    var dlg = document.getElementById('name-dialog');
    var input = document.getElementById('name-dialog-input');
    var btnSave = document.getElementById('name-dialog-save');
    var btnCancel = document.getElementById('name-dialog-cancel');
    if (!dlg || !input || !btnSave || !btnCancel) return;
    // close on Esc or backdrop click
    document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeNameDialog(null); });
    document.querySelector('.name-dialog-backdrop').addEventListener('click', function(){ closeNameDialog(null); });
}

var _nameDialogResolver = null;
function openNameDialog(initialValue, onDone) {
    var dlg = document.getElementById('name-dialog');
    var input = document.getElementById('name-dialog-input');
    var btnSave = document.getElementById('name-dialog-save');
    var btnCancel = document.getElementById('name-dialog-cancel');
    if (!dlg || !input || !btnSave || !btnCancel) { onDone && onDone(initialValue || ''); return; }
    dlg.hidden = false; dlg.setAttribute('aria-hidden', 'false');
    input.value = initialValue || '';
    setTimeout(function(){ input.focus(); input.select(); }, 50);
    _nameDialogResolver = onDone;
    btnSave.onclick = function(){ closeNameDialog(input.value); };
    btnCancel.onclick = function(){ closeNameDialog(null); };
}

function closeNameDialog(result) {
    var dlg = document.getElementById('name-dialog');
    if (dlg) { dlg.hidden = true; dlg.setAttribute('aria-hidden', 'true'); }
    var cb = _nameDialogResolver; _nameDialogResolver = null;
    if (cb) cb(result);
}
