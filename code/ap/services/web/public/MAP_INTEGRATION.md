# Frontend map integration notes

This directory ships two new GeoJSON files alongside the existing
`taiwan-counties.json`:

- `us-states.geojson` — 56 features (50 states + DC + PR + AS + GU + MP + VI). State id = 2-digit FIPS, properties.name = state name.
- `us-counties.geojson` — 3,231 features. County id = 5-digit FIPS, properties.name = county name (without "County" suffix).

## What needs to change in `PlaybackViewer.tsx` (and any other map components)

The current Taiwan map uses a single-projection / single-layer pattern. The
US case is different in two ways:

1. **Two-tier zoom**. US users will mostly start at the *state* level (50+1
   features) and then drill into a state to see its counties. Recommend a
   simple toggle:
   - Zoomed out → render `us-states.geojson`
   - State selected → render only the counties whose 5-digit FIPS starts with
     that state's 2-digit FIPS, drawn from `us-counties.geojson`
2. **Projection**. Don't reuse Taiwan's plate-carrée. The US (with Alaska and
   Hawaii) needs **Albers USA** (`d3.geoAlbersUsa()`), which inset-projects AK
   and HI into the lower-48 frame. Without it the map will be unusable.

```ts
// pseudocode for d3-geo
import { geoAlbersUsa, geoPath } from 'd3-geo';

const projection = geoAlbersUsa()
  .scale(1300)
  .translate([width / 2, height / 2]);
const path = geoPath(projection);
```

3. **County filtering**. The geojson includes US territories (PR, GU, etc.)
   which the Civatas-USA Stage 1 dataset does not cover. Filter at render time:

   ```ts
   const ALLOWED_STATE_FIPS = new Set([
     "01","02","04","05","06","08","09","10","11","12","13","15","16","17","18",
     "19","20","21","22","23","24","25","26","27","28","29","30","31","32","33",
     "34","35","36","37","38","39","40","41","42","44","45","46","47","48","49",
     "50","51","53","54","55","56",
   ]);
   const usStates = statesGeo.features.filter(f => ALLOWED_STATE_FIPS.has(f.id));
   ```

4. **Country switch**. Drive map source selection from the workspace's
   `country` field (the same field you'll add to the project schema for the
   leaning / prompt switch):

   ```ts
   const mapSrc = workspace.country === "US"
     ? "/us-counties.geojson"
     : "/taiwan-counties.json";
   ```

5. **Connecticut caveat**. The current `us-counties.geojson` still draws
   Connecticut as 8 counties (FIPS `09001..09015`). The Civatas-USA census /
   PVI data already uses the new 9 planning regions (`09110..09190`). For
   Stage 1 this means CT polygons will not match CT data — flag CT as "data
   transitioning" in the UI. Stage 2 fix: replace CT polygons with the
   planning-region shapes from US Census TIGER 2024.

## What does NOT need to change

- The choropleth coloring logic is generic — it just maps `feature.id` to a
  data record.
- The hover / click / tooltip plumbing is generic.

## Files in this directory after applying the overlay

```
ap/services/web/public/
├── taiwan-counties.json    (existing — keep)
├── us-states.geojson       (new)
└── us-counties.geojson     (new)
```
