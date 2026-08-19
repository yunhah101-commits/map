const SCHOOL = { lon: 127.00604, lat: 37.4893 };
const QUERY_RADIUS_M = 1000;
const SCOPE_MARGIN_M = 120;
const VWORLD_KEY = "C684FAA4-D7E2-3757-BD00-CA0565FBAC0D";
const VWORLD_DOMAIN = "https://yunhah101-commits.github.io/map/";
const REPRESENTATIVE_DATE = { year: 2026, month: 8, day: 1 };
const SEOUL_TZ = 9;
const WALK_CACHE_KEY = "shade-route-walk-graph-v4";
const WALK_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OSM_MAP_API = "https://api.openstreetmap.org/api/0.6/map.json";
const SHADOW_MIN_ZOOM = 16;
const BUILDING_MIN_ZOOM = 15;
const SHADE_SAMPLE_STEP_M = 8;
const SHADOW_GRID_M = 70;
let sunPenalty = 3.0;
let visualLodTimer = null;
let routeRecalcTimer = null;

const displayProjection = new OpenLayers.Projection("EPSG:4326");
const mapProjection = new OpenLayers.Projection("EPSG:900913");

let map, vBase, shadowLayer, buildingLayer, networkLayer, junctionLayer, routeLayer, pointLayer, algorithmLayer;
let baseGraph = null;
let buildings = [];
let buildingShadowPolygons = [];
let analysisShadowIndex = null;
let analysisShadowHour = null;
let edgeShadeCache = new Map();
let buildingReady = false;
let networkReady = false;
let selectMode = "start";
let startSnap = null;
let endSnap = null;
let lastRoute = null;
let routeView = "both";
let animationTimer = null;


function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }
function haversine(a, b) {
  const R = 6371008.8;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function llToXY(p) {
  const lat0 = toRad(SCHOOL.lat);
  return {
    x: (p.lon - SCHOOL.lon) * 111320 * Math.cos(lat0),
    y: (p.lat - SCHOOL.lat) * 110540
  };
}
function xyToLL(p) {
  const lat0 = toRad(SCHOOL.lat);
  return {
    lon: SCHOOL.lon + p.x / (111320 * Math.cos(lat0)),
    lat: SCHOOL.lat + p.y / 110540
  };
}
function pointDistance(a,b) { return Math.hypot(a.x-b.x, a.y-b.y); }
function projectPointToSegment(p,a,b) {
  const vx=b.x-a.x, vy=b.y-a.y;
  const len2=vx*vx+vy*vy || 1;
  let t=((p.x-a.x)*vx+(p.y-a.y)*vy)/len2;
  t=Math.max(0,Math.min(1,t));
  const q={x:a.x+vx*t,y:a.y+vy*t};
  return {...q,t,d:pointDistance(p,q)};
}

function initMap() {
  const options = {
    controls: [],
    projection: mapProjection,
    displayProjection,
    units: "m",
    numZoomLevels: 21,
    maxResolution: 156543.0339,
    maxExtent: new OpenLayers.Bounds(-20037508.34,-20037508.34,20037508.34,20037508.34)
  };

  map = new OpenLayers.Map("vmap", options);
  vBase = new vworld.Layers.Base("VWorld Base");
  map.addLayer(vBase);

  shadowLayer = new OpenLayers.Layer.Vector("건물 그림자", {rendererOptions:{zIndexing:true}});
  buildingLayer = new OpenLayers.Layer.Vector("실제 건물", {rendererOptions:{zIndexing:true}});
  networkLayer = new OpenLayers.Layer.Vector("실제 보행망", {rendererOptions:{zIndexing:true}});
  junctionLayer = new OpenLayers.Layer.Vector("분기점", {rendererOptions:{zIndexing:true}});
  routeLayer = new OpenLayers.Layer.Vector("최단거리 + 그늘우선", {rendererOptions:{zIndexing:true}});
  algorithmLayer = new OpenLayers.Layer.Vector("Dijkstra 탐색", {rendererOptions:{zIndexing:true}});
  pointLayer = new OpenLayers.Layer.Vector("출발도착", {rendererOptions:{zIndexing:true}});

  map.addLayers([shadowLayer, buildingLayer, networkLayer, junctionLayer, routeLayer, algorithmLayer, pointLayer]);

  map.addControl(new OpenLayers.Control.Navigation());
  map.addControl(new OpenLayers.Control.PanZoomBar());
  map.addControl(new OpenLayers.Control.Attribution({separator:" "}));

  recenter();
  addSchoolMarker();
  map.events.register("click", map, handleMapClick);
  map.events.register("moveend", map, handleMapMoveEnd);

  loadWalkingNetwork();
  loadVworldBuildings();
}

function recenter() {
  const center = new OpenLayers.LonLat(SCHOOL.lon, SCHOOL.lat).transform(displayProjection,mapProjection);
  map.setCenter(center, 16);
}

function addSchoolMarker() {
  const geom = new OpenLayers.Geometry.Point(SCHOOL.lon,SCHOOL.lat).transform(displayProjection,mapProjection);
  pointLayer.addFeatures([new OpenLayers.Feature.Vector(geom,{school:true},{
    pointRadius:6,fillColor:"#276ef1",strokeColor:"#fff",strokeWidth:3,
    label:"서초고",fontColor:"#17212b",fontWeight:"bold",fontSize:"10px",
    labelYOffset:-16,labelOutlineColor:"#fff",labelOutlineWidth:3
  })]);
}

function isWalkableHighway(tags={}) {
  const allowed = new Set([
    "footway","pedestrian","path","steps","living_street",
    "residential","service","unclassified","tertiary"
  ]);
  return allowed.has(tags.highway) && tags.foot !== "no" && tags.access !== "private";
}

async function fetchWithTimeout(url, options={}, timeoutMs=15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

function graphForCache(graph) {
  return {
    savedAt: Date.now(),
    graph: {
      nodes: graph.nodes,
      edges: graph.edges,
      junctionIds: [...graph.junctionIds]
    }
  };
}

function graphFromCache(raw) {
  if (!raw || !raw.graph || !raw.savedAt) return null;
  if (Date.now() - raw.savedAt > WALK_CACHE_MAX_AGE_MS) return null;
  const g=raw.graph;
  if (!g.nodes || !Array.isArray(g.edges) || !Array.isArray(g.junctionIds)) return null;
  return {nodes:g.nodes, edges:g.edges, junctionIds:new Set(g.junctionIds)};
}

function readWalkCache() {
  try {
    const raw=JSON.parse(localStorage.getItem(WALK_CACHE_KEY) || "null");
    return graphFromCache(raw);
  } catch (_) { return null; }
}

function saveWalkCache(graph) {
  try {
    localStorage.setItem(WALK_CACHE_KEY, JSON.stringify(graphForCache(graph)));
    return true;
  } catch (err) {
    console.warn("보행망 캐시 저장 실패",err);
    return false;
  }
}

function clearWalkCache() {
  try { localStorage.removeItem(WALK_CACHE_KEY); } catch (_) {}
}

function makeOsmTileBboxes() {
  const b=bboxAroundSchool(QUERY_RADIUS_M + SCOPE_MARGIN_M);
  const midLon=(b.minLon+b.maxLon)/2;
  const midLat=(b.minLat+b.maxLat)/2;
  return [
    [b.minLon,b.minLat,midLon,midLat],
    [midLon,b.minLat,b.maxLon,midLat],
    [b.minLon,midLat,midLon,b.maxLat],
    [midLon,midLat,b.maxLon,b.maxLat]
  ];
}

async function fetchOsmTile(bbox) {
  const url=OSM_MAP_API+"?bbox="+bbox.map(v=>v.toFixed(7)).join(",");
  const res=await fetchWithTimeout(url,{headers:{"Accept":"application/json"}},18000);
  if(!res.ok) throw new Error(`OSM HTTP ${res.status}`);
  const data=await res.json();
  if(!Array.isArray(data.elements)) throw new Error("OSM 지도 응답 형식 오류");
  return data;
}

async function fetchOsmMapSmallTiles() {
  const tiles=makeOsmTileBboxes();
  const payloads=[];
  // 한 번에 4개를 때리지 않고 2개씩 처리해 공식 API 부하를 줄인다.
  for(let i=0;i<tiles.length;i+=2) {
    const batch=await Promise.all(tiles.slice(i,i+2).map(fetchOsmTile));
    payloads.push(...batch);
  }
  const elementMap=new Map();
  for(const data of payloads) {
    for(const el of data.elements || []) {
      if(el.type!=="node" && el.type!=="way") continue;
      elementMap.set(`${el.type}/${el.id}`,el);
    }
  }
  return {elements:[...elementMap.values()]};
}

async function loadWalkingNetwork({force=false}={}) {
  networkReady=false;
  setNetworkStatus("loading","보행 네트워크 준비 중…");
  const badge=document.getElementById("networkBadge");
  badge.className="badge";
  badge.textContent="보행망 준비 중…";
  document.getElementById("algoStatus").textContent="실제 보행 네트워크를 준비하고 있습니다.";

  try {
    if(force) clearWalkCache();
    if(!force) {
      const cached=readWalkCache();
      if(cached && cached.edges.length) {
        baseGraph=cached;
        finishWalkingNetworkLoad("브라우저 캐시");
        return;
      }
    }

    const data=await fetchOsmMapSmallTiles();
    baseGraph=parseAndCompressOSM(data);
    if(!baseGraph || baseGraph.edges.length===0) throw new Error("사용 가능한 보행 간선이 없습니다.");
    saveWalkCache(baseGraph);
    finishWalkingNetworkLoad("OSM 공식 API · 캐시 저장");
  } catch(err) {
    console.error(err);
    badge.textContent="보행망 로딩 실패";
    badge.classList.add("error");
    setNetworkStatus("error","보행 네트워크 로딩 실패");
    document.getElementById("guideTitle").textContent="보행망을 불러오지 못했습니다";
    document.getElementById("guideText").textContent="네트워크 연결 후 ‘보행망 다시 불러오기’를 눌러주세요.";
    document.getElementById("algoStatus").textContent="이번 버전은 Overpass를 사용하지 않습니다. OSM 공식 소형 영역 API를 1회 호출한 뒤 브라우저에 캐시합니다.";
  }
}

function finishWalkingNetworkLoad(sourceLabel) {
  drawNetwork();
  drawJunctions();
  networkReady=true;
  document.getElementById("nodeCount").textContent=baseGraph.junctionIds.size.toLocaleString()+"개";
  document.getElementById("edgeCount").textContent=baseGraph.edges.length.toLocaleString()+"개";
  const badge=document.getElementById("networkBadge");
  badge.textContent="실제 보행망 연결됨";
  badge.classList.add("live");
  setNetworkStatus("ok",`실제 보행망 ${baseGraph.edges.length.toLocaleString()}개 · ${sourceLabel}`);
  document.getElementById("guideTitle").textContent="출발점을 선택하세요";
  document.getElementById("guideText").textContent="지도 아무 곳을 클릭하면 가장 가까운 보행도로에 자동으로 붙습니다.";
  document.getElementById("algoStatus").textContent="출발점과 도착점을 선택하세요.";
  syncUI();
}

function setNetworkStatus(state,text) {
  const row=document.getElementById("networkStatusRow");
  row.className=state;
  document.getElementById("networkStatus").textContent=text;
}

function parseAndCompressOSM(data) {
  const osmNodes=new Map();
  const ways=[];

  for(const el of data.elements || []) {
    if(el.type==="node" && Number.isFinite(Number(el.lon)) && Number.isFinite(Number(el.lat))) {
      const id=String(el.id),ll={lon:Number(el.lon),lat:Number(el.lat)},xy=llToXY(ll);
      osmNodes.set(id,{id,...ll,...xy});
    }
  }
  for(const el of data.elements || []) {
    if(el.type!=="way" || !Array.isArray(el.nodes) || el.nodes.length<2 || !isWalkableHighway(el.tags||{})) continue;
    ways.push({id:String(el.id),nodes:el.nodes.map(String),tags:el.tags||{}});
  }

  const rawSegments=[];
  const rawAdj=new Map();
  let segIndex=0;
  function addAdj(nodeId,segId){ if(!rawAdj.has(nodeId))rawAdj.set(nodeId,[]); rawAdj.get(nodeId).push(segId); }

  for(const way of ways) {
    for(let i=0;i<way.nodes.length-1;i++) {
      const aId=way.nodes[i],bId=way.nodes[i+1],A=osmNodes.get(aId),B=osmNodes.get(bId);
      if(!A||!B) continue;
      const mid={lon:(A.lon+B.lon)/2,lat:(A.lat+B.lat)/2};
      if(haversine(SCHOOL,mid)>QUERY_RADIUS_M+SCOPE_MARGIN_M) continue;
      const length=haversine(A,B);
      if(length<0.05||length>500) continue;
      const id="R"+(segIndex++);
      rawSegments.push({id,a:aId,b:bId,length,tags:way.tags,wayId:way.id});
      addAdj(aId,id); addAdj(bId,id);
    }
  }

  const segMap=new Map(rawSegments.map(s=>[s.id,s]));
  const junctionIds=new Set();
  for(const [nodeId,segIds] of rawAdj.entries()) {
    const neighbors=new Set();
    for(const sid of segIds) { const s=segMap.get(sid); if(s)neighbors.add(s.a===nodeId?s.b:s.a); }
    if(neighbors.size!==2) junctionIds.add(nodeId);
  }
  for(const way of ways) {
    if(!way.nodes.length)continue;
    const a=way.nodes[0],b=way.nodes[way.nodes.length-1];
    if(rawAdj.has(a))junctionIds.add(a);
    if(rawAdj.has(b))junctionIds.add(b);
  }

  const visited=new Set(),edges=[];
  let edgeIndex=0;
  const otherNode=(seg,nodeId)=>seg.a===nodeId?seg.b:seg.a;
  for(const startId of junctionIds) {
    for(const firstSegId of rawAdj.get(startId)||[]) {
      if(visited.has(firstSegId))continue;
      const startNode=osmNodes.get(startId); if(!startNode)continue;
      const geometry=[{lon:startNode.lon,lat:startNode.lat,x:startNode.x,y:startNode.y}];
      let currentNode=startId,currentSegId=firstSegId,total=0,guard=0,roadType="path";
      while(currentSegId&&guard++<3000) {
        if(visited.has(currentSegId))break;
        visited.add(currentSegId);
        const seg=segMap.get(currentSegId); if(!seg)break;
        roadType=seg.tags.highway||roadType;
        const nextNodeId=otherNode(seg,currentNode),nextNode=osmNodes.get(nextNodeId); if(!nextNode)break;
        geometry.push({lon:nextNode.lon,lat:nextNode.lat,x:nextNode.x,y:nextNode.y}); total+=seg.length;
        if(junctionIds.has(nextNodeId)) {
          if(nextNodeId!==startId||geometry.length>2)edges.push({id:"E"+(edgeIndex++),a:startId,b:nextNodeId,length:total,geometry,roadType});
          break;
        }
        const candidates=(rawAdj.get(nextNodeId)||[]).filter(sid=>sid!==currentSegId);
        if(!candidates.length)break;
        currentNode=nextNodeId; currentSegId=candidates[0];
      }
    }
  }

  for(const seg of rawSegments) {
    if(visited.has(seg.id))continue;
    const A=osmNodes.get(seg.a),B=osmNodes.get(seg.b); if(!A||!B)continue;
    junctionIds.add(seg.a);junctionIds.add(seg.b);
    edges.push({id:"E"+(edgeIndex++),a:seg.a,b:seg.b,length:seg.length,geometry:[
      {lon:A.lon,lat:A.lat,x:A.x,y:A.y},{lon:B.lon,lat:B.lat,x:B.x,y:B.y}
    ],roadType:seg.tags.highway||"path"});
  }

  const nodes={};
  for(const id of junctionIds){const n=osmNodes.get(id);if(n)nodes[id]={id,lon:n.lon,lat:n.lat,x:n.x,y:n.y};}
  for(const e of edges){
    e.cum=[0];
    for(let i=1;i<e.geometry.length;i++)e.cum.push(e.cum[i-1]+pointDistance(e.geometry[i-1],e.geometry[i]));
    e.planarLength=e.cum[e.cum.length-1]||e.length;
  }
  return {nodes,edges,junctionIds};
}

function drawNetwork() {
  networkLayer.removeAllFeatures();
  const features=[];

  for(const e of baseGraph.edges) {
    const pts=e.geometry.map(p=>new OpenLayers.Geometry.Point(p.lon,p.lat).transform(displayProjection,mapProjection));
    features.push(new OpenLayers.Feature.Vector(
      new OpenLayers.Geometry.LineString(pts),
      {edgeId:e.id},
      {strokeColor:"#3f78b8",strokeWidth:2,strokeOpacity:.62}
    ));
  }
  networkLayer.addFeatures(features);
}

function drawJunctions() {
  junctionLayer.removeAllFeatures();
  if(!document.getElementById("showJunctions").checked || !baseGraph) return;

  const features=[];
  for(const id of baseGraph.junctionIds) {
    const n=baseGraph.nodes[id];
    if(!n) continue;
    const g=new OpenLayers.Geometry.Point(n.lon,n.lat).transform(displayProjection,mapProjection);
    features.push(new OpenLayers.Feature.Vector(g,{id},{pointRadius:2.5,fillColor:"#fff",strokeColor:"#315a83",strokeWidth:1}));
  }
  junctionLayer.addFeatures(features);
}


// ---------- VWorld actual building footprints + heights ----------
function bboxAroundSchool(radiusM) {
  const latDelta = radiusM / 110540;
  const lonDelta = radiusM / (111320 * Math.cos(toRad(SCHOOL.lat)));
  return {
    minLon:SCHOOL.lon-lonDelta, minLat:SCHOOL.lat-latDelta,
    maxLon:SCHOOL.lon+lonDelta, maxLat:SCHOOL.lat+latDelta
  };
}

function jsonp(url, timeoutMs=15000) {
  return new Promise((resolve,reject) => {
    const callbackName = "vworldCallback_" + Date.now() + "_" + Math.floor(Math.random()*1e6);
    const script = document.createElement("script");

    const timer = setTimeout(() => cleanup(new Error("VWorld 요청 시간 초과")), timeoutMs);

    function cleanup(err,data) {
      clearTimeout(timer);
      try { delete window[callbackName]; } catch (_) {}
      script.remove();
      err ? reject(err) : resolve(data);
    }

    window[callbackName] = data => cleanup(null,data);
    script.onerror = () => cleanup(new Error("VWorld JSONP 로딩 실패"));

    script.src = url + (url.includes("?") ? "&" : "?") + "callback=" + callbackName;
    document.head.appendChild(script);
  });
}

function vworldBuildingUrl(page) {
  const b=bboxAroundSchool(1050);
  const params=new URLSearchParams({
    service:"data",
    version:"2.0",
    request:"GetFeature",
    format:"json",
    size:"1000",
    page:String(page),
    data:"LT_C_BLDGINFO",
    geometry:"true",
    attribute:"true",
    crs:"EPSG:4326",
    columns:"bld_nm,height,grnd_flr,usability",
    geomFilter:`BOX(${b.minLon},${b.minLat},${b.maxLon},${b.maxLat})`,
    key:VWORLD_KEY,
    domain:VWORLD_DOMAIN
  });
  return "https://api.vworld.kr/req/data?" + params.toString();
}

async function loadVworldBuildings() {
  setBuildingStatus("loading","VWorld 실제 건물 로딩 중…");
  const badge=document.getElementById("buildingBadge");
  badge.className="badge";
  badge.textContent="건물 불러오는 중…";

  try {
    const first=await jsonp(vworldBuildingUrl(1));
    const response=first && first.response;

    if (!response || response.status !== "OK") {
      throw new Error(response?.error?.text || "VWorld 건축물 API 오류");
    }

    const totalPages=Math.min(Number(response.page?.total || 1), 6);
    let features=[...(response.result?.featureCollection?.features || [])];

    for (let p=2; p<=totalPages; p++) {
      const next=await jsonp(vworldBuildingUrl(p));
      if (next?.response?.status === "OK") {
        features.push(...(next.response.result?.featureCollection?.features || []));
      }
    }

    buildings=features.map(parseBuildingFeature).filter(Boolean);
    buildingReady=true;
    invalidateShadeAnalysis();
    scheduleVisualLodUpdate();

    document.getElementById("buildingCount").textContent=buildings.length.toLocaleString()+"개";
    document.getElementById("heightCount").textContent=buildings.filter(b=>b.height>0).length.toLocaleString()+"개";

    badge.textContent="실제 건물 연결됨";
    badge.classList.add("live");
    setBuildingStatus("ok",`VWorld 건물 ${buildings.length.toLocaleString()}개`);
    syncUI();
  } catch (err) {
    console.error("VWorld building error:",err);
    buildingReady=false;
    badge.textContent="건물 로딩 실패";
    badge.classList.add("error");
    setBuildingStatus("error","VWorld 건물 로딩 실패");
  }
}

function setBuildingStatus(state,text) {
  const row=document.getElementById("buildingStatusRow");
  row.className=state;
  document.getElementById("buildingStatus").textContent=text;
}

function parseBuildingFeature(feature) {
  const geom=feature?.geometry;
  const props=feature?.properties || {};
  if (!geom) return null;

  const polygonGroups=[];
  if (geom.type === "Polygon") polygonGroups.push(geom.coordinates);
  else if (geom.type === "MultiPolygon") polygonGroups.push(...geom.coordinates);
  else return null;

  const rings=[];
  for (const polygon of polygonGroups) {
    const outer=polygon?.[0];
    if (!Array.isArray(outer) || outer.length < 3) continue;

    const ring=outer
      .map(c=>({lon:Number(c[0]),lat:Number(c[1])}))
      .filter(p=>Number.isFinite(p.lon)&&Number.isFinite(p.lat));

    if (ring.length >= 3) rings.push(ring);
  }
  if (!rings.length) return null;

  let height=Number(props.height);
  if (!Number.isFinite(height) || height <= 0) {
    const floors=Number(props.grnd_flr);
    height=Number.isFinite(floors) && floors>0 ? floors*3.3 : 0;
  }

  const all=rings.flat();
  const bbox={
    minLon:Math.min(...all.map(p=>p.lon)), maxLon:Math.max(...all.map(p=>p.lon)),
    minLat:Math.min(...all.map(p=>p.lat)), maxLat:Math.max(...all.map(p=>p.lat))
  };
  return {
    id:feature.id || "",
    name:props.bld_nm || "",
    height,
    rings,
    bbox,
    properties:props
  };
}

function olPolygonFromLonLatRing(ring) {
  const pts=ring.map(p=>new OpenLayers.Geometry.Point(p.lon,p.lat).transform(displayProjection,mapProjection));

  if (pts.length) {
    const a=pts[0], b=pts[pts.length-1];
    if (a.x!==b.x || a.y!==b.y) pts.push(a.clone());
  }

  return new OpenLayers.Geometry.Polygon([
    new OpenLayers.Geometry.LinearRing(pts)
  ]);
}

function currentViewBounds(padRatio=0.08) {
  if(!map) return bboxAroundSchool(QUERY_RADIUS_M+SCOPE_MARGIN_M);
  const ext=map.getExtent();
  if(!ext) return bboxAroundSchool(QUERY_RADIUS_M+SCOPE_MARGIN_M);
  const b=ext.clone().transform(mapProjection,displayProjection);
  const dx=(b.right-b.left)*padRatio,dy=(b.top-b.bottom)*padRatio;
  return {minLon:b.left-dx,minLat:b.bottom-dy,maxLon:b.right+dx,maxLat:b.top+dy};
}
function bboxIntersects(a,b){return !(a.maxLon<b.minLon||a.minLon>b.maxLon||a.maxLat<b.minLat||a.minLat>b.maxLat);}
function visibleBuildings(limit=Infinity) {
  const bounds=currentViewBounds();
  const center=map.getCenter()?.clone().transform(mapProjection,displayProjection);
  let arr=buildings.filter(b=>b.bbox&&bboxIntersects(b.bbox,bounds));
  if(arr.length>limit && center) {
    arr.sort((a,b)=>{
      const ac={lon:(a.bbox.minLon+a.bbox.maxLon)/2,lat:(a.bbox.minLat+a.bbox.maxLat)/2};
      const bc={lon:(b.bbox.minLon+b.bbox.maxLon)/2,lat:(b.bbox.minLat+b.bbox.maxLat)/2};
      return haversine({lon:center.lon,lat:center.lat},ac)-haversine({lon:center.lon,lat:center.lat},bc);
    });
    arr=arr.slice(0,limit);
  }
  return arr;
}
function drawBuildings() {
  if(!buildingLayer||!map)return;
  buildingLayer.removeAllFeatures();
  const zoom=map.getZoom();
  if(zoom<BUILDING_MIN_ZOOM)return;
  const limit=zoom<=15?900:zoom===16?1600:3000;
  const features=[];
  for(const b of visibleBuildings(limit)) {
    for(const ring of b.rings) {
      features.push(new OpenLayers.Feature.Vector(
        olPolygonFromLonLatRing(ring),{height:b.height,name:b.name},{
          strokeColor:"#596773",strokeWidth:1,strokeOpacity:.62,fillColor:"#71808a",fillOpacity:.09
        }
      ));
    }
  }
  buildingLayer.addFeatures(features);
}

function dayOfYear(y,m,d) {
  const current=new Date(Date.UTC(y,m-1,d));
  const start=new Date(Date.UTC(y,0,0));
  return Math.floor((current-start)/86400000);
}

// NOAA-style solar position approximation.
function solarPosition(hourLocal) {
  const n=dayOfYear(REPRESENTATIVE_DATE.year,REPRESENTATIVE_DATE.month,REPRESENTATIVE_DATE.day);
  const gamma=2*Math.PI/365*(n-1+(hourLocal-12)/24);

  const eqtime=229.18*(
    0.000075 +
    0.001868*Math.cos(gamma) -
    0.032077*Math.sin(gamma) -
    0.014615*Math.cos(2*gamma) -
    0.040849*Math.sin(2*gamma)
  );

  const decl=
    0.006918 -
    0.399912*Math.cos(gamma) +
    0.070257*Math.sin(gamma) -
    0.006758*Math.cos(2*gamma) +
    0.000907*Math.sin(2*gamma) -
    0.002697*Math.cos(3*gamma) +
    0.00148*Math.sin(3*gamma);

  let trueSolarMinutes=hourLocal*60 + eqtime + 4*SCHOOL.lon - 60*SEOUL_TZ;
  trueSolarMinutes=((trueSolarMinutes%1440)+1440)%1440;

  const hourAngle=toRad(trueSolarMinutes/4-180);
  const lat=toRad(SCHOOL.lat);

  const cosZenith=
    Math.sin(lat)*Math.sin(decl) +
    Math.cos(lat)*Math.cos(decl)*Math.cos(hourAngle);

  const zenith=Math.acos(Math.max(-1,Math.min(1,cosZenith)));
  const altitude=90-toDeg(zenith);

  let azimuth=toDeg(Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle)*Math.sin(lat)-Math.tan(decl)*Math.cos(lat)
  )) + 180;

  azimuth=(azimuth+360)%360;
  return {altitude,azimuth};
}

function cross(o,a,b) {
  return (a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
}

function convexHull(points) {
  if (points.length <= 3) return points.slice();

  const sorted=points.slice().sort((a,b)=>a.x===b.x?a.y-b.y:a.x-b.x);
  const lower=[];

  for (const p of sorted) {
    while (lower.length>=2 && cross(lower[lower.length-2],lower[lower.length-1],p)<=0) lower.pop();
    lower.push(p);
  }

  const upper=[];
  for (let i=sorted.length-1;i>=0;i--) {
    const p=sorted[i];
    while (upper.length>=2 && cross(upper[upper.length-2],upper[upper.length-1],p)<=0) upper.pop();
    upper.push(p);
  }

  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function makeBuildingShadowPolygonXY(ring,height,sun) {
  if (!height || height<=0 || sun.altitude<=3) return null;

  const length=Math.min(450,height/Math.tan(toRad(sun.altitude)));
  const shadowAzimuth=toRad((sun.azimuth+180)%360);

  // x = east, y = north.
  const dx=Math.sin(shadowAzimuth)*length;
  const dy=Math.cos(shadowAzimuth)*length;

  const original=ring.map(llToXY);
  const shifted=original.map(p=>({x:p.x+dx,y:p.y+dy}));
  return convexHull(original.concat(shifted));
}

function makeBuildingShadowPolygon(ring,height,sun) {
  const xy=makeBuildingShadowPolygonXY(ring,height,sun);
  return xy ? xy.map(xyToLL) : null;
}

function polygonBBoxXY(poly) {
  return {
    minX:Math.min(...poly.map(p=>p.x)), maxX:Math.max(...poly.map(p=>p.x)),
    minY:Math.min(...poly.map(p=>p.y)), maxY:Math.max(...poly.map(p=>p.y))
  };
}

function pointInPolygonXY(p,poly) {
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++) {
    const a=poly[i],b=poly[j];
    const hit=((a.y>p.y)!==(b.y>p.y)) &&
      (p.x < (b.x-a.x)*(p.y-a.y)/(b.y-a.y+1e-12)+a.x);
    if(hit) inside=!inside;
  }
  return inside;
}

function shadowGridKey(gx,gy){ return gx+","+gy; }

function invalidateShadeAnalysis() {
  analysisShadowIndex=null;
  analysisShadowHour=null;
  edgeShadeCache.clear();
}

function buildShadowAnalysisIndex(hour) {
  if(analysisShadowIndex && analysisShadowHour===hour) return analysisShadowIndex;

  const sun=solarPosition(hour);
  const polygons=[];
  const grid=new Map();

  for(const b of buildings) {
    if(!(b.height>0)) continue;
    for(const ring of b.rings) {
      const poly=makeBuildingShadowPolygonXY(ring,b.height,sun);
      if(!poly || poly.length<3) continue;
      const bbox=polygonBBoxXY(poly);
      const index=polygons.length;
      polygons.push({poly,bbox});

      const minGX=Math.floor(bbox.minX/SHADOW_GRID_M), maxGX=Math.floor(bbox.maxX/SHADOW_GRID_M);
      const minGY=Math.floor(bbox.minY/SHADOW_GRID_M), maxGY=Math.floor(bbox.maxY/SHADOW_GRID_M);
      for(let gx=minGX;gx<=maxGX;gx++) for(let gy=minGY;gy<=maxGY;gy++) {
        const key=shadowGridKey(gx,gy);
        if(!grid.has(key)) grid.set(key,[]);
        grid.get(key).push(index);
      }
    }
  }

  analysisShadowHour=hour;
  analysisShadowIndex={hour,polygons,grid};
  return analysisShadowIndex;
}

function isPointInBuildingShadowXY(p,index) {
  const key=shadowGridKey(Math.floor(p.x/SHADOW_GRID_M),Math.floor(p.y/SHADOW_GRID_M));
  const candidates=index.grid.get(key)||[];
  for(const idx of candidates) {
    const item=index.polygons[idx],b=item.bbox;
    if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY) continue;
    if(pointInPolygonXY(p,item.poly)) return true;
  }
  return false;
}

function analyzeEdgeExposure(edge,index) {
  let shadePlanar=0,sunPlanar=0,totalPlanar=0;
  const geom=edge.geometry||[];
  for(let i=0;i<geom.length-1;i++) {
    const A=geom[i],B=geom[i+1];
    const segLen=pointDistance(A,B);
    if(segLen<=0) continue;
    const pieces=Math.max(1,Math.ceil(segLen/SHADE_SAMPLE_STEP_M));
    const pieceLen=segLen/pieces;
    for(let k=0;k<pieces;k++) {
      const t=(k+0.5)/pieces;
      const p={x:A.x+(B.x-A.x)*t,y:A.y+(B.y-A.y)*t};
      if(isPointInBuildingShadowXY(p,index)) shadePlanar+=pieceLen;
      else sunPlanar+=pieceLen;
    }
    totalPlanar+=segLen;
  }

  const scale=totalPlanar>0 ? edge.length/totalPlanar : 1;
  const shadeDistance=shadePlanar*scale;
  const sunDistance=sunPlanar*scale;
  return {
    shadeDistance,
    sunDistance,
    shadeFraction:edge.length>0?shadeDistance/edge.length:0
  };
}

async function annotateGraphShadeCosts(g) {
  const hour=Number(document.getElementById("timeRange").value);
  const index=buildShadowAnalysisIndex(hour);
  const baseById=new Map((baseGraph?.edges||[]).map(e=>[e.id,e]));
  const cachePrefix=hour+":";

  for(let i=0;i<g.edges.length;i++) {
    const e=g.edges[i];
    let stats=null;
    const base=baseById.get(e.baseId);
    const fullBase=!!base && Math.abs(base.length-e.length)<0.05;
    if(fullBase) {
      const key=cachePrefix+e.baseId;
      stats=edgeShadeCache.get(key)||null;
      if(!stats) {
        stats=analyzeEdgeExposure(base,index);
        edgeShadeCache.set(key,stats);
      }
    } else {
      stats=analyzeEdgeExposure(e,index);
    }
    e.distanceCost=e.length;
    e.shadeDistance=stats.shadeDistance;
    e.sunDistance=stats.sunDistance;
    e.shadeFraction=stats.shadeFraction;
    e.shadeCost=stats.shadeDistance + stats.sunDistance*sunPenalty;

    if(i%90===0) {
      document.getElementById("algoStatus").textContent=
        `도로별 일사 비용 분석 중… ${Math.round(i/g.edges.length*100)}%`;
      await new Promise(r=>setTimeout(r,0));
    }
  }
}

function pathExposureMetrics(edges) {
  return edges.reduce((m,e)=>{
    m.distance+=e.length;
    m.shade+=e.shadeDistance||0;
    m.sun+=e.sunDistance??e.length;
    return m;
  },{distance:0,shade:0,sun:0});
}

function updateBuildingShadows() {
  if(!shadowLayer||!map)return;
  shadowLayer.removeAllFeatures();
  buildingShadowPolygons=[];
  if(!buildings.length||!document.getElementById("showShadows").checked)return;
  const zoom=map.getZoom();
  // 멀리 축소했을 때 수천 개 그림자를 만들지 않는다.
  if(zoom<SHADOW_MIN_ZOOM)return;
  const limit=zoom===16?550:zoom===17?1200:2400;
  const hour=Number(document.getElementById("timeRange").value),sun=solarPosition(hour),features=[];
  const targets=visibleBuildings(limit).filter(b=>b.height>0);
  for(const b of targets) {
    for(const ring of b.rings) {
      const shadow=makeBuildingShadowPolygon(ring,b.height,sun);
      if(!shadow||shadow.length<3)continue;
      buildingShadowPolygons.push(shadow);
      features.push(new OpenLayers.Feature.Vector(
        olPolygonFromLonLatRing(shadow),{height:b.height},{
          strokeColor:"#283846",strokeWidth:.35,strokeOpacity:.08,fillColor:"#243847",fillOpacity:.20
        }
      ));
    }
  }
  shadowLayer.addFeatures(features);
}
function scheduleVisualLodUpdate() {
  if(visualLodTimer)clearTimeout(visualLodTimer);
  visualLodTimer=setTimeout(()=>{
    drawBuildings();
    updateBuildingShadows();
  },120);
}
function handleMapMoveEnd() {
  renderWeightLabels();
  scheduleVisualLodUpdate();
}

function nearestEdgeSnap(ll) {
  if(!baseGraph) return null;
  const p=llToXY(ll);
  let best=null;

  for(const edge of baseGraph.edges) {
    for(let i=0;i<edge.geometry.length-1;i++) {
      const A=edge.geometry[i],B=edge.geometry[i+1];
      const q=projectPointToSegment(p,A,B);
      if(!best || q.d<best.snapDistance) {
        const segStart=edge.cum[i];
        const segLen=pointDistance(A,B);
        const offset=segStart+segLen*q.t;
        const snappedLL=xyToLL(q);
        best={
          edgeId:edge.id,
          offset,
          x:q.x,y:q.y,
          lon:snappedLL.lon,lat:snappedLL.lat,
          snapDistance:q.d
        };
      }
    }
  }
  return best;
}

function handleMapClick(evt) {
  if(!networkReady) return;

  const projected=map.getLonLatFromPixel(evt.xy);
  const ll=projected.clone().transform(mapProjection,displayProjection);
  const clicked={lon:ll.lon,lat:ll.lat};

  if(haversine(SCHOOL,clicked)>QUERY_RADIUS_M+50) {
    document.getElementById("guideTitle").textContent="탐구 범위 밖입니다";
    document.getElementById("guideText").textContent="서초고 주변 약 1km 안쪽을 선택하세요.";
    return;
  }

  const snap=nearestEdgeSnap(clicked);
  if(!snap) return;

  if(selectMode==="start") {
    startSnap=snap;
    selectMode="end";
  } else {
    endSnap=snap;
  }

  clearRouteOnly();
  renderPointMarkers();
  syncUI();
}

function renderPointMarkers() {
  pointLayer.removeAllFeatures();
  addSchoolMarker();

  if(startSnap) pointLayer.addFeatures([makeMarker(startSnap,"S","#159b65")]);
  if(endSnap) pointLayer.addFeatures([makeMarker(endSnap,"G","#e14d61")]);
}

function makeMarker(p,label,color) {
  const g=new OpenLayers.Geometry.Point(p.lon,p.lat).transform(displayProjection,mapProjection);
  return new OpenLayers.Feature.Vector(g,{label},{
    pointRadius:8,fillColor:color,fillOpacity:1,strokeColor:"#fff",strokeWidth:3,
    label,fontColor:"#fff",fontWeight:"bold",fontSize:"10px"
  });
}

function edgePointAtOffset(edge,offset) {
  offset=Math.max(0,Math.min(edge.planarLength,offset));
  for(let i=0;i<edge.cum.length-1;i++) {
    if(offset<=edge.cum[i+1]+1e-9) {
      const span=edge.cum[i+1]-edge.cum[i] || 1;
      const t=(offset-edge.cum[i])/span;
      const A=edge.geometry[i],B=edge.geometry[i+1];
      return {
        x:A.x+(B.x-A.x)*t,y:A.y+(B.y-A.y)*t,
        lon:A.lon+(B.lon-A.lon)*t,lat:A.lat+(B.lat-A.lat)*t
      };
    }
  }
  return edge.geometry[edge.geometry.length-1];
}

function sliceGeometry(edge,startOffset,endOffset) {
  const a=Math.max(0,Math.min(edge.planarLength,startOffset));
  const b=Math.max(0,Math.min(edge.planarLength,endOffset));
  const lo=Math.min(a,b),hi=Math.max(a,b);
  const pts=[edgePointAtOffset(edge,lo)];
  for(let i=1;i<edge.geometry.length-1;i++) {
    if(edge.cum[i]>lo+1e-6 && edge.cum[i]<hi-1e-6) pts.push(edge.geometry[i]);
  }
  pts.push(edgePointAtOffset(edge,hi));
  if(a>b) pts.reverse();
  return pts.map(p=>({lon:p.lon,lat:p.lat,x:p.x,y:p.y}));
}

function buildDynamicGraph() {
  const nodes={...baseGraph.nodes};
  const splitMap=new Map();

  function registerSnap(id,snap) {
    const edge=baseGraph.edges.find(e=>e.id===snap.edgeId);
    if(!edge) return id;

    const ratio=edge.planarLength>0 ? snap.offset/edge.planarLength : 0;
    if(ratio<0.001) return edge.a;
    if(ratio>0.999) return edge.b;

    nodes[id]={id,lon:snap.lon,lat:snap.lat,x:snap.x,y:snap.y};
    if(!splitMap.has(edge.id)) splitMap.set(edge.id,[]);
    splitMap.get(edge.id).push({id,offset:snap.offset});
    return id;
  }

  const startNodeId=registerSnap("S",startSnap);
  const endNodeId=registerSnap("G",endSnap);

  const edges=[];
  let idx=0;

  for(const edge of baseGraph.edges) {
    const splits=(splitMap.get(edge.id)||[]).sort((a,b)=>a.offset-b.offset);
    const points=[{id:edge.a,offset:0},...splits,{id:edge.b,offset:edge.planarLength}];

    const cleaned=[];
    for(const p of points) {
      if(cleaned.length && Math.abs(cleaned[cleaned.length-1].offset-p.offset)<0.05) {
        // If S/G are nearly the same coordinate, preserve the later endpoint only if needed.
        if(p.id==="S"||p.id==="G") cleaned[cleaned.length-1]=p;
      } else cleaned.push(p);
    }

    for(let i=0;i<cleaned.length-1;i++) {
      const a=cleaned[i],b=cleaned[i+1];
      if(a.id===b.id) continue;
      const ratio=(b.offset-a.offset)/(edge.planarLength||1);
      const length=Math.max(0.01,edge.length*Math.abs(ratio));
      edges.push({
        id:"D"+(idx++),baseId:edge.id,a:a.id,b:b.id,length,
        geometry:sliceGeometry(edge,a.offset,b.offset)
      });
    }
  }

  return {nodes,edges,startNodeId,endNodeId};
}

class MinHeap {
  constructor() { this.a=[]; }
  push(item) {
    const a=this.a;a.push(item);let i=a.length-1;
    while(i>0) {
      const p=(i-1)>>1;
      if(a[p].d<=a[i].d) break;
      [a[p],a[i]]=[a[i],a[p]];i=p;
    }
  }
  pop() {
    const a=this.a;if(!a.length)return null;
    const root=a[0],last=a.pop();
    if(a.length) {
      a[0]=last;let i=0;
      while(true) {
        let l=i*2+1,r=l+1,m=i;
        if(l<a.length&&a[l].d<a[m].d)m=l;
        if(r<a.length&&a[r].d<a[m].d)m=r;
        if(m===i)break;
        [a[i],a[m]]=[a[m],a[i]];i=m;
      }
    }
    return root;
  }
  get size() { return this.a.length; }
}

function dijkstra(g,mode="distance",record=false) {
  const adj={};
  for(const id of Object.keys(g.nodes)) adj[id]=[];
  for(const e of g.edges) {
    if(!adj[e.a])adj[e.a]=[];
    if(!adj[e.b])adj[e.b]=[];
    adj[e.a].push({to:e.b,edge:e});
    adj[e.b].push({to:e.a,edge:e});
  }

  const D={},prev={},visited=new Set(),steps=[];
  for(const id of Object.keys(g.nodes)) D[id]=Infinity;
  D[g.startNodeId]=0;

  const heap=new MinHeap();
  heap.push({id:g.startNodeId,d:0});

  while(heap.size) {
    const cur=heap.pop();
    if(!cur || visited.has(cur.id)) continue;
    if(cur.d!==D[cur.id]) continue;

    visited.add(cur.id);
    if(record && steps.length<3000) steps.push({node:cur.id,dist:cur.d,visited:visited.size,mode});
    if(cur.id===g.endNodeId) break;

    for(const item of adj[cur.id]||[]) {
      if(visited.has(item.to)) continue;
      const edgeCost=mode==="shade" ? item.edge.shadeCost : item.edge.distanceCost;
      const alt=cur.d+edgeCost;
      if(alt<D[item.to]) {
        D[item.to]=alt;
        prev[item.to]={node:cur.id,edge:item.edge};
        heap.push({id:item.to,d:alt});
      }
    }
  }

  const nodePath=[];
  const edgePath=[];
  let node=g.endNodeId;

  if(Number.isFinite(D[node])) {
    nodePath.unshift(node);
    while(node!==g.startNodeId) {
      const p=prev[node];
      if(!p) break;
      edgePath.unshift(p.edge);
      node=p.node;
      nodePath.unshift(node);
    }
  }

  return {cost:D[g.endNodeId],nodePath,edgePath,D,visitedCount:visited.size,steps,mode};
}

async function calculateRoute({silent=false}={}) {
  if(!startSnap||!endSnap||!networkReady||!buildingReady)return;

  resetAnimation();
  const button=document.getElementById("routeBtn");
  button.disabled=true;
  if(!silent) document.getElementById("algoStatus").textContent="건물 그림자와 보행 간선의 일사 노출을 분석합니다.";

  try {
    const g=buildDynamicGraph();
    await annotateGraphShadeCosts(g);

    const shortest=dijkstra(g,"distance",true);
    const shade=dijkstra(g,"shade",true);

    if(!Number.isFinite(shortest.cost)||!Number.isFinite(shade.cost)||!shortest.edgePath.length||!shade.edgePath.length) {
      document.getElementById("algoStatus").textContent="연결 가능한 보행 경로를 찾지 못했습니다. 다른 지점을 선택해 보세요.";
      return;
    }

    const shortMetrics=pathExposureMetrics(shortest.edgePath);
    const shadeMetrics=pathExposureMetrics(shade.edgePath);
    lastRoute={g,shortest,shade,shortMetrics,shadeMetrics};

    drawRoutes();
    renderWeightLabels();
    renderRouteMetrics();

    document.getElementById("algoStatus").textContent=
      `계산 완료 · 그늘 중요도 ${sunPenalty.toFixed(1)}× · 최단 ${Math.round(shortMetrics.distance)}m / 그늘우선 ${Math.round(shadeMetrics.distance)}m · 햇빛 노출 ${Math.round(shortMetrics.sun)}m → ${Math.round(shadeMetrics.sun)}m`;

    document.getElementById("animateShortBtn").disabled=false;
    document.getElementById("animateShadeBtn").disabled=false;
    document.getElementById("guideTitle").textContent="두 경로 계산 완료";
    document.getElementById("guideText").textContent="주황 점선은 최단거리, 초록 실선은 건물 그림자를 반영한 그늘우선 경로입니다.";
  } finally {
    syncUI();
  }
}

function renderRouteMetrics() {
  if(!lastRoute)return;
  const sm=lastRoute.shortMetrics,hm=lastRoute.shadeMetrics;
  document.getElementById("shortDistance").textContent=sm.distance<1000?Math.round(sm.distance)+" m":(sm.distance/1000).toFixed(2)+" km";
  document.getElementById("shortSun").textContent=`햇빛 노출 ${Math.round(sm.sun)} m · 그늘 ${Math.round(sm.shade)} m`;
  document.getElementById("shadeDistance").textContent=hm.distance<1000?Math.round(hm.distance)+" m":(hm.distance/1000).toFixed(2)+" km";
  document.getElementById("shadeSun").textContent=`햇빛 노출 ${Math.round(hm.sun)} m · 그늘 ${Math.round(hm.shade)} m`;
  document.getElementById("extraDistance").textContent=(hm.distance-sm.distance>=0?"+":"")+Math.round(hm.distance-sm.distance)+" m";
  const reduction=sm.sun>0?(1-hm.sun/sm.sun)*100:0;
  document.getElementById("exposureReduction").textContent=Math.max(0,reduction).toFixed(1)+"%";
  document.getElementById("shortVisited").textContent=lastRoute.shortest.visitedCount.toLocaleString()+"개";
  document.getElementById("shadeVisited").textContent=lastRoute.shade.visitedCount.toLocaleString()+"개";
}

function orientedEdgeGeometry(edge,fromNode,toNode) {
  if(edge.a===fromNode && edge.b===toNode) return edge.geometry;
  if(edge.b===fromNode && edge.a===toNode) return [...edge.geometry].reverse();
  return edge.geometry;
}

function makeRouteFeatures(result,style,routeName) {
  const features=[];
  for(let i=0;i<result.edgePath.length;i++) {
    const edge=result.edgePath[i];
    const from=result.nodePath[i],to=result.nodePath[i+1];
    const geom=orientedEdgeGeometry(edge,from,to);
    const pts=geom.map(p=>new OpenLayers.Geometry.Point(p.lon,p.lat).transform(displayProjection,mapProjection));
    features.push(new OpenLayers.Feature.Vector(
      new OpenLayers.Geometry.LineString(pts),
      {route:routeName,shadeFraction:edge.shadeFraction},
      style
    ));
  }
  return features;
}

function drawRoutes() {
  routeLayer.removeAllFeatures();
  if(!lastRoute)return;

  const features=[];
  if(routeView==="both"||routeView==="shortest") {
    features.push(...makeRouteFeatures(lastRoute.shortest,{
      strokeColor:"#f0a51a",strokeWidth:5,strokeOpacity:.95,strokeDashstyle:"dash"
    },"shortest"));
  }
  if(routeView==="both"||routeView==="shade") {
    features.push(...makeRouteFeatures(lastRoute.shade,{
      strokeColor:"#16835a",strokeWidth:6,strokeOpacity:.96
    },"shade"));
  }
  routeLayer.addFeatures(features);
}

function routeForLabels() {
  if(!lastRoute)return null;
  if(routeView==="shortest") return {result:lastRoute.shortest,mode:"short"};
  return {result:lastRoute.shade,mode:"shade"};
}

function renderWeightLabels() {
  const layer=document.getElementById("weightLayer");
  layer.innerHTML="";
  if(!lastRoute || !document.getElementById("showWeights").checked || !map)return;

  const selected=routeForLabels();
  if(!selected)return;
  const {result,mode}=selected;
  const g=lastRoute.g;
  let cumulative=0;

  for(let i=0;i<result.nodePath.length;i++) {
    if(i>0) {
      const e=result.edgePath[i-1];
      cumulative+=mode==="shade"?e.shadeCost:e.distanceCost;
    }
    if(i!==0 && i!==result.nodePath.length-1 && i%3!==0) continue;

    const id=result.nodePath[i],n=g.nodes[id];
    if(!n)continue;
    const ll=new OpenLayers.LonLat(n.lon,n.lat).transform(displayProjection,mapProjection);
    const px=map.getPixelFromLonLat(ll);if(!px)continue;

    const el=document.createElement("div");
    el.className="weight-label "+mode;
    el.style.left=px.x+"px";el.style.top=px.y+"px";
    const prefix=id==="S"?"S":id==="G"?"G":"node";
    el.textContent=mode==="shade"?`${prefix} · 비용 ${Math.round(cumulative)}`:`${prefix} · ${Math.round(cumulative)}m`;
    layer.appendChild(el);
  }
}

function animateDijkstra(mode) {
  if(!lastRoute)return;
  resetAnimation();

  const result=mode==="shade"?lastRoute.shade:lastRoute.shortest;
  const steps=result.steps;
  const g=lastRoute.g;
  let i=0;
  document.getElementById("algoStatus").textContent=mode==="shade"?"그늘우선 Dijkstra 탐색을 재생합니다.":"최단거리 Dijkstra 탐색을 재생합니다.";

  function tick() {
    if(i>=steps.length) {
      algorithmLayer.removeAllFeatures();
      document.getElementById("algoStatus").textContent=mode==="shade"
        ?`그늘우선 탐색 완료 · 누적 일사비용 ${Math.round(result.cost)}`
        :`최단거리 탐색 완료 · 누적거리 ${Math.round(result.cost)}m`;
      return;
    }

    const step=steps[i++],n=g.nodes[step.node];
    if(n) {
      algorithmLayer.removeAllFeatures();
      const geom=new OpenLayers.Geometry.Point(n.lon,n.lat).transform(displayProjection,mapProjection);
      const color=mode==="shade"?"#16835a":"#d39a00";
      const fill=mode==="shade"?"#dff5e9":"#fff0b8";
      algorithmLayer.addFeatures([new OpenLayers.Feature.Vector(
        geom,{node:step.node},{
          pointRadius:7,fillColor:fill,strokeColor:color,strokeWidth:2,
          label:Math.round(step.dist)+(mode==="shade"?"":"m"),fontColor:"#17212b",fontSize:"9px",
          labelYOffset:-14,labelOutlineColor:"#fff",labelOutlineWidth:3
        }
      )]);
    }

    document.getElementById("algoStatus").textContent=mode==="shade"
      ?`그늘우선 · 확정 노드 ${step.visited.toLocaleString()}개 · 현재 최소 누적비용 ${Math.round(step.dist)}`
      :`최단거리 · 확정 노드 ${step.visited.toLocaleString()}개 · 현재 최소 누적거리 ${Math.round(step.dist)}m`;
    animationTimer=setTimeout(tick,Math.max(18,Math.min(70,3500/Math.max(1,steps.length))));
  }
  tick();
}

function resetAnimation() {
  if(animationTimer) {clearTimeout(animationTimer);animationTimer=null;}
  if(algorithmLayer) algorithmLayer.removeAllFeatures();
}

function clearRouteOnly() {
  lastRoute=null;
  resetAnimation();
  if(routeLayer) routeLayer.removeAllFeatures();
  document.getElementById("weightLayer").innerHTML="";
  ["shortDistance","shadeDistance","extraDistance","exposureReduction","shortVisited","shadeVisited"].forEach(id=>document.getElementById(id).textContent="—");
  document.getElementById("shortSun").textContent="햇빛 노출 —";
  document.getElementById("shadeSun").textContent="햇빛 노출 —";
  document.getElementById("animateShortBtn").disabled=true;
  document.getElementById("animateShadeBtn").disabled=true;
}

function syncUI() {
  document.getElementById("startBtn").classList.toggle("active",selectMode==="start");
  document.getElementById("endBtn").classList.toggle("active",selectMode==="end");

  document.getElementById("startInfo").textContent=startSnap
    ? `도로에 스냅 · 오차 ${startSnap.snapDistance.toFixed(1)}m`
    : networkReady?"지도에서 선택":"보행망 로딩 대기";
  document.getElementById("endInfo").textContent=endSnap
    ? `도로에 스냅 · 오차 ${endSnap.snapDistance.toFixed(1)}m`
    : networkReady?"지도에서 선택":"보행망 로딩 대기";

  const ready=networkReady&&buildingReady&&startSnap&&endSnap;
  document.getElementById("routeBtn").disabled=!ready;

  if(!networkReady)return;
  if(!startSnap) {
    document.getElementById("guideTitle").textContent="출발점을 선택하세요";
    document.getElementById("guideText").textContent="지도 아무 곳을 클릭하면 실제 보행도로에 자동으로 붙습니다.";
  } else if(!endSnap) {
    document.getElementById("guideTitle").textContent="도착점을 선택하세요";
    document.getElementById("guideText").textContent="다른 위치를 클릭해 목적지를 지정하세요.";
  } else if(!lastRoute) {
    document.getElementById("guideTitle").textContent="S/G 임시 노드 생성 완료";
    document.getElementById("guideText").textContent="왼쪽의 최단거리 + 그늘우선 계산 버튼을 누르세요.";
  }
}

function updateShadePriority({recalculate=true}={}) {
  const range=document.getElementById("shadePriorityRange");
  if(!range)return;

  sunPenalty=Number(range.value);
  document.getElementById("shadePriorityLabel").textContent=sunPenalty.toFixed(1)+"×";

  const formula=document.getElementById("shadeFormula");
  if(formula) {
    formula.textContent=
      `그늘우선 비용 = 건물그늘거리 × 1.0 + 직사광선거리 × ${sunPenalty.toFixed(1)}`;
  }

  if(recalculate && lastRoute && startSnap && endSnap && networkReady && buildingReady) {
    if(routeRecalcTimer) clearTimeout(routeRecalcTimer);
    document.getElementById("algoStatus").textContent=
      `그늘 중요도를 ${sunPenalty.toFixed(1)}×로 변경해 경로를 다시 계산합니다.`;
    routeRecalcTimer=setTimeout(()=>calculateRoute({silent:true}),180);
  }
}

function updateTime() {
  const hour=Number(document.getElementById("timeRange").value);
  document.getElementById("timeLabel").textContent=String(hour).padStart(2,"0")+":00";

  const sun=solarPosition(hour);
  document.getElementById("sunAltitude").textContent=sun.altitude.toFixed(1)+"°";
  document.getElementById("sunAzimuth").textContent=sun.azimuth.toFixed(0)+"°";

  let state;
  if (sun.azimuth < 135) state="남동쪽";
  else if (sun.azimuth < 225) state="남쪽~남서쪽";
  else state="서쪽";

  document.getElementById("sunState").textContent=
    `${state} · 태양 고도 ${sun.altitude.toFixed(1)}°`;

  invalidateShadeAnalysis();
  updateBuildingShadows();
  if(lastRoute&&startSnap&&endSnap&&networkReady&&buildingReady) {
    if(routeRecalcTimer)clearTimeout(routeRecalcTimer);
    document.getElementById("algoStatus").textContent="시간대가 바뀌어 그늘우선 경로를 다시 계산합니다.";
    routeRecalcTimer=setTimeout(()=>calculateRoute({silent:true}),320);
  }
}


document.getElementById("startBtn").addEventListener("click",()=>{selectMode="start";syncUI();});
document.getElementById("endBtn").addEventListener("click",()=>{selectMode="end";syncUI();});
document.getElementById("routeBtn").addEventListener("click",calculateRoute);
document.getElementById("animateShortBtn").addEventListener("click",()=>animateDijkstra("distance"));
document.getElementById("animateShadeBtn").addEventListener("click",()=>animateDijkstra("shade"));
document.querySelectorAll(".route-tab").forEach(btn=>btn.addEventListener("click",()=>{
  document.querySelectorAll(".route-tab").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  routeView=btn.dataset.route;
  drawRoutes();
  renderWeightLabels();
}));
document.getElementById("resetBtn").addEventListener("click",()=>{
  startSnap=null;endSnap=null;selectMode="start";clearRouteOnly();
  if(pointLayer){pointLayer.removeAllFeatures();addSchoolMarker();}
  syncUI();
});
document.getElementById("recenterBtn").addEventListener("click",recenter);
document.getElementById("retryNetworkBtn").addEventListener("click",()=>loadWalkingNetwork({force:true}));
document.getElementById("timeRange").addEventListener("input",updateTime);
document.getElementById("shadePriorityRange").addEventListener("input",()=>updateShadePriority({recalculate:true}));
document.getElementById("showNetwork").addEventListener("change",e=>{networkLayer.setVisibility(e.target.checked);});
document.getElementById("showBuildings").addEventListener("change",e=>{buildingLayer.setVisibility(e.target.checked);if(e.target.checked)drawBuildings();});
document.getElementById("showShadows").addEventListener("change",e=>{shadowLayer.setVisibility(e.target.checked);if(e.target.checked)updateBuildingShadows();else shadowLayer.removeAllFeatures();});
document.getElementById("showJunctions").addEventListener("change",drawJunctions);
document.getElementById("showWeights").addEventListener("change",renderWeightLabels);

window.addEventListener("load",()=>{updateShadePriority({recalculate:false});updateTime();syncUI();initMap();});
window.addEventListener("resize",renderWeightLabels);
