# LA CIP & EV Synergy Finder

A React + TypeScript web application for the City of Los Angeles to identify synergy opportunities between Capital Improvement Projects (CIP) and existing EV charger infrastructure.

## Features

- **Interactive map** showing all 773 CIP project areas and 414 EV charger locations
- **Synergy detection**: automatically identifies EV chargers within or near (≤100 m) each CIP project boundary
- **Sidebar list** with search, phase filter, program filter, and "synergy only" toggle
- **Click a project** to fly to it on the map, highlight nearby EV chargers in amber, and see a detail panel
- **Legend** explaining all map elements
- Color-coded project polygons: blue = CIP only, amber = CIP with EV synergy, purple = selected

## Data

Place both files in `public/`:
- `cip_projects.json` — GeoJSON FeatureCollection of CIP polygons/points
- `ev_chargers.json` — GeoJSON FeatureCollection of EV charger points

## Local Development

```bash
npm install
npm start
```

## Deploy to Netlify

1. Push this repo to GitHub
2. Connect the repo in Netlify
3. Build command: `npm run build`
4. Publish directory: `build`
5. Done — `netlify.toml` is already configured

## Deploy to Render

1. Create a new **Static Site** on Render
2. Build command: `npm install && npm run build`
3. Publish directory: `build`

## Tech Stack

- React 18 + TypeScript
- Leaflet / react-leaflet (map)
- Bootstrap 5 (UI)
- Custom ray-casting point-in-polygon (no external geo lib needed)

## Trade-offs & Notes

- **Proximity buffer**: EV chargers within 100 m of a project boundary are flagged as synergy opportunities (configurable via `BUFFER_M` in `App.tsx`)
- **Performance**: All 773 CIP × 414 EV comparisons run once on load via `useMemo`; no server needed
- **No backend**: fully static — works on Netlify/Render/GitHub Pages
