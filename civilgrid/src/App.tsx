import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

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
	return new Date(ts).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function phaseClass(phase: string): string {
	if (!phase) return "phase-Other";
	if (phase.toLowerCase().includes("design")) return "phase-Design";
	if (phase.toLowerCase().includes("construct")) return "phase-Construction";
	if (phase.toLowerCase().includes("close")) return "phase-Closeout";
	return "phase-Other";
}

// Point-in-polygon using ray casting
function pointInPolygon(point: [number, number], vs: [number, number][]): boolean {
	const [x, y] = point;
	let inside = false;
	for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
		const xi = vs[i][0],
			yi = vs[i][1];
		const xj = vs[j][0],
			yj = vs[j][1];
		const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371000;
	const φ1 = (lat1 * Math.PI) / 180;
	const φ2 = (lat2 * Math.PI) / 180;
	const Δφ = ((lat2 - lat1) * Math.PI) / 180;
	const Δλ = ((lon2 - lon1) * Math.PI) / 180;
	const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Get centroid of a polygon
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

// Centroid for any geometry
function getCentroid(geometry: GeoJSON.Geometry): [number, number] | null {
	if (geometry.type === "Point") {
		const [lon, lat] = geometry.coordinates as [number, number];
		return [lat, lon];
	}
	if (geometry.type === "Polygon") {
		return polygonCentroid(geometry.coordinates as [number, number][][]);
	}
	if (geometry.type === "MultiPolygon") {
		return polygonCentroid((geometry.coordinates as [number, number][][][])[0]);
	}
	return null;
}

// Check if EV point is inside CIP polygon (or within BUFFER_M metres of it)
const BUFFER_M = 100; // 100 m proximity buffer

function evNearCIP(ev: EVFeature, cip: CIPFeature): boolean {
	const [evLon, evLat] = ev.geometry.coordinates;
	const geom = cip.geometry;

	if (geom.type === "Polygon") {
		const ring = (geom.coordinates as [number, number][][])[0];
		if (pointInPolygon([evLon, evLat], ring)) return true;
		// buffer: check distance to centroid of polygon vs rough radius
		const [cLat, cLon] = polygonCentroid(geom.coordinates as [number, number][][]);
		return haversineDistance(evLat, evLon, cLat, cLon) < BUFFER_M;
	}

	if (geom.type === "MultiPolygon") {
		for (const poly of geom.coordinates as [number, number][][][]) {
			if (pointInPolygon([evLon, evLat], poly[0])) return true;
			const [cLat, cLon] = polygonCentroid([poly[0]]);
			if (haversineDistance(evLat, evLon, cLat, cLon) < BUFFER_M) return true;
		}
		return false;
	}

	if (geom.type === "Point") {
		const [cLon, cLat] = geom.coordinates as [number, number];
		return haversineDistance(evLat, evLon, cLat, cLon) < BUFFER_M;
	}

	if (geom.type === "LineString") {
		const coords = geom.coordinates as [number, number][];
		for (const [pLon, pLat] of coords) {
			if (haversineDistance(evLat, evLon, pLat, pLon) < BUFFER_M) return true;
		}
		return false;
	}

	if (geom.type === "MultiPoint") {
		for (const [pLon, pLat] of geom.coordinates as [number, number][]) {
			if (haversineDistance(evLat, evLon, pLat, pLon) < BUFFER_M) return true;
		}
		return false;
	}

	return false;
}

// EV marker icons
const evNormalIcon = L.divIcon({
	className: "",
	html: `<div style="width:10px;height:10px;background:#16a34a;border:2px solid white;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.4)"></div>`,
	iconSize: [10, 10],
	iconAnchor: [5, 5],
});

const evHighlightIcon = L.divIcon({
	className: "",
	html: `<div style="width:14px;height:14px;background:#f59e0b;border:2.5px solid white;border-radius:50%;box-shadow:0 1px 6px rgba(0,0,0,0.5)"></div>`,
	iconSize: [14, 14],
	iconAnchor: [7, 7],
});

// ── Main App ───────────────────────────────────────────────────────────────

const App: React.FC = () => {
	const mapRef = useRef<L.Map | null>(null);
	const mapElRef = useRef<HTMLDivElement>(null);
	const cipLayersRef = useRef<Map<number, L.Layer>>(new Map());
	const evMarkersRef = useRef<Map<number, L.Marker>>(new Map());
	const selectedLayerRef = useRef<L.Layer | null>(null);

	const [cipData, setCipData] = useState<FeatureCollection<GeoJSON.Geometry, CIPProperties> | null>(null);
	const [evData, setEvData] = useState<FeatureCollection<GeoJSON.Point, EVProperties> | null>(null);
	const [selectedCIP, setSelectedCIP] = useState<CIPFeature | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [phaseFilter, setPhaseFilter] = useState("All");
	const [programFilter, setProgramFilter] = useState("All");
	const [onlySynergy, setOnlySynergy] = useState(false);
	const [loading, setLoading] = useState(true);

	// Load data
	useEffect(() => {
		Promise.all([fetch("/cip_projects.json").then((r) => r.json()), fetch("/ev_chargers.json").then((r) => r.json())]).then(([cip, ev]) => {
			setCipData(cip);
			setEvData(ev);
			setLoading(false);
		});
	}, []);

	// Compute EV counts per CIP project
	const evCountPerCIP = useMemo(() => {
		if (!cipData || !evData) return new Map<number, EVFeature[]>();
		const map = new Map<number, EVFeature[]>();
		for (const cip of cipData.features) {
			const nearby = evData.features.filter((ev) => evNearCIP(ev, cip));
			if (nearby.length > 0) map.set(cip.id, nearby);
		}
		return map;
	}, [cipData, evData]);

	// Unique phases and programs
	const phases = useMemo(() => {
		if (!cipData) return [] as string[];
		const set = new Set(cipData.features.map((f) => f.properties.ActivePhaseName || f.properties.CurrentPhaseDescription || "Other").filter(Boolean));
		return Array.from(set).sort();
	}, [cipData]);

	const programs = useMemo(() => {
		if (!cipData) return [] as string[];
		const set = new Set(cipData.features.map((f) => f.properties.ProgramName).filter(Boolean));
		return Array.from(set).sort();
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
			if (onlySynergy && !evCountPerCIP.has(f.id)) return false;
			return true;
		});
	}, [cipData, searchQuery, phaseFilter, programFilter, onlySynergy, evCountPerCIP]);

	// Init map
	useEffect(() => {
		if (!mapElRef.current) return;
		if (mapRef.current) {
			mapRef.current.remove();
			mapRef.current = null;
		}
		mapRef.current = L.map(mapElRef.current, { center: [34.05, -118.25], zoom: 11 });
		L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
			attribution: "&copy; OpenStreetMap &copy; CARTO",
			maxZoom: 19,
		}).addTo(mapRef.current);

		return () => {
			mapRef.current?.remove();
			mapRef.current = null;
		};
	}, []);

	// Render EV markers
	useEffect(() => {
		if (!mapRef.current || !evData) return;
		const map = mapRef.current;

		evMarkersRef.current.forEach((m) => m.remove());
		evMarkersRef.current.clear();

		evData.features.forEach((ev) => {
			const [lon, lat] = ev.geometry.coordinates;
			const marker = L.marker([lat, lon], { icon: evNormalIcon }).bindPopup(`<b>EV Charger #${ev.properties.OBJECTID}</b>`);
			marker.addTo(map);
			evMarkersRef.current.set(ev.properties.OBJECTID, marker);
		});
	}, [evData]);

	// Render CIP polygons
	useEffect(() => {
		if (!mapRef.current || !cipData) return;
		const map = mapRef.current;

		cipLayersRef.current.forEach((l) => l.remove());
		cipLayersRef.current.clear();

		cipData.features.forEach((feature) => {
			const hasSynergy = evCountPerCIP.has(feature.id);
			try {
				const layer = L.geoJSON(feature as any, {
					style: {
						color: hasSynergy ? "#f59e0b" : "#3b82f6",
						weight: hasSynergy ? 2.5 : 1.5,
						fillColor: hasSynergy ? "#fef3c7" : "#dbeafe",
						fillOpacity: 0.4,
					},
					onEachFeature: (_, l) => {
						l.on("click", () => handleSelectCIP(feature));
					},
				});
				layer.addTo(map);
				cipLayersRef.current.set(feature.id, layer);
			} catch (e) {
				// skip malformed geometries
			}
		});
	}, [cipData, evCountPerCIP]); // eslint-disable-line

	const highlightEVsForCIP = useCallback(
		(cip: CIPFeature | null) => {
			// Reset all EV markers
			evMarkersRef.current.forEach((marker, id) => {
				marker.setIcon(evNormalIcon);
				marker.setZIndexOffset(0);
			});

			if (!cip) return;

			const nearby = evCountPerCIP.get(cip.id) || [];
			nearby.forEach((ev) => {
				const marker = evMarkersRef.current.get(ev.properties.OBJECTID);
				if (marker) {
					marker.setIcon(evHighlightIcon);
					marker.setZIndexOffset(1000);
				}
			});
		},
		[evCountPerCIP],
	);

	const handleSelectCIP = useCallback(
		(feature: CIPFeature) => {
			setSelectedCIP((prev) => {
				const next = prev?.id === feature.id ? null : feature;

				// Reset previous highlight
				if (prev) {
					const layer = cipLayersRef.current.get(prev.id);
					if (layer) {
						const hasSynergy = evCountPerCIP.has(prev.id);
						(layer as L.GeoJSON).setStyle({
							color: hasSynergy ? "#f59e0b" : "#3b82f6",
							weight: hasSynergy ? 2.5 : 1.5,
							fillColor: hasSynergy ? "#fef3c7" : "#dbeafe",
							fillOpacity: 0.4,
						});
					}
				}

				if (next) {
					const layer = cipLayersRef.current.get(next.id);
					if (layer) {
						(layer as L.GeoJSON).setStyle({
							color: "#7c3aed",
							weight: 3,
							fillColor: "#ede9fe",
							fillOpacity: 0.6,
						});
					}
					highlightEVsForCIP(next);

					// Fly to
					const centroid = getCentroid(next.geometry);
					if (centroid && mapRef.current) {
						mapRef.current.flyTo(centroid, 15, { duration: 0.8 });
					}
				} else {
					highlightEVsForCIP(null);
				}

				return next;
			});
		},
		[evCountPerCIP, highlightEVsForCIP],
	);

	const handleListClick = (feature: CIPFeature) => {
		handleSelectCIP(feature);
	};

	const totalSynergyProjects = evCountPerCIP.size;
	const totalNearbyEVs = useMemo(() => {
		let total = 0;
		evCountPerCIP.forEach((evs) => {
			total += evs.length;
		});
		return total;
	}, [evCountPerCIP]);

	if (loading) {
		return (
			<div className="d-flex align-items-center justify-content-center" style={{ height: "100vh", background: "#f0f2f5" }}>
				<div className="text-center">
					<div className="spinner-border text-primary mb-3" role="status" />
					<p className="text-muted">Loading LA CIP & EV data…</p>
				</div>
			</div>
		);
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
			{/* Header */}
			<div className="app-header">
				<svg width="28" height="28" viewBox="0 0 28 28" fill="none">
					<circle cx="14" cy="14" r="14" fill="#FFD700" />
					<text x="14" y="19" textAnchor="middle" fontSize="13" fontWeight="bold" fill="#003087">
						LA
					</text>
				</svg>
				<h1>City of Los Angeles — CIP & EV Finder</h1>
				<span className="badge-la">CITY MANAGER TOOL</span>
			</div>

			<div className="layout">
				{/* Sidebar */}
				<div className="sidebar">
					<div className="sidebar-header">
						<h6>Capital Improvement Projects</h6>
						<div className="sidebar-search">
							<input type="text" placeholder="Search by title, program, number…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
						</div>
					</div>

					<div className="filter-row">
						<select value={phaseFilter} onChange={(e) => setPhaseFilter(e.target.value)}>
							<option value="All">All Phases</option>
							{phases.map((p) => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</select>
						<select value={programFilter} onChange={(e) => setProgramFilter(e.target.value)}>
							<option value="All">All Programs</option>
							{programs.map((p) => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</select>
					</div>

					<div className="filter-row" style={{ paddingTop: 4, paddingBottom: 4 }}>
						<label style={{ fontSize: "0.78rem", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", color: "#374151" }}>
							<input type="checkbox" checked={onlySynergy} onChange={(e) => setOnlySynergy(e.target.checked)} />
							Show only synergy projects
							<span style={{ color: "#f59e0b", fontWeight: 700 }}>⚡</span>
						</label>
					</div>

					<div className="stats-bar">
						<span className="stat-pill cip">{filteredCIP.length} CIP Projects</span>
						<span className="stat-pill ev">{evData?.features.length} EV Chargers</span>
						<span className="stat-pill synergy">
							⚡ {totalSynergyProjects} w/ EV ({totalNearbyEVs} chargers)
						</span>
					</div>

					<div className="project-list">
						{filteredCIP.length === 0 && <div className="no-results">No projects match your filters.</div>}
						{filteredCIP.map((feature) => {
							const p = feature.properties;
							const phase = p.ActivePhaseName || p.CurrentPhaseDescription || "Other";
							const evs = evCountPerCIP.get(feature.id);
							const evCount = evs ? evs.length : 0;
							return (
								<div key={feature.id} className={`project-item ${selectedCIP?.id === feature.id ? "selected" : ""}`} onClick={() => handleListClick(feature)}>
									<div className="proj-title">{p.ProjectTitle || `Project #${p.ProjectNumber}`}</div>
									<div className="proj-meta">
										<span className={`phase-badge ${phaseClass(phase)}`}>{phase}</span>
										<span>{p.ProgramName}</span>
										<span className={`ev-count-badge ${evCount === 0 ? "zero" : ""}`}>{evCount > 0 ? `⚡ ${evCount} EV` : "No EV nearby"}</span>
									</div>
								</div>
							);
						})}
					</div>
				</div>

				{/* Map */}
				<div className="map-container">
					<div id="map" ref={mapElRef} />

					{/* Detail panel */}
					{selectedCIP && (
						<div className="detail-panel">
							<div className="detail-panel-header">
								<h6>{selectedCIP.properties.ProjectTitle}</h6>
								<button
									onClick={() => {
										setSelectedCIP(null);
										highlightEVsForCIP(null);
									}}
								>
									✕
								</button>
							</div>
							<div className="detail-panel-body">
								<div className="detail-row">
									<span className="detail-label">Program</span>
									<span className="detail-value">{selectedCIP.properties.ProgramName}</span>
								</div>
								<div className="detail-row">
									<span className="detail-label">Phase</span>
									<span className="detail-value">{selectedCIP.properties.ActivePhaseName || selectedCIP.properties.CurrentPhaseDescription}</span>
								</div>
								<div className="detail-row">
									<span className="detail-label">% Complete</span>
									<span className="detail-value">{selectedCIP.properties.CurrentPhasePercentComplete ?? selectedCIP.properties.ConstPercComp ?? "—"}%</span>
								</div>
								<div className="detail-row">
									<span className="detail-label">Const. Cost</span>
									<span className="detail-value">{formatCurrency(selectedCIP.properties.ConstructionCost)}</span>
								</div>
								<div className="detail-row">
									<span className="detail-label">Start Date</span>
									<span className="detail-value">{formatDate(selectedCIP.properties.ConsStartDate || selectedCIP.properties.StartDate)}</span>
								</div>
								<div className="detail-row">
									<span className="detail-label">End Date</span>
									<span className="detail-value">{formatDate(selectedCIP.properties.ConsEndDate || selectedCIP.properties.EndDate)}</span>
								</div>
								<div className="detail-row">
									<span className="detail-label">Council District</span>
									<span className="detail-value" style={{ fontSize: "0.7rem" }}>
										{selectedCIP.properties.CouncilDistrict || "—"}
									</span>
								</div>
								<div className="detail-row">
									<span className="detail-label">Project #</span>
									<span className="detail-value">{selectedCIP.properties.ProjectNumber}</span>
								</div>
								<div className="detail-row">
									<span className="detail-label">PM</span>
									<span className="detail-value">{selectedCIP.properties.PM_Name || "—"}</span>
								</div>

								{/* EV synergy highlight */}
								{(() => {
									const evs = evCountPerCIP.get(selectedCIP.id);
									if (evs && evs.length > 0) {
										return (
											<div className="ev-highlight-section">
												<h6>⚡ EV Synergy Opportunity</h6>
												<p>
													<strong>
														{evs.length} EV charger{evs.length > 1 ? "s" : ""}
													</strong>{" "}
													located within or near this project area. Consider capacity upgrades during construction to minimize disruption.
												</p>
											</div>
										);
									}
									return (
										<div style={{ marginTop: 10, padding: "8px 10px", background: "#f9fafb", borderRadius: 6, border: "1px solid #e5e7eb" }}>
											<p style={{ margin: 0, fontSize: "0.72rem", color: "#9ca3af" }}>No EV chargers identified near this project area.</p>
										</div>
									);
								})()}
							</div>
						</div>
					)}

					{/* Legend */}
					<div className="legend">
						<div className="legend-title">Legend</div>
						<div className="legend-item">
							<div className="legend-swatch" style={{ background: "#dbeafe", border: "2px solid #3b82f6" }} />
							CIP Project
						</div>
						<div className="legend-item">
							<div className="legend-swatch" style={{ background: "#fef3c7", border: "2px solid #f59e0b" }} />
							CIP + EV Synergy ⚡
						</div>
						<div className="legend-item">
							<div className="legend-swatch" style={{ background: "#ede9fe", border: "2px solid #7c3aed" }} />
							Selected Project
						</div>
						<div className="legend-item">
							<div className="legend-dot" style={{ background: "#16a34a" }} />
							EV Charger
						</div>
						<div className="legend-item">
							<div className="legend-dot" style={{ background: "#f59e0b" }} />
							EV in Synergy Zone
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

export default App;
