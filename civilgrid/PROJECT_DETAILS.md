# CivilGrid — City of Los Angeles CIP & EV Charger Map

A React + TypeScript web application built for the City of Los Angeles to identify opportunities for upgrading EV charger capacity alongside existing Capital Improvement Projects (CIP). The core insight is that performing both pieces of work at the same time — when a street or area is already disrupted — saves the city significant cost and reduces inconvenience to residents.

---

## Local Development

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

**Prerequisites:** Node.js v16 or higher (`node -v` to check).

---

## Deployment

### Netlify

1. Push this repo to GitHub
2. Connect the repo in Netlify
3. Build command: `npm run build`
4. Publish directory: `build`

A `netlify.toml` is already included with the correct configuration.

No backend or server is required — the app is fully static.

---

## Libraries Used

| Library        | Version | Purpose                                                                         |
| -------------- | ------- | ------------------------------------------------------------------------------- |
| **React**      | 18      | UI framework — component rendering, state, and lifecycle                        |
| **TypeScript** | 4.9     | Static typing across the entire codebase                                        |
| **Leaflet**    | 1.9     | Interactive map rendering, tile layers, GeoJSON overlays, and marker management |
| **Bootstrap**  | 5.3     | Base CSS reset and utility classes (spinner, layout helpers)                    |

> No external geospatial library (e.g. Turf.js) is used. The proximity detection logic — point-in-polygon and haversine distance — is implemented from scratch to keep the bundle lean and avoid unnecessary dependencies.

---

## Data Loading

Both datasets are GeoJSON `FeatureCollection` files placed in the `/public` directory, which makes them available as static assets served directly by the development server (or CDN in production). No API or backend is involved.

```
public/
  cip_projects.json   — 773 Capital Improvement Project features
  ev_chargers.json    — 414 EV charger point features
```

They are fetched in parallel on app mount using `Promise.all`:

```tsx
useEffect(() => {
	Promise.all([fetch("/cip_projects.json").then((r) => r.json()), fetch("/ev_chargers.json").then((r) => r.json())]).then(([cip, ev]) => {
		setCipData(cip);
		setEvData(ev);
		setLoading(false);
	});
}, []);
```

Using `Promise.all` ensures both datasets are fully loaded before any processing begins. The `loading` flag stays `true` until both resolve, keeping the UI in a spinner state and — critically — preventing the map from attempting to render before the data and DOM are both ready (more on this below).

---

## Application Flow After Data Loads

Once both datasets are loaded and `loading` flips to `false`, the following sequence happens:

### 1. Synergy Detection (`useMemo`)

The first thing computed is a `Map<projectId, EVFeature[]>` called `evCountPerCIP`. For every CIP project, it checks every EV charger and records which ones fall within or near that project's area. This runs once and is cached — it is the most computationally expensive step (773 × 414 = ~320,000 comparisons) so `useMemo` ensures it never re-runs unnecessarily.

### 2. Map Initialisation (`useEffect` depending on `loading`)

The Leaflet map is initialised after `loading` becomes `false`. A CartoDB Light tile layer is added as the base map. A `ResizeObserver` is attached to the map container to call `map.invalidateSize()` whenever the container's dimensions change, ensuring the map always fills its space correctly.

### 3. EV Markers Drawn (`useEffect` depending on `evData`)

All 414 EV chargers are drawn as small green circular markers on the map. Each marker is stored in a `Map<OBJECTID, L.Marker>` ref so individual markers can be looked up and restyled in O(1) time when a project is selected.

### 4. CIP Polygons Drawn (`useEffect` depending on `cipData` and `evCountPerCIP`)

All 773 CIP project geometries are drawn using `L.geoJSON`. Projects that have nearby EV chargers are coloured **amber**, and projects with no nearby chargers are coloured **blue**. Each polygon gets a click handler that calls `selectProject`.

### 5. Filtering (derived from state via `useMemo`)

The sidebar table/card list is driven by `filteredCIP`, which re-derives from four filter states: `searchQuery`, `phaseFilter`, `programFilter`, and `nearEVChargerOnly`. Filters are independent and stack — all four can be active simultaneously.

### 6. Project Selection (`selectProject` via `useCallback`)

When a user clicks a table row, a card, or a map polygon, `selectProject` is called with that project's ID. It:

- Resets the previously selected project's polygon style and EV marker icons back to their defaults
- Styles the newly selected polygon in purple
- Switches any nearby EV markers to amber highlight icons
- Calls `map.flyTo()` on the project's centroid for a smooth animated pan and zoom
- Updates `selectedId` state, which triggers the detail panel to render over the map

Clicking the same project again deselects it (toggle behaviour).

---

## TypeScript Models

### `CIPProperties`

Represents the `properties` object of each CIP GeoJSON feature. The fields typed here are:

- `ProjectTitle`, `ProgramName`, `ProjectNumber` — display and search fields
- `ActivePhaseName`, `CurrentPhaseDescription`, `CurrentPhasePercentComplete` — project lifecycle tracking
- `ConstructionCost` — used for display and could support future cost-based filtering
- `ConsStartDate`, `ConsEndDate`, `StartDate`, `EndDate` — stored as Unix timestamps (milliseconds); formatted via `formatDate()` for display
- `PM_Name`, `PM_Phone`, `PM_EMail` — project manager contact details shown in the detail panel
- `CouncilDistrict` — governance context for city staff

Typing this interface explicitly catches bugs at compile time — for example, accidentally treating a numeric timestamp as a string — and makes the shape of the data visible without having to inspect the raw JSON.

### `EVProperties`

Represents the `properties` of each EV charger feature. The EV dataset is notably sparse — most properties (`slid`, `lat`, `lon`, `Date_Imported`, `TOOLTIP`) are `null` in the raw data. They are typed explicitly rather than left as `any` to document this intentionally and make it easy to extend if the dataset is enriched later.

### `GeoJSONFeature<G, P>` and `FeatureCollection<G, P>`

Generic wrapper types for GeoJSON structures. Making them generic means the same shape can express both a polygon feature with `CIPProperties` and a point feature with `EVProperties` without duplicating the structure. This mirrors the GeoJSON spec while giving TypeScript full visibility into what `geometry` and `properties` contain.

### `CIPFeature` and `EVFeature`

Type aliases that pin the generics:

```ts
type CIPFeature = GeoJSONFeature<GeoJSON.Geometry, CIPProperties>;
type EVFeature = GeoJSONFeature<GeoJSON.Point, EVProperties>;
```

`CIPFeature` uses `GeoJSON.Geometry` (rather than `GeoJSON.Polygon`) because CIP projects appear as multiple geometry types in the dataset — Polygons, MultiPolygons, Points, and LineStrings. `EVFeature` is pinned to `GeoJSON.Point` because EV chargers are always point locations, which lets the code safely destructure `coordinates` as `[lon, lat]` without a type guard.

---

## Map Rendering Issue and How It Was Resolved

### The Problem

On manual page reloads, the map area would appear as a blank white box with no tiles and no error in the console.

### Root Cause: Effect Timing vs. Conditional Rendering

The root cause was a mismatch between **when the `useEffect` ran** and **when the map `<div>` existed in the DOM**.

The app conditionally renders either a loading spinner or the full layout:

```tsx
if (loading) {
  return <LoadingSpinner />;  // map div does NOT exist here
}

return (
  <div className="app-shell">
    ...
    <div ref={mapElRef} ... />  // map div only exists here
  </div>
);
```

The map init `useEffect` originally had an empty dependency array (`[]`), which means React runs it once — on the component's first mount. But on the first mount, `loading` is `true` and the loading spinner is rendered, not the map div. So when the effect ran, `mapElRef.current` was `null`, the effect bailed out early, and Leaflet was never initialised.

When `loading` later flipped to `false` and the map div appeared, the effect did **not** re-run because its dependency array was empty.

This is why it worked inconsistently: if the data happened to load fast enough on a warm cache, the component could mount with `loading` already `false`, making the first render the full layout — and the effect would find the map div. But on a cold reload with slower network, `loading` started as `true` and the effect missed the div.

### The Fix

Adding `loading` to the dependency array ensures the effect re-runs exactly when `loading` flips to `false` — which is precisely when the map div enters the DOM:

```tsx
useEffect(() => {
	if (loading) return; // map div not rendered yet, nothing to initialise

	const container = mapElRef.current;
	if (!container) return;

	// ... Leaflet init ...

	const ro = new ResizeObserver(() => {
		map.invalidateSize();
	});
	ro.observe(container);

	return () => {
		ro.disconnect();
		map.remove();
		mapRef.current = null;
	};
}, [loading]); // re-runs when loading flips to false
```

A `ResizeObserver` is also attached to the container instead of a one-shot `requestAnimationFrame`. This means `invalidateSize()` is called whenever the container's dimensions actually settle — including the initial layout paint, sidebar width calculations, and window resizes — rather than hoping a single animation frame is enough.

### Why Not Restructure the Conditional Render?

An alternative fix would be to always keep the map div mounted (even during loading) and hide it with CSS. That would let the empty-dependency-array effect work. However, keeping the current structure is cleaner — the loading state and the app state are genuinely separate, the map div has no reason to exist before data is ready, and explicitly depending on `loading` makes the relationship between data readiness and DOM readiness visible and intentional.

---

## Key Architectural Decisions

**No external geospatial library.** Turf.js was considered but not used. The two algorithms needed — ray-casting point-in-polygon and haversine distance — are well-understood, short to implement, and sufficient for this dataset. Avoiding the dependency keeps the bundle smaller and removes a potential version conflict surface.

**Leaflet managed entirely via refs, not React state.** Leaflet is imperative — it manages its own internal DOM. Storing the map instance, layer references, and marker references in `useRef` keeps them out of React's render cycle. This means map updates (style changes, marker icon swaps, flyTo calls) happen without triggering React re-renders, which is important for performance given 773 polygon layers and 414 markers on screen simultaneously.

**`useMemo` for expensive computations.** The ~320,000 synergy comparisons and the filtered project list are both memoized. This means typing a single character in the search box does not re-run geometry comparisons — it only re-evaluates the lightweight filter predicate against the already-computed synergy map.

**Responsive layout via CSS breakpoints only.** No JavaScript window-width detection or conditional rendering based on screen size is used for layout. CSS media queries handle the switch between the sidebar+map layout (desktop) and the stacked map+cards layout (mobile), keeping the component tree identical across breakpoints and avoiding layout-related re-renders.
