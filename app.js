const W=1200,H=760;
const X=[120,205,300,395,500,605,715,825,930,1035,1110];
const Y=[85,160,245,335,425,515,610,690];
const MAJOR_X=new Set([300,605,930]);
const MAJOR_Y=new Set([160,425,610]);

const svg=document.getElementById("citySvg");
const roadLayer=document.getElementById("roadLayer");
const buildingLayer=document.getElementById("buildingLayer");
const shadowLayer=document.getElementById("shadowLayer");
const treeLayer=document.getElementById("treeLayer");
const treeShadowLayer=document.getElementById("treeShadowLayer");
const waterLayer=document.getElementById("waterLayer");
const graphNodeLayer=document.getElementById("graphNodeLayer");
const markerLayer=document.getElementById("markerLayer");
const algorithmLayer=document.getElementById("algorithmLayer");
const weightLayer=document.getElementById("weightLayer");
const hoverTip=document.getElementById("hoverTip");
const objectTip=document.getElementById("objectTip");
const costBadge=document.getElementById("algoCostBadge");

let timeHour=14, mode="start", startPoint=null,endPoint=null,routeView="both";
let buildingsVisible=true, treesVisible=true, shadowsVisible=true, animationTimer=null;
let baseNodes={},baseEdges=[],buildings=[],trees=[],buildingShadowPolys=[],treeShadowPolys=[];
let finalResult=null;

function seeded(seed){let s=seed>>>0;return()=>((s=(s*1664525+1013904223)>>>0)/4294967296)}
const rnd=seeded(20260819);
const svgNS="http://www.w3.org/2000/svg";

function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
function edgeKey(a,b){return [a,b].sort().join("|")}
function lerp(a,b,t){return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t}}

function buildCityGraph(){
  baseNodes={};baseEdges=[];
  for(let yi=0;yi<Y.length;yi++){
    for(let xi=0;xi<X.length;xi++){
      const id=`N${xi}_${yi}`;
      baseNodes[id]={id,x:X[xi],y:Y[yi]};
    }
  }
  let eid=0;
  function addEdge(a,b,major=false){
    const A=baseNodes[a],B=baseNodes[b];
    baseEdges.push({id:`E${eid++}`,a,b,major,length:dist(A,B)});
  }
  for(let yi=0;yi<Y.length;yi++){
    for(let xi=0;xi<X.length-1;xi++){
      const major=MAJOR_Y.has(Y[yi]);
      addEdge(`N${xi}_${yi}`,`N${xi+1}_${yi}`,major);
    }
  }
  for(let xi=0;xi<X.length;xi++){
    for(let yi=0;yi<Y.length-1;yi++){
      const major=MAJOR_X.has(X[xi]);
      addEdge(`N${xi}_${yi}`,`N${xi}_${yi+1}`,major);
    }
  }
}
function generateBuildings(){
  buildings=[];
  let id=0;
  const uses=["업무","상업","주거","복합","공공"];
  for(let yi=0;yi<Y.length-1;yi++){
    for(let xi=0;xi<X.length-1;xi++){
      const left=X[xi]+16,right=X[xi+1]-16,top=Y[yi]+16,bottom=Y[yi+1]-16;
      const cellW=right-left,cellH=bottom-top;
      const cols=cellW>80?2:1, rows=cellH>75?2:1;
      for(let r=0;r<rows;r++){
        for(let c=0;c<cols;c++){
          if(rnd()<.08)continue;
          const pad=4+rnd()*5;
          const sx=cellW/cols, sy=cellH/rows;
          const w=Math.max(20,sx-pad*2-(rnd()*7));
          const h=Math.max(18,sy-pad*2-(rnd()*7));
          const x=left+c*sx+pad+(rnd()*4);
          const y=top+r*sy+pad+(rnd()*4);
          const height=28+Math.round(rnd()*155);
          buildings.push({
            id:`B${id++}`,x,y,w,h,height,
            floors:Math.max(3,Math.round(height/3.7)),
            use:uses[Math.floor(rnd()*uses.length)],
            roof:rnd()>.78?"옥상녹화":"일반옥상"
          });
        }
      }
    }
  }
}
function generateTrees(){
  trees=[];
  let id=0;
  const species=[
    {name:"은행나무",h:[8,16],c:[4.0,8.0]},
    {name:"느티나무",h:[9,18],c:[5.0,10.0]},
    {name:"양버즘나무",h:[10,20],c:[5.5,11.0]},
    {name:"이팝나무",h:[6,12],c:[3.5,7.0]},
    {name:"메타세쿼이아",h:[12,24],c:[3.5,6.5]}
  ];
  const margin=8;
  for(const e of baseEdges){
    // Major roads have denser roadside trees, minor roads fewer.
    const A=baseNodes[e.a],B=baseNodes[e.b];
    const len=e.length;
    const spacing=e.major?34:58;
    const count=Math.max(0,Math.floor(len/spacing)-1);
    const dx=(B.x-A.x)/len,dy=(B.y-A.y)/len;
    const nx=-dy,ny=dx;
    for(let i=1;i<=count;i++){
      if(rnd()<(e.major?.08:.28)) continue;
      const t=i/(count+1);
      const base=lerp(A,B,t);
      // alternate sides of road
      const side=(i%2===0?1:-1);
      const roadOffset=(e.major?16:12)+margin+rnd()*5;
      const sp=species[Math.floor(rnd()*species.length)];
      const hgt=sp.h[0]+rnd()*(sp.h[1]-sp.h[0]);
      const canopy=sp.c[0]+rnd()*(sp.c[1]-sp.c[0]);
      const x=base.x+nx*roadOffset*side;
      const y=base.y+ny*roadOffset*side;
      trees.push({
        id:`T${id++}`,x,y,
        species:sp.name,
        height:+hgt.toFixed(1),
        canopy:+canopy.toFixed(1),
        dbh:Math.round(18+rnd()*42),
        health:["양호","양호","양호","보통"][Math.floor(rnd()*4)]
      });
    }
  }
}
function solarParams(hour){
  const altitude=Math.max(24,68-Math.abs(hour-13)*8.2);
  const shadowAngleDeg=145-(hour-11)*17;
  const rad=shadowAngleDeg*Math.PI/180;
  const scale=0.52/Math.tan(altitude*Math.PI/180);
  return {altitude,dx:Math.cos(rad)*scale,dy:Math.sin(rad)*scale,angle:shadowAngleDeg};
}
function convexHull(points){
  points=points.slice().sort((a,b)=>a.x===b.x?a.y-b.y:a.x-b.x);
  const cross=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
  const lower=[];for(const p of points){while(lower.length>=2&&cross(lower.at(-2),lower.at(-1),p)<=0)lower.pop();lower.push(p)}
  const upper=[];for(let i=points.length-1;i>=0;i--){const p=points[i];while(upper.length>=2&&cross(upper.at(-2),upper.at(-1),p)<=0)upper.pop();upper.push(p)}
  upper.pop();lower.pop();return lower.concat(upper);
}
function makeBuildingShadowPoly(b){
  const s=solarParams(timeHour),dx=s.dx*b.height,dy=s.dy*b.height;
  const pts=[
    {x:b.x,y:b.y},{x:b.x+b.w,y:b.y},{x:b.x+b.w,y:b.y+b.h},{x:b.x,y:b.y+b.h},
    {x:b.x+dx,y:b.y+dy},{x:b.x+b.w+dx,y:b.y+dy},{x:b.x+b.w+dx,y:b.y+b.h+dy},{x:b.x+dx,y:b.y+b.h+dy}
  ];
  return convexHull(pts);
}
function makeTreeShadowPoly(t){
  const s=solarParams(timeHour);
  const dx=s.dx*t.height,dy=s.dy*t.height;
  const r=Math.max(2.5,t.canopy*2.0); // visual scale for mock map units
  const cx=t.x+dx,cy=t.y+dy;
  // Elliptical crown shadow, stretched from tree base toward projected crown.
  const ang=Math.atan2(dy,dx);
  const ux=Math.cos(ang),uy=Math.sin(ang),vx=-uy,vy=ux;
  const halfL=Math.max(r,Math.hypot(dx,dy)/2+r*.55);
  const halfW=r*.75;
  const mid={x:(t.x+cx)/2,y:(t.y+cy)/2};
  const pts=[];
  for(let i=0;i<16;i++){
    const a=i/16*Math.PI*2;
    pts.push({
      x:mid.x+ux*Math.cos(a)*halfL+vx*Math.sin(a)*halfW,
      y:mid.y+uy*Math.cos(a)*halfL+vy*Math.sin(a)*halfW
    });
  }
  return pts;
}
function pointInPoly(p,poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const a=poly[i],b=poly[j];
    const hit=((a.y>p.y)!==(b.y>p.y))&&(p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y+1e-9)+a.x);
    if(hit)inside=!inside;
  }
  return inside;
}
function classifyShadeAtPoint(p){
  for(const poly of buildingShadowPolys) if(pointInPoly(p,poly)) return "building";
  for(const poly of treeShadowPolys) if(pointInPoly(p,poly)) return "tree";
  return "sun";
}
function segmentShadeBreakdown(A,B){
  const samples=17;
  let building=0,tree=0,sun=0;
  for(let i=0;i<samples;i++){
    const p=lerp(A,B,(i+.5)/samples);
    const type=classifyShadeAtPoint(p);
    if(type==="building")building++;
    else if(type==="tree")tree++;
    else sun++;
  }
  return {building:building/samples,tree:tree/samples,sun:sun/samples};
}
function segmentShadeRatio(A,B){
  const s=segmentShadeBreakdown(A,B);
  return s.building+s.tree;
}
function drawCity(){
  waterLayer.innerHTML=`<path class="water" d="M0,0 L75,0 C110,150 45,300 95,470 C125,570 75,670 90,760 L0,760 Z"/>`;
  buildingLayer.innerHTML="";shadowLayer.innerHTML="";treeLayer.innerHTML="";treeShadowLayer.innerHTML="";roadLayer.innerHTML="";
  buildingShadowPolys=buildings.map(makeBuildingShadowPoly);
  treeShadowPolys=trees.map(makeTreeShadowPoly);

  buildingShadowPolys.forEach(poly=>{
    const el=document.createElementNS(svgNS,"polygon");
    el.setAttribute("class","shadow-poly");
    el.setAttribute("points",poly.map(p=>`${p.x},${p.y}`).join(" "));
    shadowLayer.appendChild(el);
  });
  treeShadowPolys.forEach(poly=>{
    const el=document.createElementNS(svgNS,"polygon");
    el.setAttribute("class","tree-shadow");
    el.setAttribute("points",poly.map(p=>`${p.x},${p.y}`).join(" "));
    treeShadowLayer.appendChild(el);
  });

  buildings.forEach(b=>{
    const el=document.createElementNS(svgNS,"rect");
    el.setAttribute("class","building");
    el.setAttribute("x",b.x);el.setAttribute("y",b.y);el.setAttribute("width",b.w);el.setAttribute("height",b.h);
    el.dataset.id=b.id;
    el.addEventListener("mousemove",ev=>showObjectTip(ev,
      `<b>${b.id} · ${b.use} 건물</b><br>높이 ${b.height}m · 약 ${b.floors}층<br>외곽 ${Math.round(b.w)}×${Math.round(b.h)} 지도단위<br>${b.roof}`));
    el.addEventListener("mouseleave",hideObjectTip);
    buildingLayer.appendChild(el);
  });

  trees.forEach(t=>{
    const trunk=document.createElementNS(svgNS,"circle");
    trunk.setAttribute("class","tree-trunk");trunk.setAttribute("cx",t.x);trunk.setAttribute("cy",t.y);trunk.setAttribute("r",1.7);
    treeLayer.appendChild(trunk);
    const el=document.createElementNS(svgNS,"circle");
    el.setAttribute("class","tree-canopy");el.setAttribute("cx",t.x);el.setAttribute("cy",t.y);el.setAttribute("r",Math.max(3.2,t.canopy*.58));
    el.dataset.id=t.id;
    el.addEventListener("mousemove",ev=>showObjectTip(ev,
      `<b>${t.id} · ${t.species}</b><br>수고 ${t.height}m · 수관폭 ${t.canopy}m<br>흉고지름 ${t.dbh}cm · 상태 ${t.health}`));
    el.addEventListener("mouseleave",hideObjectTip);
    treeLayer.appendChild(el);
  });

  baseEdges.forEach(e=>{
    const A=baseNodes[e.a],B=baseNodes[e.b];
    const halo=document.createElementNS(svgNS,"line");
    halo.setAttribute("x1",A.x);halo.setAttribute("y1",A.y);halo.setAttribute("x2",B.x);halo.setAttribute("y2",B.y);
    halo.setAttribute("class",`road-halo ${e.major?"major":"minor"}`);
    roadLayer.appendChild(halo);
    const line=document.createElementNS(svgNS,"line");
    line.setAttribute("x1",A.x);line.setAttribute("y1",A.y);line.setAttribute("x2",B.x);line.setAttribute("y2",B.y);
    line.setAttribute("class",`road ${e.major?"major":"minor"}`);
    line.dataset.edge=e.id;
    line.addEventListener("mousemove",ev=>showRoadHover(ev,e));
    line.addEventListener("mouseleave",()=>hoverTip.classList.add("hidden"));
    roadLayer.appendChild(line);
  });
  buildingLayer.style.display=buildingsVisible?"":"none";
  treeLayer.style.display=treesVisible?"":"none";
  shadowLayer.style.display=shadowsVisible?"":"none";
  treeShadowLayer.style.display=shadowsVisible?"":"none";
  drawGraphNodes();
  updateDataSummary();
}
function showObjectTip(ev,html){
  const mapRect=document.getElementById("map").getBoundingClientRect();
  objectTip.classList.remove("hidden");
  objectTip.style.left=(ev.clientX-mapRect.left+12)+"px";
  objectTip.style.top=(ev.clientY-mapRect.top+12)+"px";
  objectTip.innerHTML=html;
}
function hideObjectTip(){objectTip.classList.add("hidden")}
function updateDataSummary(){
  document.getElementById("buildingCount").textContent=buildings.length+"개";
  document.getElementById("treeCount").textContent=trees.length+"주";
  document.getElementById("roadCount").textContent=baseEdges.length+"개";
}
function drawGraphNodes(){
  graphNodeLayer.innerHTML="";
  if(!document.getElementById("showGraph").checked)return;
  Object.values(baseNodes).forEach(n=>{
    const c=document.createElementNS(svgNS,"circle");
    c.setAttribute("class","graph-node");c.setAttribute("cx",n.x);c.setAttribute("cy",n.y);c.setAttribute("r",3.8);
    graphNodeLayer.appendChild(c);
  });
}
function screenFromSvg(x,y){
  const rect=document.getElementById("map").getBoundingClientRect();
  return {left:x/W*rect.width,top:y/H*rect.height};
}
function showRoadHover(ev,e){
  const A=baseNodes[e.a],B=baseNodes[e.b],s=segmentShadeBreakdown(A,B);
  hoverTip.classList.remove("hidden");
  const mapRect=document.getElementById("map").getBoundingClientRect();
  hoverTip.style.left=(ev.clientX-mapRect.left+12)+"px";hoverTip.style.top=(ev.clientY-mapRect.top+12)+"px";
  const cost=e.length*s.building + e.length*s.tree*1.3 + e.length*s.sun*3;
  hoverTip.innerHTML=`<b>도로 ${e.id}</b><br>${e.major?"간선도로":"보행 연결도로"} · ${Math.round(e.length)}m<br>건물그늘 ${Math.round(s.building*100)}% · 가로수그늘 ${Math.round(s.tree*100)}%<br>직사광선 ${Math.round(s.sun*100)}% · 그늘우선 비용 ${Math.round(cost)}`;
}
function nearestRoadPoint(p){
  let best=null;
  for(const e of baseEdges){
    const A=baseNodes[e.a],B=baseNodes[e.b];
    const vx=B.x-A.x,vy=B.y-A.y;
    const len2=vx*vx+vy*vy;
    let t=((p.x-A.x)*vx+(p.y-A.y)*vy)/len2;
    t=Math.max(0,Math.min(1,t));
    const q={x:A.x+vx*t,y:A.y+vy*t};
    const d=dist(p,q);
    if(!best||d<best.d)best={edgeId:e.id,t,x:q.x,y:q.y,d};
  }
  return best;
}
function eventSvgPoint(ev){
  const rect=svg.getBoundingClientRect();
  return {x:(ev.clientX-rect.left)/rect.width*W,y:(ev.clientY-rect.top)/rect.height*H};
}
svg.addEventListener("click",ev=>{
  if(ev.target.closest?.(".map-note"))return;
  const p=nearestRoadPoint(eventSvgPoint(ev));
  const selected={edgeId:p.edgeId,t:p.t,x:p.x,y:p.y};
  if(mode==="start"){startPoint=selected;mode="end";}
  else endPoint=selected;
  syncUI();drawMarkers();clearResults();
});

function drawMarkers(){
  markerLayer.innerHTML="";
  if(startPoint){
    markerLayer.innerHTML+=`<circle class="marker-start" cx="${startPoint.x}" cy="${startPoint.y}" r="9"/><text x="${startPoint.x}" y="${startPoint.y-15}" text-anchor="middle" font-size="12" font-weight="800" fill="#149c65">S</text>`;
  }
  if(endPoint){
    markerLayer.innerHTML+=`<circle class="marker-end" cx="${endPoint.x}" cy="${endPoint.y}" r="9"/><text x="${endPoint.x}" y="${endPoint.y-15}" text-anchor="middle" font-size="12" font-weight="800" fill="#e0495d">G</text>`;
  }
}

function buildDynamicGraph(){
  const nodes={...baseNodes},splits={};
  if(startPoint){nodes.S={id:"S",x:startPoint.x,y:startPoint.y};(splits[startPoint.edgeId]??=[]).push({id:"S",t:startPoint.t});}
  if(endPoint){nodes.G={id:"G",x:endPoint.x,y:endPoint.y};(splits[endPoint.edgeId]??=[]).push({id:"G",t:endPoint.t});}
  const edges=[];
  for(const e of baseEdges){
    const A=baseNodes[e.a],B=baseNodes[e.b];
    const list=[{id:e.a,t:0},...(splits[e.id]||[]).sort((a,b)=>a.t-b.t),{id:e.b,t:1}];
    for(let i=0;i<list.length-1;i++){
      const p=list[i],q=list[i+1];
      if(p.id===q.id||Math.abs(p.t-q.t)<1e-8)continue;
      const PA=nodes[p.id],PB=nodes[q.id];
      const length=dist(PA,PB);
      const shadeParts=segmentShadeBreakdown(PA,PB);
      const shade=shadeParts.building+shadeParts.tree;
      edges.push({id:`${e.id}_${i}`,baseId:e.id,a:p.id,b:q.id,length,shade,shadeParts,major:e.major});
    }
  }
  return {nodes,edges};
}
function adjacency(g,kind){
  const adj={};Object.keys(g.nodes).forEach(k=>adj[k]=[]);
  for(const e of g.edges){
    const cost=kind==="short"?e.length:e.length*e.shadeParts.building + e.length*e.shadeParts.tree*1.3 + e.length*e.shadeParts.sun*3;
    adj[e.a].push({to:e.b,e,cost});adj[e.b].push({to:e.a,e,cost});
  }
  return adj;
}
function dijkstra(g,kind,record=false){
  const adj=adjacency(g,kind),D={},P={},vis=new Set(),steps=[];
  Object.keys(g.nodes).forEach(k=>D[k]=Infinity);D.S=0;
  while(vis.size<Object.keys(g.nodes).length){
    let u=null,b=Infinity;
    for(const id of Object.keys(g.nodes)){if(!vis.has(id)&&D[id]<b){b=D[id];u=id}}
    if(u===null)break;
    if(record)steps.push({type:"select",node:u,cost:D[u]});
    vis.add(u);if(u==="G")break;
    for(const it of adj[u]){
      if(vis.has(it.to))continue;
      if(record)steps.push({type:"inspect",from:u,to:it.to,edge:it.e});
      const alt=D[u]+it.cost;
      if(alt<D[it.to]){
        D[it.to]=alt;P[it.to]=u;
        if(record)steps.push({type:"update",node:it.to,cost:alt,from:u,edge:it.e});
      }
    }
  }
  const path=[];let cur="G";
  if(D.G<Infinity){while(cur){path.unshift(cur);if(cur==="S")break;cur=P[cur]}}
  return {path,cost:D.G,D,steps};
}
function pathEdges(g,path){
  const out=[];
  for(let i=0;i<path.length-1;i++){
    const a=path[i],b=path[i+1];
    out.push(g.edges.find(e=>(e.a===a&&e.b===b)||(e.a===b&&e.b===a)));
  }
  return out.filter(Boolean);
}
function pathMetrics(edges){
  let distance=0,sun=0,buildingShade=0,treeShade=0;
  edges.forEach(e=>{
    distance+=e.length;
    buildingShade+=e.length*e.shadeParts.building;
    treeShade+=e.length*e.shadeParts.tree;
    sun+=e.length*e.shadeParts.sun;
  });
  return {distance,sun,shade:buildingShade+treeShade,buildingShade,treeShade};
}
function routePoints(g,path){return path.map(id=>`${g.nodes[id].x},${g.nodes[id].y}`).join(" ")}
function calculate(){
  if(!startPoint||!endPoint)return;
  const g=buildDynamicGraph(),short=dijkstra(g,"short"),shade=dijkstra(g,"shade");
  const shortEdges=pathEdges(g,short.path),shadeEdges=pathEdges(g,shade.path);
  const sm=pathMetrics(shortEdges),hm=pathMetrics(shadeEdges);
  finalResult={g,short,shade,shortEdges,shadeEdges,sm,hm};
  document.getElementById("shortRoute").setAttribute("points",routePoints(g,short.path));
  document.getElementById("shadeRoute").setAttribute("points",routePoints(g,shade.path));
  document.getElementById("shortDist").textContent=Math.round(sm.distance)+" m";
  document.getElementById("shortSun").textContent=`햇빛 노출 ${Math.round(sm.sun)} m`;
  document.getElementById("shadeDist").textContent=Math.round(hm.distance)+" m";
  document.getElementById("shadeSun").textContent=`햇빛 노출 ${Math.round(hm.sun)} m`;
  document.getElementById("extraDist").textContent=Math.round(hm.distance-sm.distance)+" m";
  const red=sm.sun?Math.max(0,(1-hm.sun/sm.sun)*100):0;
  document.getElementById("sunReduction").textContent=Math.round(red)+"%";
  document.getElementById("algoStatus").textContent=`동적 노드 생성 완료 · 그래프 ${Object.keys(g.nodes).length}개 노드 / ${g.edges.length}개 간선`;
  updateRoutes();renderRouteWeights();
}
function clearResults(){
  finalResult=null;
  document.getElementById("shortRoute").setAttribute("points","");
  document.getElementById("shadeRoute").setAttribute("points","");
  ["shortDist","shadeDist","extraDist","sunReduction"].forEach(id=>document.getElementById(id).textContent="—");
  document.getElementById("shortSun").textContent="햇빛 노출 —";document.getElementById("shadeSun").textContent="햇빛 노출 —";
  weightLayer.innerHTML="";resetAlgorithmLayer();
}
function updateRoutes(){
  document.getElementById("shortRoute").style.opacity=(routeView==="both"||routeView==="short")?1:0;
  document.getElementById("shadeRoute").style.opacity=(routeView==="both"||routeView==="shade")?1:0;
}
function renderRouteWeights(){
  weightLayer.innerHTML="";
  if(!finalResult||!document.getElementById("showRouteWeights").checked)return;
  const sets=[];
  if(routeView==="both"||routeView==="short")sets.push(["short",finalResult.shortEdges]);
  if(routeView==="both"||routeView==="shade")sets.push(["shade",finalResult.shadeEdges]);
  const seen=new Set();
  for(const [kind,arr] of sets){
    arr.forEach((e,i)=>{
      if(i%2===1)return;
      const key=kind+e.id;if(seen.has(key))return;seen.add(key);
      const A=finalResult.g.nodes[e.a],B=finalResult.g.nodes[e.b],mid={x:(A.x+B.x)/2,y:(A.y+B.y)/2};
      const p=screenFromSvg(mid.x,mid.y),el=document.createElement("div");el.className="weight-label";el.style.left=p.left+"px";el.style.top=p.top+"px";
      const cost=kind==="short"?e.length:e.length*e.shadeParts.building + e.length*e.shadeParts.tree*1.3 + e.length*e.shadeParts.sun*3;
      el.innerHTML=`<b>${Math.round(cost)}</b><span>${Math.round(e.shade*100)}% 그늘</span>`;
      weightLayer.appendChild(el);
    });
  }
}
function resetAlgorithmLayer(){
  if(animationTimer){clearTimeout(animationTimer);animationTimer=null}
  algorithmLayer.innerHTML="";costBadge.classList.add("hidden");
}
function animate(kind){
  if(!startPoint||!endPoint)return;
  resetAlgorithmLayer();
  const g=buildDynamicGraph(),res=dijkstra(g,kind,true);
  let i=0;
  const speed=Math.max(15,Math.min(45,2600/Math.max(1,res.steps.length)));
  document.getElementById("algoStatus").textContent=`${kind==="short"?"최단거리":"그늘우선"} 다익스트라 탐색 시작`;
  function step(){
    if(i>=res.steps.length){
      document.getElementById("algoStatus").textContent=`탐색 완료 · ${res.path.length}개 노드 경유 · 누적 비용 ${Math.round(res.cost)}`;
      costBadge.classList.add("hidden");return;
    }
    const s=res.steps[i++];
    algorithmLayer.innerHTML="";
    if(s.type==="select"){
      const n=g.nodes[s.node];
      algorithmLayer.innerHTML=`<circle class="algo-node algo-current" cx="${n.x}" cy="${n.y}" r="8"/>`;
      placeCostBadge(n,`${s.node} · ${Math.round(s.cost)}`);
      document.getElementById("algoStatus").textContent=`누적 비용이 가장 작은 노드 ${s.node} 확정 → ${Math.round(s.cost)}`;
    }else if(s.type==="inspect"){
      const A=g.nodes[s.from],B=g.nodes[s.to];
      algorithmLayer.innerHTML=`<line class="algo-edge" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>`;
      document.getElementById("algoStatus").textContent=`${s.from} → ${s.to} 간선 검사`;
    }else{
      const n=g.nodes[s.node],A=g.nodes[s.from];
      algorithmLayer.innerHTML=`<line class="algo-edge" x1="${A.x}" y1="${A.y}" x2="${n.x}" y2="${n.y}"/><circle class="algo-node algo-update" cx="${n.x}" cy="${n.y}" r="8"/>`;
      placeCostBadge(n,`${s.node} ← ${Math.round(s.cost)}`);
      document.getElementById("algoStatus").textContent=`${s.node}의 최소 누적 비용 갱신 → ${Math.round(s.cost)}`;
    }
    animationTimer=setTimeout(step,speed);
  }
  step();
}
function placeCostBadge(n,text){
  const p=screenFromSvg(n.x,n.y);costBadge.classList.remove("hidden");costBadge.style.left=p.left+"px";costBadge.style.top=p.top+"px";costBadge.textContent=text;
}

function syncUI(){
  document.getElementById("startBtn").classList.toggle("active",mode==="start");
  document.getElementById("endBtn").classList.toggle("active",mode==="end");
  document.getElementById("startInfo").textContent=startPoint?`도로 ${startPoint.edgeId} · 임시 노드 S`:"도로 위 아무 곳 클릭";
  document.getElementById("endInfo").textContent=endPoint?`도로 ${endPoint.edgeId} · 임시 노드 G`:"도로 위 아무 곳 클릭";
  const ready=!!(startPoint&&endPoint&&dist(startPoint,endPoint)>1);
  ["runBtn","animateShort","animateShade"].forEach(id=>document.getElementById(id).disabled=!ready);
}
function updateTime(){
  timeHour=Number(document.getElementById("timeRange").value);
  document.getElementById("timeLabel").textContent=String(timeHour).padStart(2,"0")+":00";
  let s=timeHour<=12?"남동쪽 · 태양 고도 상승":timeHour<=14?"남쪽 · 태양 고도 매우 높음":timeHour<=16?"남서쪽 · 태양 고도 높음":"서쪽 · 태양 고도 낮아짐";
  document.getElementById("sunState").textContent=s;
  drawCity();
  if(finalResult)calculate();
}
document.getElementById("startBtn").addEventListener("click",()=>{mode="start";syncUI()});
document.getElementById("endBtn").addEventListener("click",()=>{mode="end";syncUI()});
document.getElementById("runBtn").addEventListener("click",calculate);
document.getElementById("animateShort").addEventListener("click",()=>animate("short"));
document.getElementById("animateShade").addEventListener("click",()=>animate("shade"));
document.getElementById("resetBtn").addEventListener("click",()=>{startPoint=endPoint=null;mode="start";clearResults();drawMarkers();syncUI();document.getElementById("algoStatus").textContent="도로 위 아무 위치나 출발점과 도착점으로 선택하세요."});
document.getElementById("timeRange").addEventListener("input",updateTime);
document.getElementById("showGraph").addEventListener("change",drawGraphNodes);
document.getElementById("showRouteWeights").addEventListener("change",renderRouteWeights);
document.getElementById("toggleBuildings").addEventListener("click",e=>{buildingsVisible=!buildingsVisible;buildingLayer.style.display=buildingsVisible?"":"none";e.target.textContent=buildingsVisible?"건물 숨기기":"건물 보이기"});
document.getElementById("toggleTrees").addEventListener("click",e=>{
  treesVisible=!treesVisible;
  treeLayer.style.display=treesVisible?"":"none";
  e.target.textContent=treesVisible?"가로수 숨기기":"가로수 보이기";
});
document.getElementById("toggleShadows").addEventListener("click",e=>{shadowsVisible=!shadowsVisible;shadowLayer.style.display=shadowsVisible?"":"none";treeShadowLayer.style.display=shadowsVisible?"":"none";e.target.textContent=shadowsVisible?"그림자 숨기기":"그림자 보이기"});
document.querySelectorAll(".route-tab").forEach(btn=>btn.addEventListener("click",()=>{document.querySelectorAll(".route-tab").forEach(b=>b.classList.remove("active"));btn.classList.add("active");routeView=btn.dataset.view;updateRoutes();renderRouteWeights()}));
window.addEventListener("resize",renderRouteWeights);

buildCityGraph();generateBuildings();generateTrees();drawCity();syncUI();updateTime();
