// Create map centered on the Philippines
var map = L.map('map').setView([12.8797, 121.7740], 6);

// Tile layer
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Add pin on click
map.on('click', function(e) {
    L.marker([e.latlng.lat, e.latlng.lng]).addTo(map);
});
