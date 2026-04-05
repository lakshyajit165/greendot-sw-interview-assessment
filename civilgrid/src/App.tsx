import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./index.css";

// ── Types ──────────────────────────────────────────────────────────────────

interface CIPProperties {
	OBJECTID: number;
	PROJECTID: number;
	ProjectTitle: string;
	ProgramName: string;
	WO_Status: string;
	PM_Name: string;
	PM_Phone: string;
	PM_EMail: string;
	CouncilDistrict: string;
	ConstructionCost: number;
	ProjectNumber: string;
	CurrentPhaseDescription: string;
	CurrentPhasePercentComplete: number;
	ActivePhaseName: string;
	ConsStartDate: number;
	ConsEndDate: number;
	StartDate: number;
	EndDate: number;
	ConstPercComp: number;
}

interface EVProperties {
	OBJECTID: number;
	slid: string | null;
	Date_Imported: string | null;
	TOOLTIP: string | null;
}

interface GeoJSONFeature<G, P> {
	type: "Feature";
	id: number;
	geometry: G;
	properties: P;
}

interface FeatureCollection<G, P> {
	type: "FeatureCollection";
	features: GeoJSONFeature<G, P>[];
}

type CIPFeature = GeoJSONFeature<GeoJSON.Geometry, CIPProperties>;
type EVFeature = GeoJSONFeature<GeoJSON.Point, EVProperties>;

// ── Helpers ────────────────────────────────────────────────────────────────

function formatCurrency(n: number): string {
	if (!n) return "—";
	if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
	return `$${n}`;
}

function formatDate(ts: number | null): string {
	if (!ts) return "—";
	return new Date(ts).toLocaleDateString("en-US", { year: "numeric", month: "short" });
}

function phaseColor(phase: string): string {
	const p = (phase || "").toLowerCase();
	if (p.includes("design")) return "#6366f1";
	if (p.includes("construct")) return "#f59e0b";
	if (p.includes("close")) return "#10b981";
	return "#6b7280";
}

function pointInPolygon(point: [number, number], vs: [number, number][]): boolean {
	const [x, y] = point;
	let inside = false;
	for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
		const xi = vs[i][0],
			yi = vs[i][1];
		const xj = vs[j][0],
			yj = vs[j][1];
		// eslint-disable-next-line no-mixed-operators
		const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371000;
	const f1 = (lat1 * Math.PI) / 180,
		f2 = (lat2 * Math.PI) / 180;
	const df = ((lat2 - lat1) * Math.PI) / 180;
	const dl = ((lon2 - lon1) * Math.PI) / 180;
	const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function polygonCentroid(coords: [number, number][][]): [number, number] {
	const ring = coords[0];
	let lat = 0,
		lon = 0;
	ring.forEach(([lo, la]) => {
		lon += lo;
		lat += la;
	});
	return [lat / ring.length, lon / ring.length];
}

function getCentroid(geometry: GeoJSON.Geometry): [number, number] | null {
	if (geometry.type === "Point") return [(geometry.coordinates as number[])[1], (geometry.coordinates as number[])[0]];
	if (geometry.type === "Polygon") return polygonCentroid(geometry.coordinates as [number, number][][]);
	if (geometry.type === "MultiPolygon") return polygonCentroid((geometry.coordinates as [number, number][][][])[0]);
	if (geometry.type === "LineString") {
		const c = geometry.coordinates as [number, number][];
		const mid = c[Math.floor(c.length / 2)];
		return [mid[1], mid[0]];
	}
	return null;
}

const BUFFER_M = 100;

function evNearCIP(ev: EVFeature, cip: CIPFeature): boolean {
	const [evLon, evLat] = ev.geometry.coordinates;
	const geom = cip.geometry;
	if (geom.type === "Polygon") {
		if (pointInPolygon([evLon, evLat], (geom.coordinates as [number, number][][])[0])) return true;
		const [cLat, cLon] = polygonCentroid(geom.coordinates as [number, number][][]);
		return haversine(evLat, evLon, cLat, cLon) < BUFFER_M;
	}
	if (geom.type === "MultiPolygon") {
		for (const poly of geom.coordinates as [number, number][][][]) {
			if (pointInPolygon([evLon, evLat], poly[0])) return true;
			const [cLat, cLon] = polygonCentroid([poly[0]]);
			if (haversine(evLat, evLon, cLat, cLon) < BUFFER_M) return true;
		}
		return false;
	}
	if (geom.type === "Point") {
		const [cLon, cLat] = geom.coordinates as [number, number];
		return haversine(evLat, evLon, cLat, cLon) < BUFFER_M;
	}
	if (geom.type === "LineString") {
		for (const [pLon, pLat] of geom.coordinates as [number, number][]) if (haversine(evLat, evLon, pLat, pLon) < BUFFER_M) return true;
		return false;
	}
	return false;
}

const evNormalIcon = L.divIcon({
	className: "",
	html: `<div style="width:9px;height:9px;background:#16a34a;border:2px solid white;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.4)"></div>`,
	iconSize: [9, 9],
	iconAnchor: [4, 4],
});
const evHighlightIcon = L.divIcon({
	className: "",
	html: `<div style="width:13px;height:13px;background:#f59e0b;border:2px solid white;border-radius:50%;box-shadow:0 1px 5px rgba(0,0,0,0.5)"></div>`,
	iconSize: [13, 13],
	iconAnchor: [6, 6],
});

// ── App ────────────────────────────────────────────────────────────────────

const App: React.FC = () => {
	const mapRef = useRef<L.Map | null>(null);
	const mapElRef = useRef<HTMLDivElement>(null);
	const cipLayers = useRef<Map<number, L.GeoJSON>>(new Map());
	const evMarkers = useRef<Map<number, L.Marker>>(new Map());

	const [cipData, setCipData] = useState<FeatureCollection<GeoJSON.Geometry, CIPProperties> | null>(null);
	const [evData, setEvData] = useState<FeatureCollection<GeoJSON.Point, EVProperties> | null>(null);
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [phaseFilter, setPhaseFilter] = useState("All");
	const [programFilter, setProgramFilter] = useState("All");
	const [nearEVChargerOnly, setNearEVChargerOnly] = useState(false);
	const [loading, setLoading] = useState(true);

	// Load data
	useEffect(() => {
		Promise.all([fetch("/cip_projects.json").then((r) => r.json()), fetch("/ev_chargers.json").then((r) => r.json())]).then(([cip, ev]) => {
			setCipData(cip);
			setEvData(ev);
			setLoading(false);
		});
	}, []);

	// ev Count per project
	const evCountPerCIP = useMemo(() => {
		if (!cipData || !evData) return new Map<number, EVFeature[]>();
		const map = new Map<number, EVFeature[]>();
		for (const cip of cipData.features) {
			const nearby = evData.features.filter((ev) => evNearCIP(ev, cip));
			if (nearby.length > 0) map.set(cip.id, nearby);
		}
		return map;
	}, [cipData, evData]);

	// Filter options
	const phases = useMemo(() => {
		if (!cipData) return [] as string[];
		return Array.from(new Set(cipData.features.map((f) => f.properties.ActivePhaseName || f.properties.CurrentPhaseDescription || "Other").filter(Boolean))).sort();
	}, [cipData]);

	const programs = useMemo(() => {
		if (!cipData) return [] as string[];
		return Array.from(new Set(cipData.features.map((f) => f.properties.ProgramName).filter(Boolean))).sort();
	}, [cipData]);

	// Filtered list
	const filteredCIP = useMemo(() => {
		if (!cipData) return [];
		return cipData.features.filter((f) => {
			const q = searchQuery.toLowerCase();
			if (q && !f.properties.ProjectTitle?.toLowerCase().includes(q) && !f.properties.ProgramName?.toLowerCase().includes(q) && !f.properties.ProjectNumber?.toLowerCase().includes(q))
				return false;
			const phase = f.properties.ActivePhaseName || f.properties.CurrentPhaseDescription || "Other";
			if (phaseFilter !== "All" && phase !== phaseFilter) return false;
			if (programFilter !== "All" && f.properties.ProgramName !== programFilter) return false;
			if (nearEVChargerOnly && !evCountPerCIP.has(f.id)) return false;
			return true;
		});
	}, [cipData, searchQuery, phaseFilter, programFilter, nearEVChargerOnly, evCountPerCIP]);

	// Selected feature (for detail panel)
	const selectedFeature = useMemo(() => (selectedId !== null ? (cipData?.features.find((f) => f.id === selectedId) ?? null) : null), [selectedId, cipData]);

	// Init map
	/**
	 * Depends on `loading` intentionally — the map div is only rendered after loading
	 * completes, so the effect must re-run once `loading` flips to false to find
	 * a valid container ref. Running on mount alone (empty deps) would bail out
	 * every time because mapElRef.current is null during the loading screen.
	 */
	useEffect(() => {
		if (loading) return; // data not ready yet, map div not rendered

		const container = mapElRef.current;

		if (!container) return;

		if (mapRef.current) {
			mapRef.current.remove();
			mapRef.current = null;
		}

		const map = L.map(container, { center: [34.05, -118.25], zoom: 11 });
		L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
			attribution: "&copy; OpenStreetMap &copy; CARTO",
			maxZoom: 19,
		}).addTo(map);
		mapRef.current = map;

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

	// Draw EV markers
	useEffect(() => {
		if (!mapRef.current || !evData) return;
		evMarkers.current.forEach((m) => m.remove());
		evMarkers.current.clear();
		evData.features.forEach((ev) => {
			const [lon, lat] = ev.geometry.coordinates;
			const m = L.marker([lat, lon], { icon: evNormalIcon }).addTo(mapRef.current!);
			evMarkers.current.set(ev.properties.OBJECTID, m);
		});
	}, [evData]);

	// Draw CIP polygons
	useEffect(() => {
		if (!mapRef.current || !cipData) return;
		cipLayers.current.forEach((l) => l.remove());
		cipLayers.current.clear();
		cipData.features.forEach((feature) => {
			const hasNearbyEVCharger = evCountPerCIP.has(feature.id);
			try {
				const layer = L.geoJSON(feature as any, {
					style: {
						color: hasNearbyEVCharger ? "#f59e0b" : "#3b82f6",
						weight: hasNearbyEVCharger ? 2.5 : 1.5,
						fillColor: hasNearbyEVCharger ? "#fef3c7" : "#dbeafe",
						fillOpacity: 0.4,
					},
				});
				layer.on("click", () => selectProject(feature.id));
				layer.addTo(mapRef.current!);
				cipLayers.current.set(feature.id, layer);
			} catch (_) {}
		});
	}, [cipData, evCountPerCIP]); // eslint-disable-line

	// Select / deselect a project
	const selectProject = useCallback(
		(id: number | null) => {
			setSelectedId((prev) => {
				// Reset previous
				if (prev !== null) {
					const old = cipLayers.current.get(prev);
					if (old) {
						const s = evCountPerCIP.has(prev);
						old.setStyle({ color: s ? "#f59e0b" : "#3b82f6", weight: s ? 2.5 : 1.5, fillColor: s ? "#fef3c7" : "#dbeafe", fillOpacity: 0.4 });
					}
					(evCountPerCIP.get(prev) || []).forEach((ev) => evMarkers.current.get(ev.properties.OBJECTID)?.setIcon(evNormalIcon));
				}

				const next = prev === id ? null : id;

				if (next !== null) {
					cipLayers.current.get(next)?.setStyle({ color: "#7c3aed", weight: 3, fillColor: "#ede9fe", fillOpacity: 0.6 });
					(evCountPerCIP.get(next) || []).forEach((ev) => evMarkers.current.get(ev.properties.OBJECTID)?.setIcon(evHighlightIcon));
					const feature = cipData?.features.find((f) => f.id === next);
					if (feature) {
						const c = getCentroid(feature.geometry);
						if (c && mapRef.current) mapRef.current.flyTo(c, 15, { duration: 0.7 });
					}
				}

				return next;
			});
		},
		[cipData, evCountPerCIP],
	);

	// ── Render ──────────────────────────────────────────────────────────────

	if (loading) {
		return (
			<div className="loading-screen">
				<div style={{ textAlign: "center" }}>
					<div className="spinner-border text-primary mb-2" role="status" />
					<p style={{ color: "#6c757d", fontSize: "0.85rem", margin: 0 }}>Loading data…</p>
				</div>
			</div>
		);
	}

	const legendItems = [
		{ bg: "#dbeafe", border: "#3b82f6", label: "CIP Project" },
		{ bg: "#fef3c7", border: "#f59e0b", label: "CIP + EV ⚡" },
		{ bg: "#ede9fe", border: "#7c3aed", label: "Selected" },
	];

	return (
		<div className="app-shell">
			{/* ── Header ── */}
			<header className="app-header">
				<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
					<rect width="26" height="26" rx="5" fill="#FFD700" />
					<text x="13" y="18" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#1e3a5f">
						CG
					</text>
				</svg>
				<span className="logo-text">CivilGrid</span>
				<span className="logo-sub">City of Los Angeles | CIP &amp; EV Charger Map</span>
			</header>

			{/* ── Body ── */}
			<div className="app-body">
				{/* ── Sidebar: filters + list ── */}
				<div className="sidebar">
					{/* Filters */}
					<div className="filter-bar">
						<input type="text" placeholder="Search title, program, number…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} aria-label="Search projects" />
						<div className="filter-row">
							<select value={phaseFilter} onChange={(e) => setPhaseFilter(e.target.value)} aria-label="Filter by phase">
								<option value="All">All Phases</option>
								{phases.map((p) => (
									<option key={p}>{p}</option>
								))}
							</select>
							<select value={programFilter} onChange={(e) => setProgramFilter(e.target.value)} aria-label="Filter by program">
								<option value="All">All Programs</option>
								{programs.map((p) => (
									<option key={p}>{p}</option>
								))}
							</select>
						</div>
						<div className="filter-row" style={{ justifyContent: "space-between" }}>
							<label className="neary-ev-charger-check">
								<input type="checkbox" checked={nearEVChargerOnly} onChange={(e) => setNearEVChargerOnly(e.target.checked)} />
								Near EV charger ⚡
							</label>
							<span className="filter-stats">
								{filteredCIP.length} projects · <strong>⚡ {evCountPerCIP.size} w/ EV</strong>
							</span>
						</div>
					</div>

					{/* Desktop / Tablet: Table */}
					<div className="table-wrap" role="region" aria-label="Projects table">
						<table className="data-table">
							<thead>
								<tr>
									<th>Project</th>
									<th className="col-phase">Phase</th>
									<th>Cost</th>
									<th>EV</th>
									<th className="col-pm">PM</th>
								</tr>
							</thead>
							<tbody>
								{filteredCIP.length === 0 && (
									<tr>
										<td colSpan={5} className="empty-state">
											No projects match your filters.
										</td>
									</tr>
								)}
								{filteredCIP.map((feature) => {
									const p = feature.properties;
									const phase = p.ActivePhaseName || p.CurrentPhaseDescription || "Other";
									const evCount = evCountPerCIP.get(feature.id)?.length ?? 0;
									const sel = selectedId === feature.id;
									return (
										<tr
											key={feature.id}
											className={sel ? "selected" : ""}
											onClick={() => selectProject(feature.id)}
											tabIndex={0}
											onKeyDown={(e) => e.key === "Enter" && selectProject(feature.id)}
											aria-selected={sel}
										>
											<td>
												<div className="cell-title">{p.ProjectTitle || `Project ${p.ProjectNumber}`}</div>
												<div className="cell-sub">#{p.ProjectNumber}</div>
											</td>
											<td className="col-phase">
												<span className="badge-phase" style={{ background: phaseColor(phase) + "22", color: phaseColor(phase) }}>
													{phase}
												</span>
											</td>
											<td style={{ whiteSpace: "nowrap", color: "#374151" }}>{formatCurrency(p.ConstructionCost)}</td>
											<td style={{ whiteSpace: "nowrap" }}>{evCount > 0 ? <span className="badge-ev">⚡ {evCount}</span> : <span className="badge-ev-none">—</span>}</td>
											<td className="col-pm" style={{ whiteSpace: "nowrap", color: "#374151" }}>
												{p.PM_Name || "—"}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>

					{/* Mobile: Cards */}
					<div className="card-list" role="list" aria-label="Projects list">
						{filteredCIP.length === 0 && <div className="empty-state">No projects match your filters.</div>}
						{filteredCIP.map((feature) => {
							const p = feature.properties;
							const phase = p.ActivePhaseName || p.CurrentPhaseDescription || "Other";
							const evCount = evCountPerCIP.get(feature.id)?.length ?? 0;
							const sel = selectedId === feature.id;
							return (
								<div
									key={feature.id}
									className={`project-card${sel ? " selected" : ""}`}
									onClick={() => selectProject(feature.id)}
									role="listitem"
									tabIndex={0}
									onKeyDown={(e) => e.key === "Enter" && selectProject(feature.id)}
								>
									<div className="card-title">{p.ProjectTitle || `Project ${p.ProjectNumber}`}</div>
									<div className="card-meta">
										<span className="badge-phase" style={{ background: phaseColor(phase) + "22", color: phaseColor(phase) }}>
											{phase}
										</span>
										{evCount > 0 && <span className="badge-ev">⚡ {evCount} EV nearby</span>}
									</div>
									<div className="card-details">
										<div className="card-detail-row">
											<span className="card-detail-label">Program</span>
											<span className="card-detail-value" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
												{p.ProgramName || "—"}
											</span>
										</div>
										<div className="card-detail-row">
											<span className="card-detail-label">Cost</span>
											<span className="card-detail-value">{formatCurrency(p.ConstructionCost)}</span>
										</div>
										<div className="card-detail-row">
											<span className="card-detail-label">Start</span>
											<span className="card-detail-value">{formatDate(p.ConsStartDate || p.StartDate)}</span>
										</div>
										<div className="card-detail-row">
											<span className="card-detail-label">End</span>
											<span className="card-detail-value">{formatDate(p.ConsEndDate || p.EndDate)}</span>
										</div>
										<div className="card-detail-row">
											<span className="card-detail-label">PM</span>
											<span className="card-detail-value">{p.PM_Name || "—"}</span>
										</div>
										<div className="card-detail-row">
											<span className="card-detail-label">Project #</span>
											<span className="card-detail-value">{p.ProjectNumber}</span>
										</div>
									</div>
								</div>
							);
						})}
					</div>
				</div>
				{/* end sidebar */}

				{/* ── Map (full height, fills remaining width) ── */}
				<div className="map-wrap">
					<div ref={mapElRef} style={{ width: "100%", height: "100%" }} />

					{/* Legend */}
					<div className="map-legend" aria-hidden="true">
						{legendItems.map(({ bg, border, label }) => (
							<div key={label} className="map-legend-item">
								<div className="legend-swatch" style={{ background: bg, border: `2px solid ${border}` }} />
								{label}
							</div>
						))}
						<div className="map-legend-item">
							<div className="legend-dot" style={{ background: "#16a34a" }} />
							EV Charger
						</div>
					</div>

					{/* Detail panel — shown when a project is selected */}
					{selectedFeature &&
						(() => {
							const p = selectedFeature.properties;
							const phase = p.ActivePhaseName || p.CurrentPhaseDescription || "Other";
							const evs = evCountPerCIP.get(selectedFeature.id);
							const evCount = evs?.length ?? 0;
							return (
								<div className="detail-panel">
									<div className="detail-header">
										<h6>{p.ProjectTitle || `Project ${p.ProjectNumber}`}</h6>
										<button onClick={() => selectProject(selectedFeature.id)} aria-label="Close">
											✕
										</button>
									</div>
									<div className="detail-body">
										<div className="detail-row">
											<span className="detail-label">Program</span>
											<span className="detail-value">{p.ProgramName || "—"}</span>
										</div>
										<div className="detail-row">
											<span className="detail-label">Phase</span>
											<span className="detail-value">
												<span className="badge-phase" style={{ background: phaseColor(phase) + "22", color: phaseColor(phase) }}>
													{phase}
												</span>
											</span>
										</div>
										<div className="detail-row">
											<span className="detail-label">% Complete</span>
											<span className="detail-value">{p.CurrentPhasePercentComplete ?? p.ConstPercComp ?? "—"}%</span>
										</div>
										<div className="detail-row">
											<span className="detail-label">Cost</span>
											<span className="detail-value">{formatCurrency(p.ConstructionCost)}</span>
										</div>
										<div className="detail-row">
											<span className="detail-label">Start</span>
											<span className="detail-value">{formatDate(p.ConsStartDate || p.StartDate)}</span>
										</div>
										<div className="detail-row">
											<span className="detail-label">End</span>
											<span className="detail-value">{formatDate(p.ConsEndDate || p.EndDate)}</span>
										</div>
										<div className="detail-row">
											<span className="detail-label">Project #</span>
											<span className="detail-value">{p.ProjectNumber}</span>
										</div>
										<div className="detail-row">
											<span className="detail-label">Council District</span>
											<span className="detail-value" style={{ fontSize: "0.68rem" }}>
												{p.CouncilDistrict || "—"}
											</span>
										</div>
										<div className="detail-row">
											<span className="detail-label">PM</span>
											<span className="detail-value">{p.PM_Name || "—"}</span>
										</div>

										{evCount > 0 ? (
											<div className="ev-charger-box">
												<h6>⚡ EV charger nearby</h6>
												<p>
													<strong>
														{evCount} EV charger{evCount > 1 ? "s" : ""}
													</strong>{" "}
													located within or near this project area. Consider capacity upgrades during construction to minimise disruption.
												</p>
											</div>
										) : (
											<div className="no-ev-box">No EV chargers identified near this project area.</div>
										)}
									</div>
								</div>
							);
						})()}
				</div>
				{/* end map-wrap */}
			</div>
			{/* end app-body */}
		</div>
	);
};

export default App;
