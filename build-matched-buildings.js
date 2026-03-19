/**
 * Script de pré-calcul : télécharge les bâtiments IGN (BD TOPO) via WFS
 * et fait la correspondance avec les entreprises du PAS.
 *
 * Usage: node build-matched-buildings.js
 * Produit: matched-buildings.js (GeoJSON pré-calculé)
 */

const fs = require('fs');
const https = require('https');

// Load company data
const companiesGeoJSON = require('./data.js'.replace('.js',''));
// data.js uses var, need to eval it
const dataContent = fs.readFileSync(__dirname + '/data.js', 'utf8');
let companiesData, servicesData, sectorsData, domainListData;
eval(dataContent.replace(/^const /gm, 'var ').replace(/^var companiesGeoJSON/,'companiesData').replace(/^var servicesGeoJSON/,'servicesData').replace(/^var sectorsGeoJSON/,'sectorsData').replace(/^var domainList/,'domainListData'));

const companies = companiesData.features;
console.log(`${companies.length} entreprises chargées`);

// Domain config for heights
const heightByDomain = {
  'TRANSPORTS ET LOGISTIQUE':12, 'INDUSTRIE Agroalimentaire':18,
  'INDUSTRIE Automobile':16, 'INDUSTRIE Chimie':20,
  'INDUSTRIE Métallurgie':15, 'INDUSTRIE Papier':14,
  'MATERIAUX DE CONSTRUCTION / BTP':10, 'SERVICES Divers':14,
  'SERVICES Data centers':12, 'SERVICES Services portuaires':8,
  'ENERGIE Production':22, 'ENERGIE Stockage hydrocarbures':25,
  'VALORISATION DECHETS':10, 'CROISIERES et NAUTISME':8,
  "ADMINISTRATIONS et ORGANISMES D'INTERET GENERAL":15
};

// Group companies into bounding boxes (clusters of nearby companies)
function computeBBoxes(features, padding) {
  // Split into small geographic clusters (max 0.01° lat gap ≈ 1km)
  const sorted = [...features].sort((a,b) => a.geometry.coordinates[1] - b.geometry.coordinates[1]);
  const clusters = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = current[current.length - 1];
    const curr = sorted[i];
    // Also split if cluster gets too large (>20 companies)
    if (curr.geometry.coordinates[1] - prev.geometry.coordinates[1] > 0.008 || current.length > 20) {
      clusters.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  clusters.push(current);

  return clusters.map(cluster => {
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    cluster.forEach(f => {
      const [lng, lat] = f.geometry.coordinates;
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    });
    return {
      bbox: [minLng - padding, minLat - padding, maxLng + padding, maxLat + padding],
      companies: cluster
    };
  });
}

// Fetch buildings from IGN WFS
function fetchBuildings(bbox, maxCount = 50000) {
  return new Promise((resolve, reject) => {
    const url = `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
      `&TYPENAMES=BDTOPO_V3:batiment` +
      `&BBOX=${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]},EPSG:4326` +
      `&OUTPUTFORMAT=application/json&COUNT=${maxCount}`;

    console.log(`  WFS: bbox [${bbox.map(v=>v.toFixed(4)).join(', ')}]`);

    let data = '';
    https.get(url, { timeout: 30000 }, res => {
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log(`  → ${json.features.length} bâtiments téléchargés`);
          resolve(json.features);
        } catch(e) {
          console.error('  Parse error:', e.message);
          resolve([]);
        }
      });
    }).on('error', e => {
      console.error('  Fetch error:', e.message);
      resolve([]);
    });
  });
}

// Point-in-polygon test (ray casting)
function pointInPolygon(point, polygon) {
  const [px, py] = point;
  // Handle MultiPolygon
  const rings = polygon.type === 'MultiPolygon'
    ? polygon.coordinates.reduce((acc, poly) => acc.concat(poly), [])
    : polygon.coordinates;

  for (const ring of rings) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

// Find nearest building to a point (within max distance in degrees)
function findNearestBuilding(point, buildings, maxDist) {
  let best = null;
  let bestDist = maxDist;

  // First try exact point-in-polygon
  for (const bldg of buildings) {
    if (pointInPolygon(point, bldg.geometry)) {
      return bldg;
    }
  }

  // Then try nearest centroid
  for (const bldg of buildings) {
    const coords = bldg.geometry.type === 'MultiPolygon'
      ? bldg.geometry.coordinates[0][0]
      : bldg.geometry.coordinates[0];

    // Compute centroid
    let cx = 0, cy = 0;
    for (const [x, y] of coords) { cx += x; cy += y; }
    cx /= coords.length; cy /= coords.length;

    const dist = Math.sqrt((cx - point[0]) ** 2 + (cy - point[1]) ** 2);
    if (dist < bestDist) {
      bestDist = dist;
      best = bldg;
    }
  }

  return best;
}

// Simplify polygon coordinates to reduce file size
function simplifyCoords(coords, tolerance) {
  if (coords.length <= 4) return coords;
  // Douglas-Peucker simplified: just round to 6 decimal places
  return coords.map(c => [
    Math.round(c[0] * 1000000) / 1000000,
    Math.round(c[1] * 1000000) / 1000000
  ]);
}

function simplifyGeometry(geom) {
  if (geom.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geom.coordinates.map(poly => poly.map(ring => simplifyCoords(ring)))
    };
  }
  return {
    type: 'Polygon',
    coordinates: geom.coordinates.map(ring => simplifyCoords(ring))
  };
}

// Main
async function main() {
  const clusters = computeBBoxes(companies, 0.003);
  console.log(`${clusters.length} clusters géographiques détectés\n`);

  const allBuildings = [];
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    console.log(`Cluster ${i+1}/${clusters.length}: ${cluster.companies.length} entreprises`);
    const buildings = await fetchBuildings(cluster.bbox);
    allBuildings.push({ buildings, companies: cluster.companies });
  }

  console.log(`\nCorrespondance entreprises → bâtiments...`);

  const matchedFeatures = [];
  let matchCount = 0;
  let missCount = 0;
  // Track buildings with multiple occupants
  const buildingMap = new Map(); // geomKey → {feature, companyIds}

  for (const { buildings, companies: clusterCompanies } of allBuildings) {
    for (const company of clusterCompanies) {
      const coords = company.geometry.coordinates;
      const building = findNearestBuilding(coords, buildings, 0.005);

      if (building) {
        const geomKey = JSON.stringify(building.geometry.coordinates[0]?.[0]?.slice(0,2) || building.geometry.coordinates[0][0][0]?.slice(0,2));

        if (buildingMap.has(geomKey)) {
          // Additional occupant in same building
          const entry = buildingMap.get(geomKey);
          entry.companyIds.push(company.properties.id);
          entry.feature.properties._occupants = entry.companyIds.length;
        } else {
          // New building match
          const props = { ...company.properties };
          props._height = building.properties.hauteur || heightByDomain[company.properties.domaine] || 12;
          props._usage = building.properties.usage_1 || '';
          props._occupants = 1;

          const feature = {
            type: 'Feature',
            geometry: simplifyGeometry(building.geometry),
            properties: props
          };
          buildingMap.set(geomKey, { feature, companyIds: [company.properties.id] });
          matchedFeatures.push(feature);
        }
        matchCount++;
      } else {
        missCount++;
        // No fallback cube — circles layer handles unmatched companies
      }
    }
  }

  console.log(`\nRésultat:`);
  console.log(`  ${matchCount} entreprises → bâtiment IGN trouvé`);
  console.log(`  ${missCount} entreprises → cube fallback (pas de bâtiment proche)`);
  console.log(`  ${matchedFeatures.length} polygones au total`);

  const multiOccupant = [...buildingMap.values()].filter(v => v.companyIds.length > 1);
  console.log(`  ${multiOccupant.length} bâtiments multi-occupants`);

  // Collect all matched company IDs (including multi-occupants)
  const allMatchedIds = [];
  for (const entry of buildingMap.values()) {
    allMatchedIds.push(...entry.companyIds);
  }

  const geojson = { type: 'FeatureCollection', features: matchedFeatures };
  const output = 'var matchedBuildingsGeoJSON = ' + JSON.stringify(geojson) + ';\n' +
    'var matchedCompanyIds = new Set(' + JSON.stringify(allMatchedIds) + ');\n';

  const outPath = __dirname + '/matched-buildings.js';
  fs.writeFileSync(outPath, output);
  const sizeKB = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`\nÉcrit: matched-buildings.js (${sizeKB} KB)`);
}

main().catch(console.error);
