/* BOXROOMS — survival coop three.js, téléphone en manette (WebRTC via PeerJS) */
(function(){
'use strict';
const PEER_PREFIX = 'boxrooms-v1-';
const JOIN_PARAM = (()=>{ try{ return (new URLSearchParams(location.search).get('join')||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4); }catch(e){ return ''; } })();
const $ = s => document.querySelector(s);
const clamp = (v,a,b) => v<a?a:v>b?b:v;
const lerp = (a,b,t) => a+(b-a)*t;
const rand = (a,b) => a+Math.random()*(b-a);
const TAU = Math.PI*2;
const SLOT_COLORS = ['#4D8BFF','#FF8C42','#C77DFF','#3DDC97'];
const WEAPONS = [
  {id:'pistol',  name:'Pistolet',      rate:4.2, dmg:24,  spread:0.03, pellets:1, kb:3.2, start:Infinity, max:Infinity, unlock:1, sfx:'pistol',  tracer:0, shake:0.10, recoil:0.6},
  {id:'uzi',     name:'Uzi',           rate:13,  dmg:12,  spread:0.10, pellets:1, kb:1.6, start:220, max:400, unlock:2, sfx:'uzi',     tracer:0, shake:0.06, recoil:0.4},
  {id:'shotgun', name:'Fusil à pompe', rate:1.5, dmg:16,  spread:0.34, pellets:8, kb:8,   start:30,  max:60,  unlock:3, sfx:'shotgun', tracer:0, shake:0.32, recoil:3.2},
  {id:'barrel',  name:'Barils',        rate:1.4, kind:'barrel',  start:5, max:10, unlock:3},
  {id:'grenade', name:'Grenades',      rate:1.3, kind:'grenade', start:8, max:16, unlock:4},
  {id:'rail',    name:'Railgun',       rate:0.9, dmg:150, spread:0,    pellets:1, kb:10,  pierce:true, start:10, max:20, unlock:6, sfx:'rail', tracer:1, shake:0.4, recoil:4.5},
];
function safeName(s){ return String(s||'').replace(/[^\p{L}\p{N} _\-'.!]/gu,'').trim().slice(0,12); }
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }

const hashMode = (location.hash||'').replace('#','');
const coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
/* =====================================================================
   HOST
   ===================================================================== */
const Host = (typeof THREE==='undefined') ? {start(){ const b=$('#bootErr'); b.textContent='Le moteur 3D n\'a pas pu se charger. Vérifiez la connexion puis rechargez la page.'; b.classList.remove('hidden'); }, stop(){}} : (function(){
  let started=false, running=false;
  let renderer, scene, camera, composer, finalPass, bloomPass;
  let peer=null; const pads=new Map(); let netTries=0;
  const makeCode = ()=>{ const A='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<4;i++) s+=A[Math.floor(Math.random()*A.length)]; return s; };
  let CODE = makeCode();

  // ---------------- map ----------------
  const MW=30, MH=20;
  const grid = new Uint8Array(MW*MH);
  const DOORS = [[14,0],[15,0],[14,MH-1],[15,MH-1],[0,9],[0,10],[MW-1,9],[MW-1,10]];
  (function buildMap(){
    for(let x=0;x<MW;x++){ grid[x]=1; grid[(MH-1)*MW+x]=1; }
    for(let y=0;y<MH;y++){ grid[y*MW]=1; grid[y*MW+MW-1]=1; }
    for(const [x,y] of DOORS) grid[y*MW+x]=0;
    const rects=[[4,3,3,1],[4,4,1,2],[23,3,3,1],[25,4,1,2],[4,16,3,1],[4,14,1,2],[23,16,3,1],[25,14,1,2],
      [12,6,2,1],[16,6,2,1],[12,13,2,1],[16,13,2,1],[9,9,1,2],[20,9,1,2]];
    for(const [rx,ry,rw,rh] of rects) for(let y=ry;y<ry+rh;y++) for(let x=rx;x<rx+rw;x++) grid[y*MW+x]=1;
  })();
  const tileX = x => x - MW/2 + 0.5, tileZ = y => y - MH/2 + 0.5;
  const toTx = x => Math.floor(x + MW/2), toTy = z => Math.floor(z + MH/2);
  function solid(tx,ty){ if(tx<0||ty<0||tx>=MW||ty>=MH) return true; return grid[ty*MW+tx]===1; }
  function collideWalls(e, r){
    const x0=toTx(e.x-r), x1=toTx(e.x+r), y0=toTy(e.z-r), y1=toTy(e.z+r);
    let hit=false;
    for(let ty=y0;ty<=y1;ty++) for(let tx=x0;tx<=x1;tx++){
      if(!solid(tx,ty)) continue;
      const minX=tx-MW/2, minZ=ty-MH/2;
      const cx=clamp(e.x,minX,minX+1), cz=clamp(e.z,minZ,minZ+1);
      let dx=e.x-cx, dz=e.z-cz; const d2=dx*dx+dz*dz;
      if(d2<r*r){
        hit=true;
        if(d2>1e-8){ const d=Math.sqrt(d2), p=r-d; e.x+=dx/d*p; e.z+=dz/d*p; }
        else { // center inside tile: push to nearest edge
          const l=e.x-minX, rr=minX+1-e.x, t=e.z-minZ, b=minZ+1-e.z, m=Math.min(l,rr,t,b);
          if(m===l) e.x=minX-r; else if(m===rr) e.x=minX+1+r; else if(m===t) e.z=minZ-r; else e.z=minZ+1+r;
        }
      }
    }
    return hit;
  }
  function rayWall(ox,oz,dx,dz,maxD){
    let tx=toTx(ox), ty=toTy(oz);
    const stepX = dx>0?1:-1, stepZ = dz>0?1:-1;
    const gx = ox+MW/2, gz = oz+MH/2;
    let tMaxX = dx!==0 ? ((dx>0? (tx+1-gx) : (gx-tx))/Math.abs(dx)) : Infinity;
    let tMaxZ = dz!==0 ? ((dz>0? (ty+1-gz) : (gz-ty))/Math.abs(dz)) : Infinity;
    const tDX = dx!==0? 1/Math.abs(dx) : Infinity, tDZ = dz!==0? 1/Math.abs(dz) : Infinity;
    let t=0;
    for(let i=0;i<80;i++){
      if(tMaxX<tMaxZ){ t=tMaxX; tMaxX+=tDX; tx+=stepX; } else { t=tMaxZ; tMaxZ+=tDZ; ty+=stepZ; }
      if(t>maxD) return maxD;
      if(solid(tx,ty)) return t;
    }
    return maxD;
  }

  // flow field
  const dist = new Int16Array(MW*MH);
  const queue = new Int16Array(MW*MH);
  function computeFlow(){
    dist.fill(-1); let qh=0, qt=0;
    for(const p of players){ if(p.downed) continue; const tx=clamp(toTx(p.x),0,MW-1), ty=clamp(toTy(p.z),0,MH-1); const i=ty*MW+tx; if(dist[i]===-1){ dist[i]=0; queue[qt++]=i; } }
    while(qh<qt){
      const i=queue[qh++], x=i%MW, y=(i/MW)|0, d=dist[i]+1;
      if(x>0 && grid[i-1]===0 && dist[i-1]===-1){ dist[i-1]=d; queue[qt++]=i-1; }
      if(x<MW-1 && grid[i+1]===0 && dist[i+1]===-1){ dist[i+1]=d; queue[qt++]=i+1; }
      if(y>0 && grid[i-MW]===0 && dist[i-MW]===-1){ dist[i-MW]=d; queue[qt++]=i-MW; }
      if(y<MH-1 && grid[i+MW]===0 && dist[i+MW]===-1){ dist[i+MW]=d; queue[qt++]=i+MW; }
    }
  }
  const N8=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  function flowDir(x,z,out){
    const tx=toTx(x), ty=toTy(z); if(solid(tx,ty)) { out.x=0; out.z=0; return false; }
    const here=dist[ty*MW+tx]; if(here<0){ out.x=0; out.z=0; return false; }
    let best=here, bx=0, bz=0;
    for(const [ox,oz] of N8){
      const nx=tx+ox, ny=ty+oz; if(solid(nx,ny)) continue;
      if(ox&&oz && (solid(tx+ox,ty)||solid(tx,ty+oz))) continue;
      const d=dist[ny*MW+nx]; if(d<0) continue;
      const score = d + (ox&&oz?0.4:0);
      if(score<best){ best=score; bx=ox; bz=oz; }
    }
    if(bx===0&&bz===0){ out.x=0; out.z=0; return false; }
    const txw=tileX(tx+bx), tzw=tileZ(ty+bz); let dx=txw-x, dz=tzw-z; const l=Math.hypot(dx,dz)||1; out.x=dx/l; out.z=dz/l; return true;
  }

  // ---------------- state ----------------
  const players=[]; const enemies=[]; const barrels=[]; const projectiles=[]; const pickups=[];
  let phase='lobby'; // lobby | play | over
  let wave=0, waveState='break', waveT=0, toSpawn=0, spawnT=0, unlockWave=99;
  let combo=0, comboT=0, bestCombo=0, teamScore=0, totalKills=0;
  let shake=0, freeze=0, timeScale=1, slowT=0, flashAmt=0, damageAmt=0, aberr=0;
  let flowT=0, pickupT=8, groanT=3, lobbySpawnT=0, broadcastT=0, lobbyBroadcastT=0;
  let lastTime=0, simTime=0;
  let kbPlayer=null; const gpPlayers={};

  // ---------------- three setup ----------------
  const mats={}; const G={};
  let gibMesh, partMesh, smokeMesh, decalMesh;
  const tmpM=new THREE.Matrix4(), tmpQ=new THREE.Quaternion(), tmpE=new THREE.Euler(), tmpV=new THREE.Vector3(), tmpS=new THREE.Vector3(), tmpC=new THREE.Color();
  const muzzleLights=[], boomLights=[];
  const tracers=[], rings=[];
  let camTarget=new THREE.Vector3(0,0,0), camDist=30, camYaw=0;
  const raycaster=new THREE.Raycaster(), aimPlane=new THREE.Plane(new THREE.Vector3(0,1,0), -0.6);

  function canvasTex(w,h,draw,repeat){
    const c=document.createElement('canvas'); c.width=w; c.height=h; const x=c.getContext('2d'); draw(x,w,h);
    const t=new THREE.CanvasTexture(c); t.encoding=THREE.sRGBEncoding; t.anisotropy=8;
    if(repeat){ t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(repeat[0],repeat[1]); }
    return t;
  }
  function lin(hex){ return new THREE.Color(hex); }

  function initThree(){
    THREE.ColorManagement.legacyMode=false;
    const canvas=$('#gl');
    renderer=new THREE.WebGLRenderer({canvas, antialias:true, powerPreference:'high-performance'});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 1.75));
    renderer.setSize(innerWidth, innerHeight, false);
    renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    renderer.toneMapping=THREE.NoToneMapping;
    scene=new THREE.Scene();
    scene.background=new THREE.Color('#1B1410');
    scene.fog=new THREE.Fog('#1B1410', 45, 95);
    camera=new THREE.PerspectiveCamera(32, innerWidth/innerHeight, 1, 200);

    // lights
    const hemi=new THREE.HemisphereLight('#BFD8FF', '#4A3426', 0.5); scene.add(hemi);
    const sun=new THREE.DirectionalLight('#FFE0B5', 1.55);
    sun.position.set(-10,22,12); sun.castShadow=true;
    sun.shadow.mapSize.set(2048,2048);
    const sc=sun.shadow.camera; sc.left=-21; sc.right=21; sc.top=16; sc.bottom=-16; sc.near=1; sc.far=60;
    sun.shadow.bias=-0.0006; sun.shadow.normalBias=0.03; sun.shadow.radius=3;
    scene.add(sun);
    const rim=new THREE.DirectionalLight('#7FB4FF', 0.5); rim.position.set(12,8,-14); scene.add(rim);
    for(let i=0;i<4;i++){ const l=new THREE.PointLight('#FFC56B',0,7,2); scene.add(l); muzzleLights.push(l); }
    for(let i=0;i<3;i++){ const l=new THREE.PointLight('#FF8A3D',0,12,2); scene.add(l); boomLights.push({l,t:0}); }

    G.box=new THREE.BoxGeometry(1,1,1);
    G.ring=new THREE.RingGeometry(0.42,0.56,40); G.ring.rotateX(-Math.PI/2);
    G.disc=new THREE.CircleGeometry(0.5,32); G.disc.rotateX(-Math.PI/2);
    G.shock=new THREE.RingGeometry(0.85,1,64); G.shock.rotateX(-Math.PI/2);
    G.cyl=new THREE.CylinderGeometry(0.3,0.3,0.78,18);
    G.sphere=new THREE.SphereGeometry(0.18,14,10);
    G.plane=new THREE.PlaneGeometry(1,1); G.plane.rotateX(-Math.PI/2);

    // textures
    const floorTex=canvasTex(512,512,(x,w,h)=>{
      x.fillStyle='#2F4A50'; x.fillRect(0,0,w,h);
      const T=w/4;
      for(let j=0;j<4;j++) for(let i=0;i<4;i++){
        const v=rand(-8,8); x.fillStyle=`rgb(${47+v},${74+v},${80+v})`; x.fillRect(i*T+3,j*T+3,T-6,T-6);
        for(let k=0;k<60;k++){ x.fillStyle=`rgba(${Math.random()<.5?255:0},${Math.random()<.5?255:0},${Math.random()<.5?255:0},0.025)`; x.fillRect(i*T+rand(4,T-8),j*T+rand(4,T-8),rand(2,10),rand(2,10)); }
      }
      x.strokeStyle='rgba(10,20,22,.55)'; x.lineWidth=5; for(let i=0;i<=4;i++){ x.beginPath(); x.moveTo(i*T,0); x.lineTo(i*T,h); x.stroke(); x.beginPath(); x.moveTo(0,i*T); x.lineTo(w,i*T); x.stroke(); }
    },[MW/4,MH/4]);
    const crateTex=canvasTex(128,128,(x,w,h)=>{
      x.fillStyle='#C9985E'; x.fillRect(0,0,w,h);
      for(let i=0;i<300;i++){ x.fillStyle=`rgba(90,55,25,${rand(.02,.07)})`; x.fillRect(rand(0,w),rand(0,h),rand(1,3),rand(6,18)); }
      const g=x.createLinearGradient(0,0,w,0); g.addColorStop(0,'rgba(60,35,15,.45)'); g.addColorStop(.08,'rgba(60,35,15,0)'); g.addColorStop(.92,'rgba(60,35,15,0)'); g.addColorStop(1,'rgba(60,35,15,.45)');
      x.fillStyle=g; x.fillRect(0,0,w,h);
      const g2=x.createLinearGradient(0,0,0,h); g2.addColorStop(0,'rgba(60,35,15,.4)'); g2.addColorStop(.08,'rgba(60,35,15,0)'); g2.addColorStop(.92,'rgba(60,35,15,0)'); g2.addColorStop(1,'rgba(60,35,15,.4)');
      x.fillStyle=g2; x.fillRect(0,0,w,h);
      x.fillStyle='rgba(236,220,180,.85)'; x.fillRect(w*0.42,0,w*0.16,h);
      x.fillStyle='rgba(120,80,40,.18)'; x.fillRect(w*0.42,0,2,h); x.fillRect(w*0.58-2,0,2,h);
    });
    const splatTex=(()=>{ const t=canvasTex(128,128,(x,w,h)=>{
      x.clearRect(0,0,w,h); x.fillStyle='#fff';
      for(let i=0;i<14;i++){ const r=rand(6,26), a=rand(0,TAU), d=rand(0,i<4?6:34); x.beginPath(); x.arc(w/2+Math.cos(a)*d, h/2+Math.sin(a)*d, i<4?r+12:r*0.6, 0, TAU); x.fill(); }
      for(let i=0;i<10;i++){ const a=rand(0,TAU), d=rand(40,58); x.beginPath(); x.arc(w/2+Math.cos(a)*d, h/2+Math.sin(a)*d, rand(2,5), 0, TAU); x.fill(); }
    }); t.encoding=THREE.LinearEncoding; return t; })();
    const tableTex=canvasTex(256,256,(x,w,h)=>{
      x.fillStyle='#2A1D15'; x.fillRect(0,0,w,h);
      for(let i=0;i<w;i+=2){ x.fillStyle=`rgba(${Math.random()<.5?0:80},${Math.random()<.5?0:50},20,${rand(.02,.09)})`; x.fillRect(i,0,2,h); }
      x.fillStyle='rgba(0,0,0,.35)'; for(let i=0;i<4;i++) x.fillRect(i*64,0,2,h);
    },[14,14]);

    // materials
    mats.floor=new THREE.MeshStandardMaterial({map:floorTex, roughness:0.92, metalness:0});
    mats.crate=new THREE.MeshStandardMaterial({map:crateTex, roughness:0.85});
    mats.slab=new THREE.MeshStandardMaterial({color:'#3B2A20', roughness:0.8});
    mats.table=new THREE.MeshStandardMaterial({map:tableTex, roughness:0.75});
    mats.flash=new THREE.MeshBasicMaterial({color:new THREE.Color(3,3,3)});
    mats.skin=new THREE.MeshStandardMaterial({color:'#F2D1A8', roughness:0.7});
    mats.dark=new THREE.MeshStandardMaterial({color:'#23262B', roughness:0.6, metalness:0.2});
    mats.pants=new THREE.MeshStandardMaterial({color:'#2E3440', roughness:0.8});
    mats.eye=new THREE.MeshBasicMaterial({color:'#15171A'});
    mats.zSkin=new THREE.MeshStandardMaterial({color:'#8DB572', roughness:0.8});
    mats.zShirt=new THREE.MeshStandardMaterial({color:'#5A4878', roughness:0.9});
    mats.zPants=new THREE.MeshStandardMaterial({color:'#3B3550', roughness:0.9});
    mats.zEye=new THREE.MeshBasicMaterial({color:new THREE.Color(2.2,0.35,0.25)});
    mats.dSkin=new THREE.MeshStandardMaterial({color:'#D6304A', roughness:0.6});
    mats.dBody=new THREE.MeshStandardMaterial({color:'#8E1B30', roughness:0.6});
    mats.dHorn=new THREE.MeshStandardMaterial({color:'#2B1B1B', roughness:0.4});
    mats.dEye=new THREE.MeshBasicMaterial({color:new THREE.Color(5,3.2,0.6)});
    mats.bSkin=new THREE.MeshStandardMaterial({color:'#6F8F55', roughness:0.85});
    mats.bShirt=new THREE.MeshStandardMaterial({color:'#4E3B2A', roughness:0.9});
    mats.barrel=new THREE.MeshStandardMaterial({color:'#C8283A', roughness:0.45, metalness:0.3});
    mats.barrelBand=new THREE.MeshStandardMaterial({color:'#FFC845', roughness:0.5, emissive:'#FF9A1F', emissiveIntensity:0.25});
    mats.fireball=new THREE.MeshBasicMaterial({color:new THREE.Color(6,2.2,0.5)});
    mats.grenade=new THREE.MeshStandardMaterial({color:'#4F6B3A', roughness:0.5});
    mats.tracer=new THREE.MeshBasicMaterial({color:new THREE.Color(6,4.2,1.6), transparent:true, blending:THREE.AdditiveBlending, depthWrite:false});
    mats.rail=new THREE.MeshBasicMaterial({color:new THREE.Color(2.2,4.5,9), transparent:true, blending:THREE.AdditiveBlending, depthWrite:false});
    mats.portal=new THREE.MeshBasicMaterial({color:new THREE.Color(1.6,0.25,0.18), transparent:true, opacity:0.9, blending:THREE.AdditiveBlending, depthWrite:false});
    mats.pickAmmo=new THREE.MeshStandardMaterial({color:'#FFB547', roughness:0.4, emissive:'#FF8A1F', emissiveIntensity:0.35});
    mats.pickHp=new THREE.MeshStandardMaterial({color:'#F4EBDD', roughness:0.4});
    mats.pickHpCross=new THREE.MeshBasicMaterial({color:new THREE.Color(0.4,3,1.4)});
    mats.pickAmmoMark=new THREE.MeshBasicMaterial({color:new THREE.Color(0.25,0.12,0.05)});
    mats.slot=SLOT_COLORS.map(c=>new THREE.MeshStandardMaterial({color:c, roughness:0.55}));
    mats.slotRing=SLOT_COLORS.map(c=>{ const col=new THREE.Color(c).multiplyScalar(1.1); return new THREE.MeshBasicMaterial({color:col, transparent:true, opacity:0.95, blending:THREE.AdditiveBlending, depthWrite:false, depthTest:false}); });
    mats.downRing=new THREE.MeshBasicMaterial({color:new THREE.Color(3,0.4,0.5), transparent:true, blending:THREE.AdditiveBlending, depthWrite:false});

    // world
    const table=new THREE.Mesh(new THREE.PlaneGeometry(220,220), mats.table); table.rotation.x=-Math.PI/2; table.position.y=-0.62; table.receiveShadow=true; scene.add(table);
    const slab=new THREE.Mesh(G.box, mats.slab); slab.scale.set(MW+1.4,0.62,MH+1.4); slab.position.y=-0.33; slab.receiveShadow=true; slab.castShadow=true; scene.add(slab);
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(MW,MH), mats.floor); floor.rotation.x=-Math.PI/2; floor.position.y=0; floor.receiveShadow=true; scene.add(floor);
    // walls (instanced crates)
    let wc=0; for(let i=0;i<grid.length;i++) if(grid[i]) wc++;
    const walls=new THREE.InstancedMesh(G.box, mats.crate, wc); walls.castShadow=true; walls.receiveShadow=true;
    let wi=0;
    for(let y=0;y<MH;y++) for(let x=0;x<MW;x++){
      if(!grid[y*MW+x]) continue;
      const h=rand(0.95,1.35);
      tmpE.set(0,rand(-0.05,0.05),0); tmpQ.setFromEuler(tmpE);
      tmpM.compose(tmpV.set(tileX(x)+rand(-0.02,0.02),h/2,tileZ(y)+rand(-0.02,0.02)), tmpQ, tmpS.set(0.97,h,0.97));
      walls.setMatrixAt(wi,tmpM);
      const v=rand(0.82,1.08); walls.setColorAt(wi, tmpC.setRGB(v, v*rand(0.95,1.0), v*rand(0.9,1.0)));
      wi++;
    }
    scene.add(walls);
    // portals at doors
    for(const [x,y] of DOORS){
      const p=new THREE.Mesh(G.plane, mats.portal); p.scale.set(0.95,1,0.95); p.position.set(tileX(x),0.012,tileZ(y)); scene.add(p);
    }

    // instanced effects
    const gibMat=new THREE.MeshStandardMaterial({roughness:0.7});
    gibMesh=new THREE.InstancedMesh(G.box, gibMat, GIB_N); gibMesh.castShadow=true; gibMesh.frustumCulled=false;
    initInstanced(gibMesh, GIB_N); scene.add(gibMesh);
    const partMat=new THREE.MeshBasicMaterial({transparent:true, blending:THREE.AdditiveBlending, depthWrite:false});
    partMesh=new THREE.InstancedMesh(G.box, partMat, PART_N); partMesh.frustumCulled=false; initInstanced(partMesh, PART_N); scene.add(partMesh);
    const smokeMat=new THREE.MeshStandardMaterial({roughness:1, transparent:true, opacity:0.85, depthWrite:false});
    smokeMesh=new THREE.InstancedMesh(G.box, smokeMat, SMOKE_N); smokeMesh.frustumCulled=false; initInstanced(smokeMesh, SMOKE_N); scene.add(smokeMesh);
    const decalMat=new THREE.MeshBasicMaterial({alphaMap:splatTex, transparent:true, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2});
    decalMesh=new THREE.InstancedMesh(G.plane, decalMat, DECAL_N); decalMesh.frustumCulled=false; decalMesh.renderOrder=1; initInstanced(decalMesh, DECAL_N); scene.add(decalMesh);

    for(let i=0;i<48;i++){ const m=new THREE.Mesh(G.box, mats.tracer); m.visible=false; scene.add(m); tracers.push({m,t:0,life:0,w:0}); }
    for(let i=0;i<8;i++){ const mat=new THREE.MeshBasicMaterial({color:new THREE.Color(4,2.4,1), transparent:true, blending:THREE.AdditiveBlending, depthWrite:false}); const m=new THREE.Mesh(G.shock, mat); m.visible=false; m.position.y=0.05; scene.add(m); rings.push({m,t:0,life:0,r:1}); }

    // post
    const rt=new THREE.WebGLRenderTarget(innerWidth*renderer.getPixelRatio(), innerHeight*renderer.getPixelRatio(), {type:THREE.HalfFloatType});
    composer=new THREE.EffectComposer(renderer, rt); composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(innerWidth, innerHeight);
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloomPass=new THREE.UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.75, 0.55, 0.92);
    composer.addPass(bloomPass);
    finalPass=new THREE.ShaderPass({
      uniforms:{ tDiffuse:{value:null}, uRes:{value:new THREE.Vector2(innerWidth*renderer.getPixelRatio(), innerHeight*renderer.getPixelRatio())}, uTime:{value:0}, uAberr:{value:0}, uFlash:{value:0}, uDamage:{value:0}, uExposure:{value:0.92}, uTilt:{value:1.0} },
      vertexShader:'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader:`
        uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uTime, uAberr, uFlash, uDamage, uExposure, uTilt; varying vec2 vUv;
        vec3 aces(vec3 x){ const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14; return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0); }
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
        void main(){
          vec2 uv=vUv;
          float d=abs(uv.y-0.5);
          float blur=smoothstep(0.2,0.52,d)*uTilt*(uRes.y/900.0)*4.0;
          vec3 col=vec3(0.0);
          for(int i=0;i<12;i++){ float fi=float(i); float a=fi*2.39996; float r=sqrt(fi+0.5)/3.4641; col+=texture2D(tDiffuse, uv+vec2(cos(a),sin(a))*r*blur/uRes).rgb; }
          col/=12.0;
          if(uAberr>0.001){ vec2 dir=(uv-0.5)*uAberr*0.012; col.r=mix(col.r, texture2D(tDiffuse, uv+dir).r, 0.85); col.b=mix(col.b, texture2D(tDiffuse, uv-dir).b, 0.85); }
          col*=uExposure;
          col+=uFlash*vec3(1.0,0.82,0.6);
          col=aces(col);
          float l=dot(col, vec3(0.299,0.587,0.114));
          col=mix(col, col*vec3(0.9,1.02,1.1), (1.0-l)*0.35);
          col=mix(col, col*vec3(1.07,1.0,0.9), l*0.35);
          vec2 vv=(uv-0.5)*vec2(uRes.x/uRes.y,1.0); float v=length(vv);
          col*=1.0-smoothstep(0.45,1.15,v)*0.6;
          col=mix(col, vec3(0.55,0.02,0.06), smoothstep(0.35,1.0,v)*uDamage);
          col+=(hash(uv*uRes+fract(uTime)*91.0)-0.5)*0.03;
          col=pow(max(col,0.0), vec3(1.0/2.2));
          gl_FragColor=vec4(col,1.0);
        }`
    });
    composer.addPass(finalPass);
    addEventListener('resize', onResize);
  }
  function onResize(){
    if(!renderer) return;
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix();
    composer.setSize(innerWidth, innerHeight);
    const pr=renderer.getPixelRatio(); finalPass.uniforms.uRes.value.set(innerWidth*pr, innerHeight*pr);
  }
  function initInstanced(mesh,n){ tmpM.makeScale(0,0,0); for(let i=0;i<n;i++){ mesh.setMatrixAt(i,tmpM); mesh.setColorAt(i,tmpC.setRGB(1,1,1)); } mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.instanceMatrix.needsUpdate=true; mesh.instanceColor.needsUpdate=true; }

  // ---------------- pools: gibs / particles / smoke / decals ----------------
  const GIB_N=700, PART_N=1600, SMOKE_N=260, DECAL_N=420;
  const gibs=[]; let gibI=0;
  for(let i=0;i<GIB_N;i++) gibs.push({a:false,x:0,y:0,z:0,vx:0,vy:0,vz:0,rx:0,ry:0,rz:0,wx:0,wy:0,wz:0,s:0.1,life:0,max:1,dirty:false});
  function spawnGib(x,y,z,vx,vy,vz,s,color,life){
    const g=gibs[gibI]; const idx=gibI; gibI=(gibI+1)%GIB_N;
    g.a=true; g.x=x; g.y=y; g.z=z; g.vx=vx; g.vy=vy; g.vz=vz; g.rx=rand(0,TAU); g.ry=rand(0,TAU); g.rz=rand(0,TAU);
    g.wx=rand(-14,14); g.wy=rand(-14,14); g.wz=rand(-14,14); g.s=s; g.life=life||rand(6,9); g.max=g.life;
    gibMesh.setColorAt(idx, tmpC.set(color)); gibMesh.instanceColor.needsUpdate=true;
  }
  function updateGibs(dt){
    for(let i=0;i<GIB_N;i++){
      const g=gibs[i]; if(!g.a) continue;
      g.life-=dt;
      if(g.life<=0){ g.a=false; tmpM.makeScale(0,0,0); gibMesh.setMatrixAt(i,tmpM); continue; }
      g.vy-=22*dt;
      const nx=g.x+g.vx*dt, nz=g.z+g.vz*dt;
      if(g.y<1.4 && solid(toTx(nx),toTy(g.z))) g.vx*=-0.4; else g.x=nx;
      if(g.y<1.4 && solid(toTx(g.x),toTy(nz))) g.vz*=-0.4; else g.z=nz;
      g.y+=g.vy*dt;
      const half=g.s*0.5;
      if(g.y<half){ g.y=half; if(g.vy<-1.5){ g.vy*=-0.38; g.vx*=0.62; g.vz*=0.62; g.wx*=0.5; g.wy*=0.5; g.wz*=0.5; } else { g.vy=0; g.vx*=Math.max(0,1-8*dt); g.vz*=Math.max(0,1-8*dt); g.wx*=0.85; g.wy*=0.85; g.wz*=0.85; if(Math.abs(g.wx)<0.3){ g.rx=Math.round(g.rx/(Math.PI/2))*(Math.PI/2); g.rz=Math.round(g.rz/(Math.PI/2))*(Math.PI/2); g.wx=g.wz=0; } } }
      g.rx+=g.wx*dt; g.ry+=g.wy*dt; g.rz+=g.wz*dt;
      const sc=g.s*Math.min(1, g.life/0.8);
      tmpE.set(g.rx,g.ry,g.rz); tmpQ.setFromEuler(tmpE);
      tmpM.compose(tmpV.set(g.x,g.y,g.z), tmpQ, tmpS.set(sc,sc,sc)); gibMesh.setMatrixAt(i,tmpM);
    }
    gibMesh.instanceMatrix.needsUpdate=true;
  }
  const parts=[]; let partI=0;
  for(let i=0;i<PART_N;i++) parts.push({a:false,x:0,y:0,z:0,vx:0,vy:0,vz:0,s:0.1,life:0,max:1,g:0,drag:0,stretch:0});
  function spawnPart(x,y,z,vx,vy,vz,s,r,gg,b,life,grav,drag,stretch){
    const p=parts[partI]; const idx=partI; partI=(partI+1)%PART_N;
    p.a=true; p.x=x; p.y=y; p.z=z; p.vx=vx; p.vy=vy; p.vz=vz; p.s=s; p.life=life; p.max=life; p.g=grav||0; p.drag=drag||0; p.stretch=stretch||0;
    partMesh.setColorAt(idx, tmpC.setRGB(r,gg,b)); partMesh.instanceColor.needsUpdate=true;
  }
  const UP=new THREE.Vector3(0,1,0), FWD=new THREE.Vector3(0,0,1);
  function updateParts(dt){
    for(let i=0;i<PART_N;i++){
      const p=parts[i]; if(!p.a) continue;
      p.life-=dt; if(p.life<=0){ p.a=false; tmpM.makeScale(0,0,0); partMesh.setMatrixAt(i,tmpM); continue; }
      const k=Math.max(0,1-p.drag*dt); p.vx*=k; p.vy*=k; p.vz*=k; p.vy-=p.g*dt;
      p.x+=p.vx*dt; p.y+=p.vy*dt; p.z+=p.vz*dt; if(p.y<0.03){ p.y=0.03; p.vy*=-0.3; }
      const t=p.life/p.max, sc=p.s*t;
      if(p.stretch>0){
        const sp=Math.hypot(p.vx,p.vy,p.vz)||1; tmpV.set(p.vx/sp,p.vy/sp,p.vz/sp); tmpQ.setFromUnitVectors(FWD,tmpV);
        tmpM.compose(tmpS.set(p.x,p.y,p.z), tmpQ, tmpV.set(sc,sc,sc+sp*p.stretch*t));
      } else { tmpQ.identity(); tmpM.compose(tmpV.set(p.x,p.y,p.z), tmpQ, tmpS.set(sc,sc,sc)); }
      partMesh.setMatrixAt(i,tmpM);
    }
    partMesh.instanceMatrix.needsUpdate=true;
  }
  const smokes=[]; let smokeI=0;
  for(let i=0;i<SMOKE_N;i++) smokes.push({a:false,x:0,y:0,z:0,vx:0,vy:0,vz:0,s:1,life:0,max:1,r:0});
  function spawnSmoke(x,y,z,vx,vy,vz,s,life,shade){
    const p=smokes[smokeI]; const idx=smokeI; smokeI=(smokeI+1)%SMOKE_N;
    p.a=true; p.x=x; p.y=y; p.z=z; p.vx=vx; p.vy=vy; p.vz=vz; p.s=s; p.life=life; p.max=life; p.r=rand(0,TAU);
    const v=shade==null?rand(0.18,0.32):shade; smokeMesh.setColorAt(idx, tmpC.setRGB(v,v*0.95,v*0.92)); smokeMesh.instanceColor.needsUpdate=true;
  }
  function updateSmoke(dt){
    for(let i=0;i<SMOKE_N;i++){
      const p=smokes[i]; if(!p.a) continue;
      p.life-=dt; if(p.life<=0){ p.a=false; tmpM.makeScale(0,0,0); smokeMesh.setMatrixAt(i,tmpM); continue; }
      const k=Math.max(0,1-2.5*dt); p.vx*=k; p.vz*=k; p.vy*=Math.max(0,1-1.2*dt);
      p.x+=p.vx*dt; p.y+=p.vy*dt; p.z+=p.vz*dt; p.r+=dt*0.8;
      const t=1-p.life/p.max; const sc=p.s*(t<0.15? t/0.15 : 1-(t-0.15)/0.85*0.9)*(0.6+t*0.8);
      tmpE.set(p.r*0.7,p.r,p.r*0.4); tmpQ.setFromEuler(tmpE);
      tmpM.compose(tmpV.set(p.x,p.y,p.z), tmpQ, tmpS.set(sc,sc,sc)); smokeMesh.setMatrixAt(i,tmpM);
    }
    smokeMesh.instanceMatrix.needsUpdate=true;
  }
  let decalI=0;
  function spawnDecal(x,z,size,color,rot){
    const idx=decalI; decalI=(decalI+1)%DECAL_N;
    tmpE.set(0,rot==null?rand(0,TAU):rot,0); tmpQ.setFromEuler(tmpE);
    tmpM.compose(tmpV.set(x,0.012+idx*0.000004,z), tmpQ, tmpS.set(size,1,size*rand(0.8,1.1)));
    decalMesh.setMatrixAt(idx,tmpM); decalMesh.setColorAt(idx, tmpC.set(color));
    decalMesh.instanceMatrix.needsUpdate=true; decalMesh.instanceColor.needsUpdate=true;
  }
  function clearDecals(){ tmpM.makeScale(0,0,0); for(let i=0;i<DECAL_N;i++) decalMesh.setMatrixAt(i,tmpM); decalMesh.instanceMatrix.needsUpdate=true; for(const g of gibs) g.life=Math.min(g.life,0.5); }

  function addTracer(x0,y0,z0,x1,y1,z1,rail){
    const t=tracers.find(t=>t.life<=0) || tracers[0];
    const dx=x1-x0, dy=y1-y0, dz=z1-z0, L=Math.hypot(dx,dy,dz)||0.01;
    t.m.material = rail? mats.rail : mats.tracer;
    t.m.position.set((x0+x1)/2,(y0+y1)/2,(z0+z1)/2);
    tmpV.set(dx/L,dy/L,dz/L); t.m.quaternion.setFromUnitVectors(FWD,tmpV);
    t.w = rail?0.22:0.06; t.m.scale.set(t.w,t.w,L); t.life=t.t=rail?0.32:0.07; t.m.visible=true;
  }
  function updateTracers(dt){ for(const t of tracers){ if(t.life<=0) continue; t.life-=dt; if(t.life<=0){ t.m.visible=false; continue; } const k=t.life/t.t; t.m.scale.x=t.m.scale.y=t.w*k; } }
  function addRing(x,z,r,life,color){
    const g=rings.find(g=>g.life<=0)||rings[0]; g.m.position.set(x,0.06,z); g.r=r; g.life=g.t=life; g.m.visible=true; g.m.material.color.copy(color||new THREE.Color(4,2.4,1)); g.m.scale.setScalar(0.1);
  }
  function updateRings(dt){ for(const g of rings){ if(g.life<=0) continue; g.life-=dt; if(g.life<=0){ g.m.visible=false; continue; } const t=1-g.life/g.t; const e=1-Math.pow(1-t,3); g.m.scale.setScalar(0.2+g.r*e); g.m.material.opacity=(1-t); } }
  function boomLight(x,z,power){ const b=boomLights.reduce((a,c)=>c.t<a.t?c:a); b.l.position.set(x,1.6,z); b.t=0.45; b.p=power; }
  function updateLights(dt){
    for(const b of boomLights){ if(b.t>0){ b.t-=dt; b.l.intensity=Math.max(0,b.t/0.45)*(b.p||30); } else b.l.intensity=0; }
    for(let i=0;i<4;i++){ const l=muzzleLights[i]; l.intensity=Math.max(0,l.intensity-dt*90); }
  }

  // ---------------- floating text ----------------
  const fx=[]; let fxEl;
  function floatText(x,y,z,txt,cls,life){
    if(!fxEl) return;
    let f=fx.find(f=>f.life<=0);
    if(!f){ if(fx.length>70) f=fx[0]; else { const el=document.createElement('div'); el.className='fl'; fxEl.appendChild(el); f={el,life:0}; fx.push(f); } }
    f.el.className='fl '+cls; f.el.textContent=txt; f.x=x+rand(-0.15,0.15); f.y=y; f.z=z; f.life=f.max=life||0.7; f.vy=cls==='big'?0.6:1.8; f.el.style.display='block';
  }
  function updateFx(dt){
    for(const f of fx){
      if(f.life<=0) continue;
      f.life-=dt; if(f.life<=0){ f.el.style.display='none'; continue; }
      f.y+=f.vy*dt; f.vy*=0.96;
      tmpV.set(f.x,f.y,f.z).project(camera);
      const sx=(tmpV.x*0.5+0.5)*innerWidth, sy=(-tmpV.y*0.5+0.5)*innerHeight; const t=1-f.life/f.max;
      const s = t<0.12 ? 0.6+t/0.12*0.7 : 1.3-Math.min(0.3,(t-0.12)*1.5);
      f.el.style.transform=`translate(${sx}px,${sy}px) translate(-50%,-50%) scale(${s})`; f.el.style.opacity= t>0.7 ? (1-t)/0.3 : 1;
    }
  }

  // ---------------- audio ----------------
  const AU={ ctx:null, muted:false, last:{} };
  function auInit(){
    if(AU.ctx){ if(AU.ctx.state==='suspended') AU.ctx.resume(); return; }
    const AC=window.AudioContext||window.webkitAudioContext; if(!AC) return;
    try{
      const c=new AC(); AU.ctx=c;
      AU.master=c.createGain(); AU.master.gain.value=AU.muted?0:0.7;
      const comp=c.createDynamicsCompressor(); comp.threshold.value=-16; comp.ratio.value=5; comp.attack.value=0.003; comp.release.value=0.2;
      AU.master.connect(comp); comp.connect(c.destination);
      AU.sfx=c.createGain(); AU.sfx.gain.value=1; AU.sfx.connect(AU.master);
      AU.music=c.createGain(); AU.music.gain.value=0.32; AU.music.connect(AU.master);
      const len=c.sampleRate*2, buf=c.createBuffer(1,len,c.sampleRate), d=buf.getChannelData(0); for(let i=0;i<len;i++) d[i]=Math.random()*2-1; AU.noise=buf;
      startMusic();
    }catch(e){ AU.ctx=null; }
  }
  function tone(type,f0,f1,dur,vol,dest,t0){
    const c=AU.ctx; if(!c) return; const t=t0||c.currentTime;
    const o=c.createOscillator(), g=c.createGain(); o.type=type; o.frequency.setValueAtTime(f0,t); o.frequency.exponentialRampToValueAtTime(Math.max(20,f1),t+dur);
    g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(vol,t+0.005); g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
    o.connect(g); g.connect(dest||AU.sfx); o.start(t); o.stop(t+dur+0.02);
  }
  function burst(ftype,freq,q,dur,vol,freqEnd,dest,t0){
    const c=AU.ctx; if(!c) return; const t=t0||c.currentTime;
    const s=c.createBufferSource(); s.buffer=AU.noise; const f=c.createBiquadFilter(); f.type=ftype; f.frequency.setValueAtTime(freq,t); if(freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd,t+dur); f.Q.value=q;
    const g=c.createGain(); g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(vol,t+0.004); g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
    s.connect(f); f.connect(g); g.connect(dest||AU.sfx); s.start(t, Math.random()*1.5); s.stop(t+dur+0.02);
  }
  function sfx(name,arg){
    if(!AU.ctx || AU.muted) return;
    const now=AU.ctx.currentTime, min={hit:0.025,uzi:0.045,kill:0.02,groan:0.5,dust:0.08}[name]||0;
    if(min && now-(AU.last[name]||0)<min) return; AU.last[name]=now;
    switch(name){
      case 'pistol': burst('bandpass',2600,0.8,0.09,0.42,900); tone('square',260,55,0.09,0.14); break;
      case 'uzi': burst('bandpass',rand(1900,2600),1.1,0.06,0.28,800); tone('square',190,60,0.05,0.08); break;
      case 'shotgun': burst('lowpass',2400,0.6,0.32,0.75,260); tone('sine',140,38,0.3,0.55); burst('highpass',4000,0.5,0.05,0.25); break;
      case 'rail': tone('sawtooth',2600,160,0.5,0.2); burst('highpass',2500,0.7,0.25,0.25,9000); tone('sine',110,35,0.45,0.5); break;
      case 'boom': burst('lowpass',1100,0.7,1.3,1.0,70); tone('sine',95,26,0.9,0.9); burst('bandpass',300,0.6,0.5,0.4,80); break;
      case 'hit': tone('square',rand(900,1200),300,0.035,0.05); break;
      case 'kill': burst('bandpass',rand(450,700),2.5,0.14,0.32,200); tone('triangle',320+arg*22,640+arg*26,0.07,0.07); break;
      case 'hurt': tone('square',280,85,0.2,0.18); burst('lowpass',600,1,0.15,0.2); break;
      case 'pickup': [0,0.06,0.12].forEach((d,i)=>tone('triangle',660*Math.pow(1.26,i),700*Math.pow(1.26,i),0.12,0.12,null,now+d)); break;
      case 'wave': tone('sawtooth',220,218,0.5,0.12,null,now); tone('sawtooth',330,328,0.7,0.1,null,now+0.18); burst('lowpass',400,0.7,0.6,0.25,80); break;
      case 'unlock': [0,0.07,0.14,0.21].forEach((d,i)=>tone('square',440*Math.pow(1.335,i),450*Math.pow(1.335,i),0.14,0.08,null,now+d)); break;
      case 'throw': tone('sine',380,950,0.14,0.08); break;
      case 'place': tone('triangle',170,85,0.12,0.2); burst('lowpass',500,1,0.08,0.2); break;
      case 'click': tone('square',2200,1800,0.02,0.05); break;
      case 'groan': { const c=AU.ctx, t=now, o=c.createOscillator(), f=c.createBiquadFilter(), g=c.createGain(), lfo=c.createOscillator(), lg=c.createGain(); o.type='sawtooth'; o.frequency.value=rand(70,110); lfo.frequency.value=rand(5,8); lg.gain.value=8; lfo.connect(lg); lg.connect(o.frequency); f.type='lowpass'; f.frequency.value=500; f.Q.value=6; g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(0.09,t+0.15); g.gain.exponentialRampToValueAtTime(0.0001,t+0.9); o.frequency.exponentialRampToValueAtTime(rand(45,60),t+0.9); o.connect(f); f.connect(g); g.connect(AU.sfx); o.start(t); lfo.start(t); o.stop(t+1); lfo.stop(t+1); break; }
      case 'down': tone('sawtooth',400,60,0.9,0.18); break;
      case 'revive': [0,0.08,0.16].forEach((d,i)=>tone('sine',520*Math.pow(1.5,i),530*Math.pow(1.5,i),0.2,0.12,null,now+d)); break;
      case 'fireball': burst('bandpass',800,1.2,0.25,0.18,300); break;
      case 'dust': burst('lowpass',700,0.8,0.25,0.12,150); break;
      case 'bounce': tone('triangle',500,300,0.04,0.06); break;
      case 'comboEnd': tone('triangle',700,300,0.25,0.08); break;
      case 'over': tone('sawtooth',300,40,2.0,0.22); burst('lowpass',600,0.6,1.8,0.4,60); break;
    }
  }
  // music sequencer
  const MUS={ step:0, next:0, timer:null, intensity:0.35 };
  const BASS=[45,0,45,48, 0,45,43,0, 45,0,45,52, 0,50,48,43];
  function mtof(m){ return 440*Math.pow(2,(m-69)/12); }
  function startMusic(){
    if(MUS.timer) return; MUS.next=AU.ctx.currentTime+0.1;
    MUS.timer=setInterval(()=>{
      const c=AU.ctx; if(!c) return; const spb=60/116/4;
      while(MUS.next < c.currentTime+0.12){
        const s=MUS.step%16, t=MUS.next, I=MUS.intensity;
        if(s%4===0 && (I>0.5 || s===0 || s===8)){ const o=c.createOscillator(), g=c.createGain(); o.frequency.setValueAtTime(150,t); o.frequency.exponentialRampToValueAtTime(42,t+0.18); g.gain.setValueAtTime(0.9,t); g.gain.exponentialRampToValueAtTime(0.001,t+0.3); o.connect(g); g.connect(AU.music); o.start(t); o.stop(t+0.32); }
        if((s===4||s===12) && I>0.5) burst('bandpass',1800,0.8,0.14,0.35,1200,AU.music,t);
        if(s%2===1 && I>0.2) burst('highpass',7500,0.7,0.035,I>0.7?0.18:0.1,null,AU.music,t);
        const n=BASS[s]; if(n){ const o=c.createOscillator(), f=c.createBiquadFilter(), g=c.createGain(); o.type='sawtooth'; o.frequency.value=mtof(n-12); f.type='lowpass'; f.Q.value=8; f.frequency.setValueAtTime(300+I*900,t); f.frequency.exponentialRampToValueAtTime(120,t+0.16); g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(0.35,t+0.01); g.gain.exponentialRampToValueAtTime(0.0001,t+0.2); o.connect(f); f.connect(g); g.connect(AU.music); o.start(t); o.stop(t+0.22); }
        MUS.step++; MUS.next+=spb;
      }
    },25);
  }
  function setMuted(m){ AU.muted=m; if(AU.master) AU.master.gain.value=m?0:0.7; const b=$('#muteBtn'); b.textContent= m?'Son : coupé':'Son : activé'; b.setAttribute('aria-pressed', m?'true':'false'); }

  // ---------------- rigs ----------------
  function part(parent, mat, sx,sy,sz, x,y,z, shadow){ const m=new THREE.Mesh(G.box, mat); m.scale.set(sx,sy,sz); m.position.set(x,y,z); m.castShadow=shadow!==false; parent.add(m); return m; }
  function makeRig(kind, slot){
    const root=new THREE.Group(); const body=new THREE.Group(); root.add(body);
    const legL=new THREE.Group(), legR=new THREE.Group(), armL=new THREE.Group(), armR=new THREE.Group();
    let skin, shirt, pants, eye, colors;
    if(kind==='player'){ skin=mats.skin; shirt=mats.slot[slot]; pants=mats.pants; eye=mats.eye; colors=[SLOT_COLORS[slot],'#F2D1A8','#2E3440']; }
    else if(kind==='zombie'){ skin=mats.zSkin; shirt=mats.zShirt; pants=mats.zPants; eye=mats.zEye; colors=['#8DB572','#5A4878','#3B3550','#8DB572']; }
    else if(kind==='devil'){ skin=mats.dSkin; shirt=mats.dBody; pants=mats.dBody; eye=mats.dEye; colors=['#D6304A','#8E1B30','#2B1B1B','#D6304A']; }
    else { skin=mats.bSkin; shirt=mats.bShirt; pants=mats.zPants; eye=mats.zEye; colors=['#6F8F55','#4E3B2A','#3B3550','#6F8F55']; }
    legL.position.set(-0.13,0.36,0); legR.position.set(0.13,0.36,0);
    part(legL,pants,0.18,0.36,0.22,0,-0.18,0); part(legR,pants,0.18,0.36,0.22,0,-0.18,0);
    root.add(legL); root.add(legR);
    part(body,shirt,0.54,0.46,0.34,0,0.59,0);
    const head=new THREE.Group(); head.position.set(0,1.03,0); body.add(head);
    part(head,skin,0.44,0.42,0.42,0,0,0);
    part(head,eye,0.07,0.09,0.02,-0.1,0.02,0.215,false); part(head,eye,0.07,0.09,0.02,0.1,0.02,0.215,false);
    armL.position.set(-0.34,0.76,0); armR.position.set(0.34,0.76,0); body.add(armL); body.add(armR);
    let gun=null;
    if(kind==='player'){
      part(head,shirt,0.48,0.1,0.48,0,0.24,0); part(head,shirt,0.4,0.05,0.18,0,0.2,0.28);
      part(armL,skin,0.13,0.13,0.4,0.08,-0.08,0.18); part(armR,skin,0.13,0.13,0.4,-0.06,-0.08,0.18);
      gun=new THREE.Group(); gun.position.set(0.1,0.66,0.42); body.add(gun);
      part(gun,mats.dark,0.11,0.13,0.46,0,0,0); part(gun,mats.dark,0.08,0.16,0.08,0,-0.12,-0.12);
    } else if(kind==='devil'){
      part(head,mats.dHorn,0.08,0.22,0.08,-0.15,0.3,0).rotation.z=0.35; part(head,mats.dHorn,0.08,0.22,0.08,0.15,0.3,0).rotation.z=-0.35;
      part(armL,skin,0.14,0.42,0.14,0,-0.2,0); part(armR,skin,0.14,0.42,0.14,0,-0.2,0);
      const tail=part(body,mats.dHorn,0.06,0.06,0.4,0,0.4,-0.32); tail.rotation.x=-0.5;
    } else {
      part(armL,skin,0.14,0.14,0.48,0,-0.04,0.22); part(armR,skin,0.14,0.14,0.48,0,-0.04,0.22);
      armL.rotation.x=-0.15; armR.rotation.x=-0.1;
      if(kind==='brute'){ part(body,shirt,0.7,0.2,0.42,0,0.78,0); }
    }
    const meshes=[]; root.traverse(o=>{ if(o.isMesh) meshes.push({m:o, mat:o.material}); });
    scene.add(root);
    return {root, body, head, legL, legR, armL, armR, gun, meshes, colors, flashing:false};
  }
  function setFlash(rig,on){ if(rig.flashing===on) return; rig.flashing=on; for(const o of rig.meshes) o.m.material = on? mats.flash : o.mat; }
  function disposeRig(rig){ scene.remove(rig.root); }

  // ---------------- players ----------------
  function freeSlot(){ for(let s=0;s<4;s++) if(!players.some(p=>p.slot===s)) return s; return -1; }
  function addPlayer(src,name,kind){
    const slot=freeSlot(); if(slot<0) return null;
    const rig=makeRig('player',slot);
    const ring=new THREE.Mesh(G.ring, mats.slotRing[slot]); ring.position.y=0.03; ring.renderOrder=10; scene.add(ring);
    const sp=spawnPointForPlayer(slot);
    const p={ src, kind, slot, name:name||('Joueur '+(slot+1)), color:SLOT_COLORS[slot], x:sp.x, z:sp.z, vx:0, vz:0, kx:0, kz:0,
      face:Math.PI, aim:Math.PI, aimMag:0, hp:100, maxHp:100, downed:false, revive:0, inv:0, weapon:0, ammo:WEAPONS.map(w=>w.start), fireCd:0,
      score:0, kills:0, hitCount:0, killCount:0, rig, ring, walkT:0, kick:0, flash:0, squash:0, lastSeen:performance.now(),
      input:{mx:0,my:0,ax:0,ay:0,fire:false}, lastSw:0, lastSt:0, reviveRing:null };
    players.push(p);
    spawnPuff(p.x,p.z,SLOT_COLORS[slot]);
    sfx('revive');
    floatText(p.x,1.8,p.z,p.name,'score',1.4);
    renderSlots(); renderCards();
    return p;
  }
  function spawnPointForPlayer(slot){ const pts=[[-2,1],[2,1],[-2,3],[2,3]]; return {x:pts[slot][0], z:pts[slot][1]}; }
  function removePlayer(p){
    const i=players.indexOf(p); if(i<0) return;
    players.splice(i,1); spawnPuff(p.x,p.z,p.color);
    disposeRig(p.rig); scene.remove(p.ring); if(p.reviveRing) scene.remove(p.reviveRing);
    if(p===kbPlayer) kbPlayer=null;
    for(const k in gpPlayers) if(gpPlayers[k]===p) delete gpPlayers[k];
    renderSlots(); renderCards();
    if(phase==='play' && players.length===0) toLobby();
  }
  function spawnPuff(x,z,color){
    const c=new THREE.Color(color);
    for(let i=0;i<26;i++){ const a=rand(0,TAU), s=rand(1,4); spawnPart(x,rand(0.1,1.2),z,Math.cos(a)*s,rand(1,5),Math.sin(a)*s,rand(0.08,0.2),c.r*3,c.g*3,c.b*3,rand(0.3,0.7),6,3); }
    addRing(x,z,2,0.5,c.clone().multiplyScalar(3));
  }
  function unlocked(w){ return phase!=='play' || WEAPONS[w].unlock<=wave; }
  function hasAmmo(p,w){ return p.ammo[w]===Infinity || p.ammo[w]>0 || phase!=='play'; }
  function cycleWeapon(p,dir){
    if(p.downed) return;
    let w=p.weapon;
    for(let i=0;i<WEAPONS.length;i++){ w=(w+(dir||1)+WEAPONS.length)%WEAPONS.length; if(unlocked(w) && hasAmmo(p,w)) break; }
    if(w!==p.weapon){ p.weapon=w; sfx('click'); floatText(p.x,1.9,p.z,WEAPONS[w].name,'dmg',0.8); p.fireCd=Math.max(p.fireCd,0.12); renderCards(); }
  }
  function hurtPlayer(p,dmg,fx,fz){
    if(p.downed || p.inv>0 || phase==='over') return;
    p.hp-=dmg; p.inv=0.45; p.flash=0.12; p.hitCount++; p.squash=1;
    p.kx+=fx*5; p.kz+=fz*5;
    shake=Math.min(1,shake+0.35); damageAmt=Math.min(1,damageAmt+0.55); aberr=Math.min(1,aberr+0.5);
    sfx('hurt');
    for(let i=0;i<8;i++) spawnGib(p.x,0.8,p.z,fx*3+rand(-2,2),rand(2,5),fz*3+rand(-2,2),rand(0.05,0.1),'#9E1428',rand(2,4));
    if(p.hp<=0){
      p.hp=0; p.downed=true; p.revive=0; sfx('down'); freeze=Math.max(freeze,0.12);
      floatText(p.x,1.8,p.z,'À terre !','crit',1.2); spawnDecal(p.x,p.z,1.6,'#5E0B17');
      if(!p.reviveRing){ p.reviveRing=new THREE.Mesh(G.shock, mats.downRing); p.reviveRing.position.y=0.04; scene.add(p.reviveRing); }
      p.reviveRing.visible=true;
      if(players.every(q=>q.downed)) gameOver();
    }
    renderCards();
  }

  // ---------------- enemies ----------------
  const ETYPES={
    zombie:{hp:42, speed:1.65, r:0.36, dmg:11, score:10, scale:1},
    devil:{hp:70, speed:2.25, r:0.36, dmg:14, score:30, scale:1.02},
    brute:{hp:360, speed:1.15, r:0.6, dmg:26, score:120, scale:1.65},
  };
  function spawnEnemy(type, x, z){
    const T=ETYPES[type]; const w=Math.max(1,wave);
    const hpMul = phase==='play' ? (1+(w-1)*0.09)*(1+(players.length-1)*0.15) : 1;
    const e={type, x:x+rand(-0.2,0.2), z:z+rand(-0.2,0.2), y:-1.4, vy:0, vx:0, vz:0, kx:0, kz:0, hp:T.hp*hpMul, maxHp:T.hp*hpMul,
      speed:T.speed*(phase==='play'?(1+Math.min(0.45,(w-1)*0.035)):0.8)*rand(0.9,1.12), r:T.r, dmg:T.dmg, score:T.score, scale:T.scale,
      atk:0, shootCd:rand(1.5,3), flash:0, squash:0, spawnT:0.7, walkT:rand(0,10), face:0, rig:makeRig(type), lunge:0, airborne:false };
    e.rig.root.scale.setScalar(T.scale);
    enemies.push(e);
    for(let i=0;i<10;i++){ const a=rand(0,TAU); spawnPart(e.x,0.1,e.z,Math.cos(a)*rand(1,3),rand(2,5),Math.sin(a)*rand(1,3),rand(0.06,0.14),2.2,0.4,0.25,rand(0.3,0.6),12,2); }
    spawnSmoke(e.x,0.3,e.z,0,0.8,0,0.6*T.scale,0.9,0.22);
    sfx('dust');
    return e;
  }
  function nearestPlayer(x,z){
    let best=null, bd=1e9; for(const p of players){ if(p.downed) continue; const d=(p.x-x)**2+(p.z-z)**2; if(d<bd){ bd=d; best=p; } } return best?{p:best,d:Math.sqrt(bd)}:null;
  }
  function damageEnemy(e,dmg,dx,dz,kb,owner,cause){
    if(e.hp<=0) return;
    e.hp-=dmg; e.flash=0.07; e.squash=1;
    e.kx+=dx*kb; e.kz+=dz*kb;
    const crit = dmg>=60;
    floatText(e.x,1.5*e.scale,e.z,String(Math.round(dmg)), crit?'crit':'dmg', 0.55);
    for(let i=0;i<4;i++) spawnPart(e.x-dx*0.2,rand(0.5,1.1)*e.scale,e.z-dz*0.2, dx*rand(1,5)+rand(-2,2), rand(1,4), dz*rand(1,5)+rand(-2,2), rand(0.04,0.08), 4,1.3,0.4, rand(0.12,0.25), 10, 2, 0.02);
    for(let i=0;i<2;i++) spawnGib(e.x,rand(0.6,1.1)*e.scale,e.z, dx*rand(2,5)+rand(-1,1), rand(1,4), dz*rand(2,5)+rand(-1,1), rand(0.05,0.09), '#8C1426', rand(1.5,3));
    sfx('hit');
    if(e.hp<=0) killEnemy(e,dx,dz,owner,cause);
  }
  function killEnemy(e,dx,dz,owner,cause){
    const i=enemies.indexOf(e); if(i>=0) enemies.splice(i,1);
    const boom = cause==='boom', S=e.scale;
    const pw = boom?1.8:1;
    const cols=e.rig.colors;
    // head pops
    spawnGib(e.x,1.05*S,e.z, dx*rand(2,5)*pw+rand(-1,1), rand(5,9)*pw, dz*rand(2,5)*pw+rand(-1,1), 0.4*S, cols[0], rand(7,10));
    for(let k=0;k<Math.round(10*S);k++){ const c=cols[k%cols.length]; spawnGib(e.x+rand(-0.2,0.2),rand(0.3,1)*S,e.z+rand(-0.2,0.2), dx*rand(1,6)*pw+rand(-2.5,2.5), rand(2,7)*pw, dz*rand(1,6)*pw+rand(-2.5,2.5), rand(0.12,0.24)*S, c, rand(6,9)); }
    for(let k=0;k<10;k++) spawnGib(e.x,rand(0.4,1)*S,e.z, dx*rand(2,7)+rand(-3,3), rand(2,6), dz*rand(2,7)+rand(-3,3), rand(0.05,0.1), k%2?'#7A0E1F':'#A3182C', rand(3,6));
    spawnDecal(e.x+dx*0.6,e.z+dz*0.6,rand(1.2,1.9)*S, '#4E0A14');
    spawnDecal(e.x+dx*1.4,e.z+dz*1.4,rand(0.5,0.9)*S, '#5E0B17');
    disposeRig(e.rig);
    // score & combo
    if(phase==='play'){
      combo++; comboT=3.0; bestCombo=Math.max(bestCombo,combo); totalKills++;
      const mult=1+Math.floor(combo/5)*0.5; const pts=Math.round(e.score*mult);
      teamScore+=pts; if(owner){ owner.score+=pts; owner.kills++; owner.killCount++; }
      floatText(e.x,2*S,e.z,'+'+pts,'score',0.9);
      const cn=$('#comboNum'); cn.classList.remove('pop'); void cn.offsetWidth; cn.classList.add('pop');
      if(combo%10===0){ floatText(e.x,2.6,e.z,(combo>=30?'Inarrêtable ! ':combo>=20?'Massacre ! ':'Carnage ! ')+'×'+combo,'big',1.3); freeze=Math.max(freeze,0.07); shake=Math.min(1,shake+0.3); flashAmt=Math.max(flashAmt,0.25); }
      if(Math.random()<0.05+(e.type==='brute'?0.6:0)) spawnPickup(e.x,e.z, Math.random()<0.55?'ammo':'hp');
    } else if(owner){ owner.killCount++; }
    shake=Math.min(1,shake+(e.type==='brute'?0.5:0.08));
    if(e.type==='brute'){ freeze=Math.max(freeze,0.09); flashAmt=Math.max(flashAmt,0.3); boomLight(e.x,e.z,18); addRing(e.x,e.z,4,0.5,new THREE.Color(3,0.6,0.5)); }
    sfx('kill', Math.min(combo,30));
  }

  // ---------------- barrels / grenades / fireballs / explosions ----------------
  function placeBarrel(p,dx,dz){
    let x=p.x+dx*0.95, z=p.z+dz*0.95;
    if(solid(toTx(x),toTy(z))){ x=p.x; z=p.z; }
    if(barrels.length>=24){ explodeBarrel(barrels[0]); }
    const g=new THREE.Group(); const c=new THREE.Mesh(G.cyl, mats.barrel); c.position.y=0.39; c.castShadow=true; g.add(c);
    const band=new THREE.Mesh(G.cyl, mats.barrelBand); band.scale.set(1.04,0.18,1.04); band.position.y=0.42; g.add(band);
    const top=new THREE.Mesh(G.cyl, mats.dark); top.scale.set(0.98,0.04,0.98); top.position.y=0.79; g.add(top);
    g.position.set(x,0,z); g.scale.set(1.3,0.3,1.3); scene.add(g);
    barrels.push({x,z,hp:25,mesh:g,owner:p,fuse:-1,pop:0,flash:0});
    sfx('place'); spawnSmoke(x,0.1,z,0,0.4,0,0.5,0.6,0.35);
  }
  function explodeBarrel(b){
    const i=barrels.indexOf(b); if(i<0) return; barrels.splice(i,1); scene.remove(b.mesh);
    explosion(b.x,b.z,3.5,220,b.owner);
    for(let k=0;k<8;k++){ spawnGib(b.x,0.5,b.z,rand(-6,6),rand(6,12),rand(-6,6),rand(0.12,0.22),k%3?'#C8283A':'#FFC845',rand(5,8)); }
  }
  function throwGrenade(p,dx,dz){
    const d = 2.5 + clamp(p.aimMag,0.35,1)*6;
    const t=0.75, vx=dx*d/t, vz=dz*d/t, vy=(0.5*22*t*t-0.9)/t;
    const m=new THREE.Mesh(G.box, mats.grenade); m.scale.set(0.2,0.24,0.2); m.castShadow=true; scene.add(m);
    projectiles.push({kind:'grenade', x:p.x+dx*0.5, y:0.9, z:p.z+dz*0.5, vx, vy, vz, fuse:1.35, mesh:m, owner:p, spin:rand(8,14)});
    sfx('throw');
  }
  function shootFireball(e,tp){
    const dx=tp.x-e.x, dz=tp.z-e.z, L=Math.hypot(dx,dz)||1;
    const m=new THREE.Mesh(G.sphere, mats.fireball); scene.add(m);
    projectiles.push({kind:'fire', x:e.x+dx/L*0.5, y:0.9, z:e.z+dz/L*0.5, vx:dx/L*7.5, vy:0, vz:dz/L*7.5, life:3, mesh:m});
    e.lunge=0.5; sfx('fireball');
  }
  function explosion(x,z,R,dmg,owner){
    sfx('boom'); shake=Math.min(1,shake+0.75); freeze=Math.max(freeze,0.075); flashAmt=Math.max(flashAmt,0.65); aberr=Math.min(1,aberr+0.8);
    boomLight(x,z,42);
    addRing(x,z,R*1.15,0.45,new THREE.Color(5,2.6,0.9));
    addRing(x,z,R*0.6,0.3,new THREE.Color(6,5,3));
    spawnDecal(x,z,R*1.1,'#0E0B0A'); spawnDecal(x,z,R*0.6,'#1A1210');
    for(let i=0;i<70;i++){ const a=rand(0,TAU), s=rand(2,11), up=rand(2,10); const h=Math.random(); spawnPart(x,rand(0.2,0.8),z,Math.cos(a)*s,up,Math.sin(a)*s,rand(0.1,0.32), 6, 1.6+h*2.4, 0.3+h*0.5, rand(0.25,0.7), 5, 2.5, 0.015); }
    for(let i=0;i<26;i++){ const a=rand(0,TAU), s=rand(0.5,3.5); spawnSmoke(x+Math.cos(a)*rand(0,1),rand(0.3,1),z+Math.sin(a)*rand(0,1),Math.cos(a)*s,rand(1,3.5),Math.sin(a)*s,rand(0.5,1.1),rand(1.2,2.4)); }
    for(let i=0;i<14;i++) spawnGib(x,0.3,z,rand(-7,7),rand(5,11),rand(-7,7),rand(0.06,0.14),Math.random()<.5?'#2B2522':'#4A3F38',rand(3,6));
    for(const e of enemies.slice()){
      const dx=e.x-x, dz=e.z-z, d=Math.hypot(dx,dz); if(d>R+e.r) continue;
      const f=Math.pow(1-clamp(d/(R+e.r),0,1),0.55), nx=dx/(d||1), nz=dz/(d||1);
      e.vy=7*f; e.airborne=true;
      damageEnemy(e,dmg*f,nx,nz,13*f,owner,'boom');
    }
    for(const p of players){ const dx=p.x-x, dz=p.z-z, d=Math.hypot(dx,dz); if(d<R*0.8){ const f=1-d/(R*0.8); hurtPlayer(p,Math.round(30*f),dx/(d||1),dz/(d||1)); } }
    for(const b of barrels){ if(b.fuse<0){ const d=Math.hypot(b.x-x,b.z-z); if(d<R+0.4){ b.fuse=0.1+d*0.03; b.flash=1; } } }
  }

  // ---------------- pickups ----------------
  function spawnPickup(x,z,type){
    if(pickups.length>=6) return;
    const g=new THREE.Group();
    if(type==='ammo'){ const b=new THREE.Mesh(G.box, mats.pickAmmo); b.scale.set(0.5,0.36,0.36); b.castShadow=true; g.add(b); const m=new THREE.Mesh(G.box,mats.pickAmmoMark); m.scale.set(0.3,0.06,0.37); g.add(m); }
    else { const b=new THREE.Mesh(G.box, mats.pickHp); b.scale.set(0.42,0.42,0.42); b.castShadow=true; g.add(b); const c1=new THREE.Mesh(G.box,mats.pickHpCross); c1.scale.set(0.3,0.1,0.44); g.add(c1); const c2=new THREE.Mesh(G.box,mats.pickHpCross); c2.scale.set(0.1,0.3,0.44); g.add(c2); const c3=new THREE.Mesh(G.box,mats.pickHpCross); c3.scale.set(0.44,0.1,0.1); c3.position.set(0,0,0); g.add(c3); }
    g.position.set(x,0.5,z); scene.add(g);
    pickups.push({x,z,type,mesh:g,t:0,life:22});
  }
  function randomFreeTile(minDistPlayers){
    for(let k=0;k<40;k++){
      const tx=Math.floor(rand(2,MW-2)), ty=Math.floor(rand(2,MH-2)); if(solid(tx,ty)) continue;
      const x=tileX(tx), z=tileZ(ty); if(players.some(p=>Math.hypot(p.x-x,p.z-z)<minDistPlayers)) continue; return {x,z};
    }
    return null;
  }

  // ---------------- firing ----------------
  function playerFire(p,dt){
    p.fireCd-=dt;
    if(p.downed || !p.input.fire || p.fireCd>0) return;
    let w=WEAPONS[p.weapon];
    if(!hasAmmo(p,p.weapon) || !unlocked(p.weapon)){ p.weapon=0; w=WEAPONS[0]; renderCards(); }
    p.fireCd=1/w.rate;
    if(phase==='play' && p.ammo[p.weapon]!==Infinity){ p.ammo[p.weapon]--; if(p.ammo[p.weapon]<=0){ floatText(p.x,1.9,p.z,'À sec !','dmg',0.8); } }
    const dx=Math.sin(p.aim), dz=Math.cos(p.aim);
    if(w.kind==='barrel'){ placeBarrel(p,dx,dz); return; }
    if(w.kind==='grenade'){ throwGrenade(p,dx,dz); p.kick=0.6; return; }
    const px=-dz, pz=dx;
    const mx=p.x+dx*0.85+px*0.1, my=0.66, mz=p.z+dz*0.85+pz*0.1;
    for(let k=0;k<w.pellets;k++){
      const a=p.aim+rand(-w.spread,w.spread)*(w.pellets>1?1:1);
      const rx=Math.sin(a), rz=Math.cos(a);
      hitscan(p, mx, mz, rx, rz, w);
    }
    p.kick=1; p.vx-=dx*w.recoil; p.vz-=dz*w.recoil;
    // muzzle
    const ml=muzzleLights[p.slot]; ml.position.set(mx,my+0.2,mz); ml.intensity= w.id==='rail'? 40 : w.id==='shotgun'? 32 : 16;
    if(w.id==='rail') ml.color.set('#8FC8FF'); else ml.color.set('#FFC56B');
    const n= w.id==='shotgun'?14 : w.id==='rail'?10 : 6;
    for(let i=0;i<n;i++){ const a=p.aim+rand(-0.5,0.5), s=rand(2,9); if(w.id==='rail') spawnPart(mx,my,mz,Math.sin(a)*s,rand(-1,2),Math.cos(a)*s,rand(0.05,0.12),1.5,3,7,rand(0.06,0.16),0,6,0.02); else spawnPart(mx,my,mz,Math.sin(a)*s,rand(-1,2),Math.cos(a)*s,rand(0.05,0.12),7,4.5,1.6,rand(0.04,0.1),0,8,0.015); }
    // shell casing
    if(w.id!=='rail') spawnGib(p.x+px*0.2,0.7,p.z+pz*0.2, px*rand(2,3.5)-dx*0.5, rand(3,5), pz*rand(2,3.5)-dz*0.5, w.id==='shotgun'?0.1:0.06, w.id==='shotgun'?'#C8283A':'#E3B04B', rand(2,3.5));
    shake=Math.min(1,shake+w.shake);
    sfx(w.sfx);
  }
  function hitscan(p, ox, oz, dx, dz, w){
    const maxD=40; const wallT=rayWall(ox,oz,dx,dz,maxD);
    const hits=[];
    for(const e of enemies){ if(e.spawnT>0.35) continue; const t=rayCircle(ox,oz,dx,dz,e.x,e.z,e.r*1.15); if(t!==null && t<wallT) hits.push({t,e}); }
    for(const b of barrels){ const t=rayCircle(ox,oz,dx,dz,b.x,b.z,0.36); if(t!==null && t<wallT) hits.push({t,b}); }
    hits.sort((a,b)=>a.t-b.t);
    let endT=wallT; let hitWall=true;
    for(const h of hits){
      if(h.e){ damageEnemy(h.e,w.dmg,dx,dz,w.kb,p,'gun'); }
      else { h.b.hp-=w.dmg; h.b.flash=1; if(h.b.hp<=0 && h.b.fuse<0) h.b.fuse=0.02; }
      if(!w.pierce){ endT=h.t; hitWall=false; break; }
    }
    const ex=ox+dx*endT, ez=oz+dz*endT;
    addTracer(ox,0.66,oz,ex,0.66,ez, w.tracer===1);
    if(hitWall){
      for(let i=0;i<5;i++) spawnPart(ex-dx*0.05,0.66,ez-dz*0.05,-dx*rand(1,4)+rand(-2,2),rand(0,3),-dz*rand(1,4)+rand(-2,2),rand(0.04,0.08),5,3.5,1.5,rand(0.1,0.25),10,3,0.02);
      if(Math.random()<0.4) spawnGib(ex-dx*0.1,0.66,ez-dz*0.1,-dx*2+rand(-1,1),rand(1,3),-dz*2+rand(-1,1),0.05,'#B88A52',rand(2,4));
    }
    if(w.tracer===1){ for(let s=0;s<endT;s+=0.6) spawnPart(ox+dx*s,0.66,oz+dz*s,rand(-0.4,0.4),rand(0.2,1),rand(-0.4,0.4),rand(0.05,0.12),1.2,2.6,6,rand(0.3,0.6),0,1); }
  }
  function rayCircle(ox,oz,dx,dz,cx,cz,r){
    const fx=ox-cx, fz=oz-cz; const b=fx*dx+fz*dz, c=fx*fx+fz*fz-r*r; const disc=b*b-c; if(disc<0) return null; const s=Math.sqrt(disc); let t=-b-s; if(t<0) t=-b+s; if(t<0) return null; return t;
  }

  // ---------------- input: keyboard / mouse / gamepad ----------------
  const keys={}; let mouseX=innerWidth/2, mouseY=innerHeight/2, mouseDown=false, mouseActive=false;
  function hostKey(e,down){
    if(!started || !running) return;
    if(e.target && e.target.tagName==='INPUT') return;
    keys[e.code]=down;
    if(!down) return;
    if(e.code==='Enter'||e.code==='NumpadEnter'){
      auInit();
      if(!kbPlayer){ kbPlayer=addPlayer('kbd','Clavier','kbd'); }
      else if(phase!=='play') startGame();
    }
    if(e.code==='KeyM') setMuted(!AU.muted);
    if(!kbPlayer) return;
    if(e.code==='KeyE' || e.code==='Tab'){ e.preventDefault(); cycleWeapon(kbPlayer,1); }
    if(e.code==='KeyQ'){ cycleWeapon(kbPlayer,-1); }
    if(/^Digit[1-6]$/.test(e.code)){ const w=+e.code.slice(5)-1; if(unlocked(w)&&hasAmmo(kbPlayer,w)){ kbPlayer.weapon=w; sfx('click'); renderCards(); } }
  }
  addEventListener('keydown',e=>{ hostKey(e,true); if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab'].includes(e.code) && started && running) e.preventDefault(); });
  addEventListener('keyup',e=>hostKey(e,false));
  function kbInput(p){
    const i=p.input; let mx=0,my=0;
    // physical keys: KeyW/KeyA/KeyS/KeyD = ZQSD on AZERTY
    if(keys.KeyW) my-=1; if(keys.KeyS) my+=1; if(keys.KeyA) mx-=1; if(keys.KeyD) mx+=1;
    const l=Math.hypot(mx,my)||1; i.mx=mx/l; i.my=my/l;
    let ax=0, ay=0;
    if(keys.ArrowUp) ay-=1; if(keys.ArrowDown) ay+=1; if(keys.ArrowLeft) ax-=1; if(keys.ArrowRight) ax+=1;
    if(ax||ay){ const L=Math.hypot(ax,ay); i.ax=ax/L; i.ay=ay/L; i.fire=true; i.mag=1; mouseActive=false; return; }
    if(mouseActive){
      const ndc=new THREE.Vector2(mouseX/innerWidth*2-1, -(mouseY/innerHeight)*2+1);
      raycaster.setFromCamera(ndc,camera); const hit=raycaster.ray.intersectPlane(aimPlane, tmpV);
      if(hit){ const dx=hit.x-p.x, dz=hit.z-p.z, L=Math.hypot(dx,dz)||1; i.ax=dx/L; i.ay=dz/L; i.mag=clamp(L/8,0.35,1); }
      i.fire=mouseDown || !!keys.Space;
    } else { i.ax=0; i.ay=0; i.fire=!!keys.Space; }
  }
  function onMouseMove(e){ mouseX=e.clientX; mouseY=e.clientY; mouseActive=true; }
  function pollGamepads(){
    const gps=navigator.getGamepads?navigator.getGamepads():[];
    for(const gp of gps){
      if(!gp) continue; const key='gp'+gp.index; let p=gpPlayers[key];
      const btn=i=>gp.buttons[i]&&gp.buttons[i].pressed;
      if(!p){ if(btn(0)||btn(9)){ auInit(); p=addPlayer(key,'Manette '+(gp.index+1),'gp'); if(p){ gpPlayers[key]=p; p.gpPrev={}; } } continue; }
      const dz=v=>Math.abs(v)<0.18?0:v;
      p.input.mx=dz(gp.axes[0]||0); p.input.my=dz(gp.axes[1]||0);
      const ax=dz(gp.axes[2]||0), ay=dz(gp.axes[3]||0), m=Math.hypot(ax,ay);
      p.input.ax=ax; p.input.ay=ay; p.input.mag=m; p.input.fire = m>0.35 || btn(7);
      const prev=p.gpPrev;
      if(btn(5)&&!prev[5]) cycleWeapon(p,1); if(btn(4)&&!prev[4]) cycleWeapon(p,-1);
      if(btn(9)&&!prev[9] && phase!=='play') startGame();
      for(const i of [4,5,9]) prev[i]=btn(i);
    }
  }

  // ---------------- networking (phones) ----------------
  function joinUrl(){ const u=new URL(location.href); u.hash=''; u.search=''; u.searchParams.set('join',CODE); return u.toString(); }
  function initNet(){
    const ns=$('#netStatus');
    if(typeof Peer!=='function'){ ns.textContent='Module réseau indisponible : le clavier et les manettes fonctionnent quand même.'; ns.className='off'; return; }
    ns.textContent='Connexion au serveur…'; ns.className='';
    try{ peer=new Peer(PEER_PREFIX+CODE.toLowerCase(), {debug:0}); }
    catch(e){ ns.textContent='Impossible de démarrer le réseau ('+(e&&e.message||'erreur')+').'; ns.className='off'; return; }
    const me=peer;
    peer.on('open',()=>{ netTries=0; ns.textContent='Prêt : les téléphones peuvent rejoindre.'; ns.className='on'; $('#codeVal').textContent=CODE; drawQR(); });
    peer.on('connection',conn=>{
      conn.on('open',()=>{ if(pads.size>=8){ try{ conn.close(); }catch(e){} return; } pads.set(conn.peer,{conn,data:null,t:performance.now()}); });
      conn.on('data',d=>{ const e=pads.get(conn.peer); if(!e||!d||typeof d!=='object'||d.t!=='in') return; e.data=d; e.t=performance.now(); });
      const gone=()=>{ const e=pads.get(conn.peer); if(e && e.conn===conn) pads.delete(conn.peer); };
      conn.on('close',gone); conn.on('error',gone);
    });
    peer.on('disconnected',()=>{ if(peer!==me || me.destroyed) return; ns.textContent='Reconnexion au serveur…'; ns.className=''; setTimeout(()=>{ try{ if(!me.destroyed) me.reconnect(); }catch(e){} },1200); });
    peer.on('error',err=>{
      if(peer!==me) return;
      const t=err&&err.type;
      if(t==='unavailable-id' && netTries<6){ netTries++; me.destroy(); CODE=makeCode(); $('#codeVal').textContent=CODE; initNet(); return; }
      if(t==='peer-unavailable') return;
      if(t==='network'||t==='server-error'||t==='socket-error'||t==='socket-closed'||t==='browser-incompatible'){ ns.textContent= t==='browser-incompatible' ? 'Ce navigateur ne gère pas WebRTC : utilisez Chrome, Firefox, Edge ou Safari récents.' : 'Serveur de connexion injoignable. Vérifiez le réseau puis rechargez la page.'; ns.className='off'; }
    });
  }
  function pollPads(){
    const now=performance.now();
    for(const [id,e] of pads){
      const ps=e.data; if(!ps) continue;
      const src='pad:'+id;
      let p=players.find(q=>q.src===src);
      if(!p){ if(players.length>=4) continue; p=addPlayer(src, safeName(ps.name)||null, 'pad'); if(!p) continue; p.lastSw=ps.sw|0; p.lastSt=ps.st|0; auInit(); }
      p.lastSeen=e.t;
      const nm=safeName(ps.name); if(nm && nm!==p.name){ p.name=nm; renderSlots(); renderCards(); }
      const i=p.input; const n=v=>clamp(Number(v)||0,-1,1);
      i.mx=n(ps.mx); i.my=n(ps.my); i.ax=n(ps.ax); i.ay=n(ps.ay); i.mag=Math.hypot(i.ax,i.ay); i.fire=!!ps.f && i.mag>0.2;
      if((ps.sw|0)!==p.lastSw){ p.lastSw=ps.sw|0; cycleWeapon(p,1); }
      if((ps.st|0)!==p.lastSt){ p.lastSt=ps.st|0; if(phase!=='play') startGame(); }
    }
    for(const p of players.slice()){
      if(p.kind!=='pad') continue;
      const id=p.src.slice(4);
      if(!pads.has(id) ? now-p.lastSeen>1200 : now-p.lastSeen>4000) removePlayer(p);
    }
  }
  function broadcast(){
    if(!pads.size) return;
    const pl={};
    for(const p of players){ if(p.kind!=='pad') continue; const a=p.ammo[p.weapon];
      pl[p.src.slice(4)]={s:p.slot, n:p.name, hp:Math.max(0,Math.ceil(p.hp)), w:p.weapon, a:(a===Infinity||phase!=='play')?-1:a, d:p.downed?1:0, sc:p.score, h:p.hitCount, k:p.killCount}; }
    const msg={t:'st', code:CODE, ph:phase, wv:wave, cb:combo, pl};
    for(const e of pads.values()){ if(e.conn && e.conn.open){ try{ e.conn.send(msg); }catch(err){} } }
  }

  // ---------------- game flow ----------------
  function clearWorld(){
    for(const e of enemies) disposeRig(e.rig); enemies.length=0;
    for(const b of barrels) scene.remove(b.mesh); barrels.length=0;
    for(const pr of projectiles) scene.remove(pr.mesh); projectiles.length=0;
    for(const pk of pickups) scene.remove(pk.mesh); pickups.length=0;
  }
  function startGame(){
    if(players.length===0) return;
    auInit();
    clearWorld(); clearDecals();
    phase='play'; wave=0; combo=0; comboT=0; bestCombo=0; teamScore=0; totalKills=0; pickupT=10;
    players.forEach((p,i)=>{ const sp=spawnPointForPlayer(p.slot); p.x=sp.x; p.z=sp.z; p.hp=p.maxHp; p.downed=false; p.weapon=0; p.ammo=WEAPONS.map(w=>w.start); p.score=0; p.kills=0; if(p.reviveRing) p.reviveRing.visible=false; spawnPuff(p.x,p.z,p.color); });
    $('#lobby').classList.add('hidden'); $('#brand').classList.add('hidden'); $('#over').classList.add('hidden'); $('#modeSwitchHost').classList.add('hidden');
    $('#hud').classList.remove('hidden'); document.body.classList.add('playing');
    MUS.intensity=1; timeScale=1;
    nextWave();
    renderCards();
  }
  function nextWave(){
    wave++; waveState='fight';
    const np=Math.max(1,players.length);
    toSpawn=Math.round((6+wave*5)*(1+0.4*(np-1)));
    spawnT=1.2;
    banner('Vague '+wave, wave===1?'Tenez la salle':waveFlavor());
    sfx('wave');
    const newW=WEAPONS.map((w,i)=>i).filter(i=>WEAPONS[i].unlock===wave && i>0);
    if(newW.length){
      setTimeout(()=>{ if(phase!=='play') return; banner(newW.map(i=>WEAPONS[i].name).join(' + '), 'Nouvelle arme débloquée'); sfx('unlock'); for(const p of players){ for(const i of newW) p.ammo[i]=WEAPONS[i].start; } renderCards(); }, 2300);
    }
    renderCards();
  }
  function waveFlavor(){ return ['Ils sont plus nombreux','Gardez le combo vivant','Les diables arrivent','Restez groupés','Ça sent le roussi','Pas de quartier'][wave%6]; }
  function waveComposition(){
    const r=Math.random();
    const devilP = wave>=3 ? Math.min(0.38,(wave-2)*0.07) : 0;
    if(wave>=5 && Math.random()< 0.04+Math.min(0.08,(wave-5)*0.015)) return 'brute';
    return r<devilP?'devil':'zombie';
  }
  function gameOver(){
    if(phase!=='play') return;
    phase='over'; slowT=1.6; sfx('over'); MUS.intensity=0.35;
    flashAmt=0.6; shake=1;
    setTimeout(()=>{
      if(phase!=='over') return;
      $('#overSub').textContent='Vague '+wave+' atteinte';
      $('#overStats').innerHTML='';
      [['Score',teamScore],['Éliminations',totalKills],['Meilleur combo','×'+bestCombo]].forEach(([k,v])=>{ const d=document.createElement('div'); const b=document.createElement('b'); b.textContent=v; const s=document.createElement('span'); s.textContent=k; d.append(b,s); $('#overStats').appendChild(d); });
      const ul=$('#overPlayers'); ul.innerHTML='';
      players.slice().sort((a,b)=>b.score-a.score).forEach(p=>{ const li=document.createElement('li'); li.style.setProperty('--c',p.color); const a=document.createElement('span'); a.textContent=p.name; const b=document.createElement('span'); b.textContent=p.score+' pts · '+p.kills+' kills'; li.append(a,b); ul.appendChild(li); });
      $('#over').classList.remove('hidden'); $('#hud').classList.add('hidden'); document.body.classList.remove('playing');
      $('#againBtn').focus();
    },1800);
  }
  function toLobby(){
    phase='lobby'; wave=0; clearWorld(); MUS.intensity=0.35; timeScale=1;
    for(const p of players){ p.hp=p.maxHp; p.downed=false; if(p.reviveRing) p.reviveRing.visible=false; }
    $('#over').classList.add('hidden'); $('#hud').classList.add('hidden'); $('#lobby').classList.remove('hidden'); $('#brand').classList.remove('hidden'); $('#modeSwitchHost').classList.remove('hidden'); document.body.classList.remove('playing');
    renderSlots();
  }
  let bannerTO=null;
  function banner(t,s){ const b=$('#banner'); b.querySelector('.t').textContent=t; b.querySelector('.s').textContent=s||''; b.classList.remove('show'); void b.offsetWidth; b.classList.add('show'); }

  // ---------------- UI ----------------
  function renderSlots(){
    const ul=$('#slots'); ul.innerHTML='';
    for(let s=0;s<4;s++){
      const p=players.find(q=>q.slot===s); const li=document.createElement('li'); li.style.setProperty('--c',SLOT_COLORS[s]);
      const dot=document.createElement('span'); dot.className='dot'; li.appendChild(dot);
      if(p){ const n=document.createElement('span'); n.textContent=p.name; const src=document.createElement('span'); src.className='src'; src.textContent= p.kind==='pad'?'téléphone':p.kind==='kbd'?'clavier':'manette'; li.append(n,src); }
      else { li.classList.add('empty'); li.append('Libre'); }
      ul.appendChild(li);
    }
    $('#startBtn').disabled=players.length===0;
  }
  let cardsSig='';
  function renderCards(){
    const c=$('#cards');
    const sig=players.map(p=>p.slot+p.name).join('|');
    if(sig!==cardsSig){ cardsSig=sig; c.innerHTML=''; for(const p of players){ const d=document.createElement('div'); d.className='card'; d.style.setProperty('--c',p.color); d.dataset.slot=p.slot;
      d.innerHTML='<div class="row"><span class="nm"></span><span class="sc"></span></div><div class="hp"><i></i></div><div class="row"><span class="wp"></span></div>'; d.querySelector('.nm').textContent=p.name; c.appendChild(d); } }
    for(const p of players){
      const d=c.querySelector('[data-slot="'+p.slot+'"]'); if(!d) continue;
      d.classList.toggle('down',p.downed);
      d.querySelector('.sc').textContent=p.score;
      d.querySelector('.hp i').style.width=(p.hp/p.maxHp*100)+'%';
      const a=p.ammo[p.weapon];
      d.querySelector('.wp').textContent= p.downed ? 'À terre : venez le relever' : WEAPONS[p.weapon].name+'  '+((a===Infinity||phase!=='play')?'∞':a);
    }
  }
  function drawQR(){
    const cv=$('#qr'), x=cv.getContext('2d'); const S=cv.width;
    x.fillStyle='#F8F1E4'; x.fillRect(0,0,S,S);
    const url = /^https?:$/.test(location.protocol) ? joinUrl() : null;
    if(!url || typeof qrcode!=='function'){ x.fillStyle='#5E6A6C'; x.font='600 22px sans-serif'; x.textAlign='center'; x.fillText('Mettez le jeu', S/2, S/2-6); x.fillText('en ligne', S/2, S/2+22); return; }
    const qr=qrcode(0,'M'); qr.addData(url); qr.make();
    const n=qr.getModuleCount(), m=2, cell=S/(n+m*2);
    x.fillStyle='#1E2A2F';
    const finder=(r,c)=>(r<7&&c<7)||(r<7&&c>=n-7)||(r>=n-7&&c<7);
    for(let r=0;r<n;r++) for(let c=0;c<n;c++){ if(!qr.isDark(r,c)||finder(r,c)) continue; const px=(c+m)*cell, py=(r+m)*cell; rr(x,px+cell*0.08,py+cell*0.08,cell*0.84,cell*0.84,cell*0.3); x.fill(); }
    const drawFinder=(r,c,col)=>{ const px=(c+m)*cell, py=(r+m)*cell; x.fillStyle=col; rr(x,px,py,cell*7,cell*7,cell*2); x.fill(); x.fillStyle='#F8F1E4'; rr(x,px+cell,py+cell,cell*5,cell*5,cell*1.4); x.fill(); x.fillStyle=col; rr(x,px+cell*2,py+cell*2,cell*3,cell*3,cell*0.9); x.fill(); };
    drawFinder(0,0,'#E8582F'); drawFinder(0,n-7,'#1E2A2F'); drawFinder(n-7,0,'#1E2A2F');
  }
  function rr(x,X,Y,W,H,R){ x.beginPath(); x.moveTo(X+R,Y); x.arcTo(X+W,Y,X+W,Y+H,R); x.arcTo(X+W,Y+H,X,Y+H,R); x.arcTo(X,Y+H,X,Y,R); x.arcTo(X,Y,X+W,Y,R); x.closePath(); }

  // ---------------- update ----------------
  function angleLerp(a,b,t){ let d=((b-a+Math.PI)%TAU+TAU)%TAU-Math.PI; return a+d*t; }
  function updatePlayers(dt){
    for(const p of players){
      if(p.kind==='kbd') kbInput(p);
      const i=p.input;
      p.inv=Math.max(0,p.inv-dt); p.kick=Math.max(0,p.kick-dt*8); p.squash=Math.max(0,p.squash-dt*6);
      if(p.flash>0){ p.flash-=dt; setFlash(p.rig,true); } else setFlash(p.rig,false);
      if(p.downed){
        p.vx*=0.8; p.vz*=0.8;
        // revive
        const helper=players.find(q=>q!==p && !q.downed && Math.hypot(q.x-p.x,q.z-p.z)<1.7);
        if(helper){ p.revive+=dt; if(Math.random()<0.4) spawnPart(p.x+rand(-0.5,0.5),0.1,p.z+rand(-0.5,0.5),0,rand(1,3),0,0.07,0.6,4,1.8,0.5,0,1); }
        else p.revive=Math.max(0,p.revive-dt*0.5);
        if(p.revive>=2.4){ p.downed=false; p.hp=45; p.inv=1.5; p.revive=0; p.reviveRing.visible=false; sfx('revive'); spawnPuff(p.x,p.z,'#3DDC97'); floatText(p.x,1.8,p.z,'Relevé !','heal',1.2); renderCards(); }
        if(p.reviveRing){ p.reviveRing.position.set(p.x,0.04,p.z); const s=1.7*(0.3+0.7*(p.revive/2.4)); p.reviveRing.scale.setScalar(s); }
      } else {
        let mx=i.mx, my=i.my; const ml=Math.hypot(mx,my); if(ml>1){ mx/=ml; my/=ml; }
        const spd=4.4;
        p.vx=lerp(p.vx, mx*spd, Math.min(1,dt*14)); p.vz=lerp(p.vz, my*spd, Math.min(1,dt*14));
        const am=Math.hypot(i.ax||0,i.ay||0);
        if(am>0.2){ p.aim=Math.atan2(i.ax,i.ay); p.aimMag=i.mag||am; }
        else if(ml>0.2){ p.aim=Math.atan2(mx,my); }
        playerFire(p,dt);
      }
      p.kx*=Math.max(0,1-dt*8); p.kz*=Math.max(0,1-dt*8);
      p.x+=(p.vx+p.kx)*dt; p.z+=(p.vz+p.kz)*dt;
      collideWalls(p,0.32);
      for(const b of barrels){ const dx=p.x-b.x, dz=p.z-b.z, d=Math.hypot(dx,dz); if(d<0.62&&d>0.001){ p.x=b.x+dx/d*0.62; p.z=b.z+dz/d*0.62; } }
      for(const q of players){ if(q===p) continue; const dx=p.x-q.x, dz=p.z-q.z, d=Math.hypot(dx,dz); if(d<0.6&&d>0.001){ const push=(0.6-d)*0.5; p.x+=dx/d*push; p.z+=dz/d*push; } }
      // pickups
      for(const pk of pickups.slice()){
        if(p.downed) break;
        if(Math.hypot(pk.x-p.x,pk.z-p.z)<0.8){
          if(pk.type==='hp'){ if(p.hp>=p.maxHp) continue; p.hp=Math.min(p.maxHp,p.hp+40); floatText(p.x,1.8,p.z,'+40 PV','heal',1); }
          else { WEAPONS.forEach((w,k)=>{ if(w.max!==Infinity && unlocked(k)) p.ammo[k]=Math.min(w.max, p.ammo[k]+Math.ceil(w.max*0.5)); }); floatText(p.x,1.8,p.z,'Munitions','score',1); }
          scene.remove(pk.mesh); pickups.splice(pickups.indexOf(pk),1); sfx('pickup');
          for(let k=0;k<16;k++){ const a=rand(0,TAU); spawnPart(pk.x,0.5,pk.z,Math.cos(a)*3,rand(1,4),Math.sin(a)*3,0.08, pk.type==='hp'?0.5:5, pk.type==='hp'?4:3, pk.type==='hp'?2:0.6, 0.5, 4, 3); }
          renderCards();
        }
      }
      // visuals
      const r=p.rig; r.root.position.set(p.x,0,p.z);
      const targetFace = p.downed ? p.face : p.aim;
      p.face=angleLerp(p.face, targetFace, Math.min(1,dt*18)); r.root.rotation.y=p.face;
      const sp=Math.hypot(p.vx,p.vz);
      p.walkT+=dt*sp*3.2;
      const sw=Math.sin(p.walkT)*Math.min(1,sp/2)*0.7;
      r.legL.rotation.x=sw; r.legR.rotation.x=-sw;
      r.body.position.y=Math.abs(Math.cos(p.walkT))*0.05*Math.min(1,sp/2);
      if(r.gun) r.gun.position.z=0.42-p.kick*0.12;
      r.body.rotation.x = -p.kick*0.08;
      if(p.downed){ r.root.rotation.z=lerp(r.root.rotation.z,1.35,Math.min(1,dt*8)); r.root.position.y=0.15; }
      else r.root.rotation.z=lerp(r.root.rotation.z,0,Math.min(1,dt*10));
      const sq=p.squash; r.root.scale.set(1+sq*0.15,1-sq*0.2,1+sq*0.15);
      r.root.visible = !(p.inv>0 && !p.downed && Math.floor(simTime*20)%2===0 && p.flash<=0);
      p.ring.position.set(p.x,0.03,p.z); p.ring.visible=!p.downed;
    }
  }
  const fd={x:0,z:0};
  function updateEnemies(dt){
    for(let i=0;i<enemies.length;i++){
      const e=enemies[i];
      if(e.flash>0){ e.flash-=dt; setFlash(e.rig,true); } else setFlash(e.rig,false);
      e.squash=Math.max(0,e.squash-dt*7);
      if(e.spawnT>0){ e.spawnT-=dt; e.y=-1.4*(Math.max(0,e.spawnT)/0.7); if(Math.random()<0.5) spawnPart(e.x+rand(-0.3,0.3),0.05,e.z+rand(-0.3,0.3),rand(-1,1),rand(1,3),rand(-1,1),rand(0.05,0.1),2,0.35,0.2,0.4,8,1); }
      else {
        if(e.airborne){ e.vy-=22*dt; e.y+=e.vy*dt; if(e.y<=0){ e.y=0; e.vy=0; e.airborne=false; spawnSmoke(e.x,0.1,e.z,0,0.5,0,0.4,0.5,0.3); } }
        const np=nearestPlayer(e.x,e.z);
        let dx=0, dz=0;
        if(np){
          const tp=np.p;
          if(np.d<1.4 || (np.d<8 && rayWall(e.x,e.z,(tp.x-e.x)/np.d,(tp.z-e.z)/np.d,np.d)>=np.d-0.05)){ dx=(tp.x-e.x)/np.d; dz=(tp.z-e.z)/np.d; }
          else if(flowDir(e.x,e.z,fd)){ dx=fd.x; dz=fd.z; }
          else { dx=(tp.x-e.x)/np.d; dz=(tp.z-e.z)/np.d; }
          // attack
          e.atk-=dt;
          const reach=e.r+0.34+0.12;
          if(np.d<reach && e.atk<=0 && !e.airborne){ e.atk=0.95; e.lunge=1; hurtPlayer(tp,e.dmg,dx,dz); }
          if(e.type==='devil'){ e.shootCd-=dt; if(e.shootCd<=0 && np.d<11 && np.d>2.5 && rayWall(e.x,e.z,dx,dz,np.d)>=np.d-0.1){ shootFireball(e,tp); e.shootCd=rand(2.2,3.4); } }
        } else {
          // wander
          e.wander=(e.wander||rand(0,TAU))+rand(-1,1)*dt; dx=Math.sin(e.wander)*0.4; dz=Math.cos(e.wander)*0.4;
        }
        const stop = np && np.d<e.r+0.38 ? 0.15 : 1;
        e.vx=lerp(e.vx,dx*e.speed*stop,Math.min(1,dt*6)); e.vz=lerp(e.vz,dz*e.speed*stop,Math.min(1,dt*6));
        if(dx||dz) e.face=angleLerp(e.face,Math.atan2(dx,dz),Math.min(1,dt*8));
      }
      e.kx*=Math.max(0,1-dt*7); e.kz*=Math.max(0,1-dt*7);
      e.x+=(e.vx+e.kx)*dt; e.z+=(e.vz+e.kz)*dt;
    }
    // separation
    for(let i=0;i<enemies.length;i++){
      const a=enemies[i]; if(a.spawnT>0.3) continue;
      for(let j=i+1;j<enemies.length;j++){
        const b=enemies[j]; if(b.spawnT>0.3) continue; const dx=a.x-b.x, dz=a.z-b.z, rr2=a.r+b.r; const d2=dx*dx+dz*dz; if(d2>=rr2*rr2||d2<1e-6) continue;
        const d=Math.sqrt(d2), push=(rr2-d)*0.5, nx=dx/d, nz=dz/d; const wa=b.r/(a.r+b.r), wb=a.r/(a.r+b.r);
        a.x+=nx*push*wa*1.6; a.z+=nz*push*wa*1.6; b.x-=nx*push*wb*1.6; b.z-=nz*push*wb*1.6;
      }
      for(const p of players){ if(p.downed) continue; const dx=a.x-p.x, dz=a.z-p.z, rr2=a.r+0.32, d=Math.hypot(dx,dz); if(d<rr2&&d>0.001){ a.x=p.x+dx/d*rr2; a.z=p.z+dz/d*rr2; } }
      for(const b of barrels){ const dx=a.x-b.x, dz=a.z-b.z, rr2=a.r+0.32, d=Math.hypot(dx,dz); if(d<rr2&&d>0.001){ a.x=b.x+dx/d*rr2; a.z=b.z+dz/d*rr2; } }
      collideWalls(a,a.r);
    }
    // visuals
    for(const e of enemies){
      const r=e.rig, S=e.scale; r.root.position.set(e.x,e.y,e.z); r.root.rotation.y=e.face;
      const sp=Math.hypot(e.vx,e.vz); e.walkT+=dt*sp*(e.type==='devil'?3.6:2.6);
      const sw=Math.sin(e.walkT)*Math.min(1,sp/1.2)*0.55;
      r.legL.rotation.x=sw; r.legR.rotation.x=-sw;
      e.lunge=Math.max(0,e.lunge-dt*4);
      if(e.type==='devil'){ r.armL.rotation.x=-sw*0.8-e.lunge*1.6; r.armR.rotation.x=sw*0.8-e.lunge*1.6; }
      else { r.armL.rotation.x=-0.15+Math.sin(e.walkT*0.5)*0.15-e.lunge*0.7; r.armR.rotation.x=-0.1-Math.sin(e.walkT*0.5)*0.15-e.lunge*0.7; }
      r.body.rotation.z=Math.sin(e.walkT*0.5)*0.08; r.body.rotation.x=0.12+e.lunge*0.4;
      const sq=e.squash; r.root.scale.set(S*(1+sq*0.2),S*(1-sq*0.22),S*(1+sq*0.2));
    }
  }
  function updateBarrels(dt){
    for(const b of barrels.slice()){
      b.pop=Math.min(1,b.pop+dt*6); const e=1+Math.sin(b.pop*Math.PI)*0.25*(1-b.pop);
      b.mesh.scale.set(lerp(1.3,1,b.pop)*e, lerp(0.3,1,b.pop), lerp(1.3,1,b.pop)*e);
      b.flash=Math.max(0,b.flash-dt*5);
      if(b.fuse>=0){ b.fuse-=dt; b.mesh.position.x=b.x+rand(-0.04,0.04); if(b.fuse<=0) explodeBarrel(b); }
    }
  }
  function updateProjectiles(dt){
    for(const pr of projectiles.slice()){
      if(pr.kind==='fire'){
        pr.life-=dt; pr.x+=pr.vx*dt; pr.z+=pr.vz*dt; pr.mesh.position.set(pr.x,pr.y,pr.z);
        pr.mesh.scale.setScalar(1+Math.sin(simTime*40)*0.15);
        spawnPart(pr.x,pr.y,pr.z,rand(-0.5,0.5),rand(0,1),rand(-0.5,0.5),rand(0.08,0.16),5,1.2,0.25,0.25,-1,2);
        let dead = pr.life<=0 || solid(toTx(pr.x),toTy(pr.z));
        for(const p of players){ if(!p.downed && Math.hypot(p.x-pr.x,p.z-pr.z)<0.45){ const L=Math.hypot(pr.vx,pr.vz)||1; hurtPlayer(p,13,pr.vx/L,pr.vz/L); dead=true; break; } }
        if(dead){ for(let i=0;i<14;i++){ const a=rand(0,TAU); spawnPart(pr.x,pr.y,pr.z,Math.cos(a)*rand(1,4),rand(0,3),Math.sin(a)*rand(1,4),rand(0.06,0.14),6,1.6,0.3,rand(0.2,0.4),6,3); } spawnSmoke(pr.x,pr.y,pr.z,0,0.6,0,0.35,0.6,0.2); scene.remove(pr.mesh); projectiles.splice(projectiles.indexOf(pr),1); }
      } else if(pr.kind==='grenade'){
        pr.fuse-=dt; pr.vy-=22*dt;
        const nx=pr.x+pr.vx*dt, nz=pr.z+pr.vz*dt;
        if(pr.y<1.4 && solid(toTx(nx),toTy(pr.z))){ pr.vx*=-0.5; sfx('bounce'); } else pr.x=nx;
        if(pr.y<1.4 && solid(toTx(pr.x),toTy(nz))){ pr.vz*=-0.5; sfx('bounce'); } else pr.z=nz;
        pr.y+=pr.vy*dt; if(pr.y<0.12){ pr.y=0.12; if(pr.vy<-2) sfx('bounce'); pr.vy*=-0.45; pr.vx*=0.65; pr.vz*=0.65; }
        pr.mesh.position.set(pr.x,pr.y,pr.z); pr.mesh.rotation.x+=pr.spin*dt; pr.mesh.rotation.z+=pr.spin*0.6*dt;
        if(Math.floor(pr.fuse*10)%3===0) spawnPart(pr.x,pr.y+0.15,pr.z,0,0.5,0,0.06,6,1,0.3,0.15,0,1);
        if(pr.fuse<=0){ scene.remove(pr.mesh); projectiles.splice(projectiles.indexOf(pr),1); explosion(pr.x,pr.z,3.3,190,pr.owner); }
      }
    }
  }
  function updatePickups(dt){
    for(const pk of pickups.slice()){
      pk.t+=dt; pk.life-=dt; pk.mesh.rotation.y+=dt*2; pk.mesh.position.y=0.45+Math.sin(pk.t*3)*0.1;
      if(pk.t<0.3) pk.mesh.scale.setScalar(pk.t/0.3*1.2); else pk.mesh.scale.setScalar(1);
      if(pk.life<3) pk.mesh.visible=Math.floor(pk.life*8)%2===0;
      if(pk.life<=0){ scene.remove(pk.mesh); pickups.splice(pickups.indexOf(pk),1); }
    }
  }
  function updateWaves(dt){
    if(phase==='lobby'){
      lobbySpawnT-=dt;
      if(lobbySpawnT<=0 && enemies.length<(players.length?7:5)){ lobbySpawnT=players.length?1.4:2.5; const d=DOORS[Math.floor(rand(0,DOORS.length))]; spawnEnemy(Math.random()<0.2?'devil':'zombie', tileX(d[0]), tileZ(d[1])); }
      return;
    }
    if(phase!=='play') return;
    if(waveState==='fight'){
      if(toSpawn>0){
        spawnT-=dt;
        const cap=40+players.length*8;
        if(spawnT<=0 && enemies.length<cap){
          const burst=Math.min(toSpawn, wave>=4 && Math.random()<0.3 ? 3 : 1);
          for(let k=0;k<burst;k++){ const d=DOORS[Math.floor(rand(0,DOORS.length))]; spawnEnemy(waveComposition(), tileX(d[0]), tileZ(d[1])); toSpawn--; }
          spawnT=Math.max(0.22, 1.15-wave*0.07)*rand(0.7,1.3)/Math.sqrt(Math.max(1,players.length));
        }
      } else if(enemies.length===0){
        waveState='break'; waveT=4.2; banner('Vague nettoyée','+'+(wave*50)+' points d\'équipe'); teamScore+=wave*50; sfx('unlock');
        for(const p of players){ if(p.downed){ p.downed=false; p.hp=40; if(p.reviveRing) p.reviveRing.visible=false; spawnPuff(p.x,p.z,'#3DDC97'); } }
        renderCards();
      }
    } else { waveT-=dt; if(waveT<=0) nextWave(); }
    pickupT-=dt; if(pickupT<=0){ pickupT=rand(9,14); const t=randomFreeTile(3); if(t) spawnPickup(t.x,t.z, Math.random()<0.6?'ammo':'hp'); }
  }
  function updateCamera(dt, realDt){
    let tx=0, tz=0, n=0, minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9;
    for(const p of players){ tx+=p.x+Math.sin(p.aim)*0.8; tz+=p.z+Math.cos(p.aim)*0.8; n++; minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minZ=Math.min(minZ,p.z); maxZ=Math.max(maxZ,p.z); }
    let dist, pitch=0.98;
    if(phase==='lobby'){
      camYaw+=realDt*0.06;
      const cx = n? tx/n*0.5 : 0, cz = n? tz/n*0.5 : 0;
      camTarget.lerp(tmpV.set(cx,0,cz), Math.min(1,realDt*2));
      dist = n? 30 : 34;
      const yaw=Math.sin(camYaw)*0.35;
      camDist=lerp(camDist,dist,Math.min(1,realDt*2));
      camera.position.set(camTarget.x+Math.sin(yaw)*Math.cos(pitch)*camDist, Math.sin(pitch)*camDist, camTarget.z+Math.cos(yaw)*Math.cos(pitch)*camDist);
    } else {
      if(n){ tx/=n; tz/=n; } const spread=n? Math.max(maxX-minX,(maxZ-minZ)*1.5) : 0;
      dist=clamp(17+spread*0.95,17,36);
      tx=clamp(tx,-9,9); tz=clamp(tz,-6.5,6.5);
      camTarget.lerp(tmpV.set(tx,0,tz), Math.min(1,realDt*3.5));
      camDist=lerp(camDist,dist,Math.min(1,realDt*2));
      camera.position.set(camTarget.x, Math.sin(pitch)*camDist, camTarget.z+Math.cos(pitch)*camDist);
    }
    camera.lookAt(camTarget);
    // shake
    const tr=shake*shake;
    if(tr>0.0001){ const t=performance.now()/1000; camera.position.x+=(Math.sin(t*61)+Math.sin(t*23.7))*0.35*tr; camera.position.y+=(Math.sin(t*53)+Math.sin(t*31.1))*0.25*tr; camera.rotateZ((Math.sin(t*47))*0.035*tr); }
    shake=Math.max(0,shake-realDt*1.6);
  }

  // ---------------- main loop ----------------
  function frame(now){
    if(!running){ return; }
    requestAnimationFrame(frame);
    const now0=performance.now();
    const realDt=Math.min(0.05,(now-(lastTime||now))/1000); lastTime=now;
    pollGamepads(); pollPads();
    let dt=realDt;
    if(freeze>0){ freeze-=realDt; dt=0; }
    if(slowT>0){ slowT-=realDt; dt*=0.25; }
    simTime+=dt;
    flowT-=dt; if(flowT<=0){ computeFlow(); flowT=0.2; }
    if(phase==='play' && comboT>0){ comboT-=dt; if(comboT<=0){ if(combo>=10){ sfx('comboEnd'); } combo=0; } }
    if(dt>0){
      updatePlayers(dt); updateEnemies(dt); updateBarrels(dt); updateProjectiles(dt); updatePickups(dt); updateWaves(dt);
      updateGibs(dt); updateParts(dt); updateSmoke(dt); updateTracers(dt); updateRings(dt);
      groanT-=dt; if(groanT<=0 && enemies.length){ groanT=rand(1.5,4); sfx('groan'); }
    }
    updateLights(realDt); updateFx(realDt);
    mats.portal.opacity=0.55+0.35*Math.sin(now/260);
    updateCamera(dt, realDt);
    // HUD
    if(phase==='play'){
      $('#waveLabel').textContent='Vague '+wave;
      $('#waveSub').textContent= waveState==='fight' ? ((toSpawn+enemies.length)+' ennemis restants') : 'Prochaine vague…';
      $('#scoreLabel').textContent=teamScore.toLocaleString('fr-FR');
      const cEl=$('#combo'); cEl.classList.toggle('on',combo>=2);
      if(combo>=2){ $('#comboNum').textContent='×'+combo; $('#comboTxt').textContent='combo · bonus ×'+(1+Math.floor(combo/5)*0.5).toFixed(1).replace('.0',''); $('#comboFill').style.transform='scaleX('+clamp(comboT/3,0,1)+')'; }
      cardsT-=realDt; if(cardsT<=0){ cardsT=0.12; renderCards(); }
      MUS.intensity = waveState==='fight' ? 1 : 0.55;
    }
    broadcastT-=realDt; if(broadcastT<=0){ broadcastT=0.08; broadcast(); }
    // post uniforms
    flashAmt=Math.max(0,flashAmt-realDt*4); damageAmt=Math.max(0,damageAmt-realDt*1.4); aberr=Math.max(0,aberr-realDt*2.5);
    const u=finalPass.uniforms; u.uTime.value=now/1000; u.uFlash.value=flashAmt; u.uDamage.value=damageAmt*0.8; u.uAberr.value=aberr+shake*0.3;
    const lowHp = players.length && players.some(p=>!p.downed && p.hp<30) ? (0.18+Math.sin(now/180)*0.08) : 0; u.uDamage.value=Math.max(u.uDamage.value, lowHp);
    const tR=performance.now(); if(!window.__bxNoRender) composer.render(realDt); const tE=performance.now();
    perf.js=perf.js*0.95+(tR-now0)*0.05; perf.gl=perf.gl*0.95+(tE-tR)*0.05;
  }
  const perf={js:0,gl:0};
  let cardsT=0;

  function start(){
    if(started){ running=true; $('#host').classList.remove('hidden'); lastTime=0; if(!peer) initNet(); requestAnimationFrame(frame); return; }
    started=true; running=true;
    $('#host').classList.remove('hidden');
    fxEl=$('#fx');
    initThree();
    $('#codeVal').textContent=CODE;
    drawQR(); renderSlots();
    camera.position.set(0,30,20); camera.lookAt(0,0,0);
    addEventListener('mousemove',onMouseMove);
    addEventListener('mousedown',e=>{ if(e.target.closest('button')) return; mouseDown=true; mouseActive=true; auInit(); });
    addEventListener('mouseup',()=>{ mouseDown=false; });
    addEventListener('wheel',e=>{ if(kbPlayer && phase==='play') cycleWeapon(kbPlayer, e.deltaY>0?1:-1); },{passive:true});
    addEventListener('blur',()=>{ for(const k in keys) keys[k]=false; mouseDown=false; });
    addEventListener('contextmenu',e=>e.preventDefault());
    $('#startBtn').addEventListener('click',()=>{ auInit(); startGame(); });
    $('#againBtn').addEventListener('click',()=>{ startGame(); });
    $('#lobbyBtn').addEventListener('click',()=>{ toLobby(); });
    $('#muteBtn').addEventListener('click',()=>{ auInit(); setMuted(!AU.muted); });
    $('#modeSwitchHost').addEventListener('click',()=>{ stop(); Pad.start(); });
    initNet();
    requestAnimationFrame(frame);
  }
  function stop(){ running=false; $('#host').classList.add('hidden'); if(peer){ try{ peer.destroy(); }catch(e){} peer=null; } pads.clear(); }
  // test hooks (harmless)
  window.__bx = { get state(){ return {phase, wave, players:players.length, enemies:enemies.length, combo, teamScore}; }, startGame, spawnEnemy:(t)=>{ const d=DOORS[0]; return !!spawnEnemy(t||'zombie',tileX(d[0]),tileZ(d[1])); }, explosion:(x,z)=>explosion(x||0,z||0,3.4,200,null), players, perf, skipTo:(n)=>{ for(const e of enemies.slice()) killEnemy(e,0,1,null,'gun'); wave=n-1; toSpawn=0; nextWave(); for(const p of players) p.ammo=WEAPONS.map(w=>w.max); }, cycle:(i,d)=>cycleWeapon(players[i],d||1) };
  return {start, stop};
})();

/* =====================================================================
   PAD (phone controller)
   ===================================================================== */
const Pad = (function(){
  let started=false, peer=null, conn=null, hostCode=null, myId=null, hostState=null, lastData=0, connecting=false;
  const st={mx:0,my:0,ax:0,ay:0,f:0,sw:0,st:0};
  let dirty=true, lastHit=null, lastKill=null, lastDown=0, lastWave=null;
  const sticks={};
  function vib(p){ try{ if(navigator.vibrate) navigator.vibrate(p); }catch(e){} }
  function name(){ return safeName($('#padName').value) || ''; }
  function setStatus(t,busy){ $('#padStatus').textContent=t; $('#padSpinner').classList.toggle('hidden',!busy); }

  function start(){
    $('#pad').classList.remove('hidden');
    if(started) return; started=true;
    $('#padName').value = lsGet('bx-name') || '';
    $('#padName').addEventListener('input',()=>{ lsSet('bx-name',$('#padName').value); dirty=true; });
    const codeEl=$('#padCode');
    codeEl.value=JOIN_PARAM;
    codeEl.addEventListener('input',()=>{ codeEl.value=codeEl.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4); });
    codeEl.addEventListener('keydown',e=>{ if(e.key==='Enter') join(codeEl.value); });
    $('#padJoinBtn').addEventListener('click',()=>join(codeEl.value));
    $('#modeSwitchPad').addEventListener('click',()=>{ $('#pad').classList.add('hidden'); Host.start(); });
    $('#padLeave').addEventListener('click',leave);
    $('#padWeapon').addEventListener('click',()=>{ st.sw++; dirty=true; vib(12); });
    $('#padStart').addEventListener('click',()=>{ st.st++; dirty=true; vib([20,40,20]); });
    setupStick('L', $('#zoneL'), $('#stickL'));
    setupStick('R', $('#zoneR'), $('#stickR'));
    if(typeof Peer!=='function'){ setStatus('Le module réseau n\'a pas pu se charger. Vérifie ta connexion puis recharge la page.'); return; }
    setStatus(JOIN_PARAM ? 'Partie '+JOIN_PARAM+' : choisis un pseudo et rejoins.' : 'Entre le code affiché sur l\'écran de jeu.');
    requestAnimationFrame(loop);
  }
  function ensurePeer(){
    return new Promise((res,rej)=>{
      if(peer && peer.open && !peer.disconnected) return res(peer);
      if(peer){ try{ peer.destroy(); }catch(e){} }
      const p=new Peer({debug:0}); peer=p;
      const to=setTimeout(()=>rej({type:'timeout-server'}),12000);
      p.once('open',id=>{ clearTimeout(to); myId=id; res(p); });
      p.once('error',e=>{ clearTimeout(to); rej(e); });
    });
  }
  async function join(code){
    code=String(code||'').toUpperCase();
    if(!/^[A-Z0-9]{4}$/.test(code)){ setStatus('Le code de la partie fait 4 caractères.'); $('#padCode').focus(); return; }
    if(connecting) return; connecting=true;
    vib(30);
    try{ const el=document.documentElement; if(el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(()=>{}); }catch(e){}
    try{ if(navigator.wakeLock) navigator.wakeLock.request('screen').catch(()=>{}); }catch(e){}
    setStatus('Connexion à la partie '+code+'…', true);
    try{
      await ensurePeer();
      const c=peer.connect(PEER_PREFIX+code.toLowerCase(), {serialization:'json', reliable:true});
      await new Promise((res,rej)=>{
        const to=setTimeout(()=>rej({type:'timeout'}),10000);
        c.on('open',()=>{ clearTimeout(to); res(); });
        c.on('error',e=>{ clearTimeout(to); rej(e); });
        peer.once('error',e=>{ clearTimeout(to); rej(e); });
      });
      conn=c; hostCode=code; hostState=null; prevState=null; lastData=performance.now(); dirty=true; lastHit=lastKill=lastWave=null;
      c.on('data',d=>{ if(d && typeof d==='object' && d.t==='st'){ hostState=d; lastData=performance.now(); } });
      c.on('close',()=>{ if(conn===c){ conn=null; backToJoin('La connexion avec l\'écran de jeu est coupée. Touche « Rejoindre » pour revenir.'); } });
      lsSet('bx-lastcode',code);
      $('#padJoin').classList.add('hidden'); $('#padCtl').classList.remove('hidden');
      $('#padMe').textContent=name()||'Toi'; $('#padMsg').textContent='Connexion à l\'écran…';
    }catch(e){
      const t=e&&e.type;
      setStatus(t==='peer-unavailable' ? 'Aucune partie ouverte avec le code '+code+'. Vérifie le code sur l\'écran de jeu.'
        : t==='timeout' ? 'L\'écran de jeu ne répond pas. Mets ton téléphone sur le même Wi-Fi que l\'écran et réessaie.'
        : t==='timeout-server'||t==='network'||t==='server-error'||t==='socket-error' ? 'Serveur de connexion injoignable. Vérifie ta connexion internet.'
        : 'Connexion impossible ('+(t||'erreur')+'). Réessaie.');
    }
    connecting=false;
  }
  function backToJoin(msg){
    $('#padCtl').classList.add('hidden'); $('#padJoin').classList.remove('hidden');
    if(hostCode) $('#padCode').value=hostCode;
    setStatus(msg||'Entre le code affiché sur l\'écran de jeu.');
  }
  function leave(){
    const c=conn; conn=null; if(c){ try{ c.close(); }catch(e){} }
    backToJoin('');
  }
  function setupStick(id, zone, el){
    const s={id:null, ox:0, oy:0, x:0, y:0}; sticks[id]=s; const R=58;
    zone.addEventListener('pointerdown',e=>{ if(s.id!==null) return; s.id=e.pointerId; zone.setPointerCapture(e.pointerId); s.ox=e.clientX; s.oy=e.clientY; el.style.left=s.ox+'px'; el.style.top=s.oy+'px'; el.classList.add('on'); move(e); vib(6); });
    const move=e=>{ if(e.pointerId!==s.id) return; let dx=e.clientX-s.ox, dy=e.clientY-s.oy; const d=Math.hypot(dx,dy);
      if(d>R*1.6){ s.ox+= dx/d*(d-R*1.6); s.oy+=dy/d*(d-R*1.6); el.style.left=s.ox+'px'; el.style.top=s.oy+'px'; dx=e.clientX-s.ox; dy=e.clientY-s.oy; }
      const dd=Math.hypot(dx,dy), k=dd>R?R/dd:1; s.x=dx*k/R; s.y=dy*k/R; el.firstElementChild.style.transform=`translate(${dx*k}px,${dy*k}px)`; apply(); };
    zone.addEventListener('pointermove',move);
    const end=e=>{ if(e.pointerId!==s.id) return; s.id=null; s.x=0; s.y=0; el.classList.remove('on'); el.firstElementChild.style.transform=''; apply(); };
    zone.addEventListener('pointerup',end); zone.addEventListener('pointercancel',end); zone.addEventListener('lostpointercapture',end);
  }
  function apply(){
    const L=sticks.L, R=sticks.R; const q=v=>Math.round(v*100)/100;
    const nm=q(L.x), ny=q(L.y), ax=q(R.x), ay=q(R.y), f=Math.hypot(R.x,R.y)>0.3?1:0;
    if(nm!==st.mx||ny!==st.my||ax!==st.ax||ay!==st.ay||f!==st.f){ st.mx=nm; st.my=ny; st.ax=ax; st.ay=ay; st.f=f; dirty=true; }
  }
  let lastSend=0, prevState=null;
  function loop(now){
    requestAnimationFrame(loop);
    if(!conn || !conn.open) return;
    if((dirty && now-lastSend>30) || now-lastSend>800){ dirty=false; lastSend=now; try{ conn.send({t:'in', name:name()||'', mx:st.mx, my:st.my, ax:st.ax, ay:st.ay, f:st.f, sw:st.sw, st:st.st}); }catch(e){} }
    if(performance.now()-lastData>4000){ $('#padMsg').textContent='L\'écran de jeu ne répond plus…'; }
    const hp=hostState; if(!hp || hp===prevState) return; prevState=hp;
    const my = hp.pl && myId ? hp.pl[myId] : null;
    const ph=hp.ph;
    $('#padStart').classList.toggle('hidden', !(ph==='lobby'||ph==='over') || !my);
    $('#padStart').textContent= ph==='over'?'Rejouer':'Lancer la partie';
    if(!my){ $('#padMsg').textContent='En attente d\'une place (4 joueurs max)…'; return; }
    const col=SLOT_COLORS[my.s|0]||SLOT_COLORS[0]; document.getElementById('pad').style.setProperty('--pc',col);
    $('#padMe').textContent=String(my.n||name()||'Toi').slice(0,12); $('#padScore').textContent=(my.sc|0)+' pts';
    $('#padHp i').style.width=clamp((my.hp|0),0,100)+'%';
    const w=WEAPONS[my.w|0]||WEAPONS[0];
    $('#padWeapon').firstChild.nodeValue=w.name;
    $('#padWeapon small').textContent=(my.a<0?'∞':my.a)+' · touche pour changer';
    $('#padCombo').textContent= (hp.cb|0)>=2 ? '×'+(hp.cb|0)+' combo' : '';
    $('#padMsg').textContent= ph==='lobby' ? 'Échauffement : tire sur tout ce qui bouge.' : ph==='over' ? 'Partie terminée. Vague '+(hp.wv|0)+'.' : 'Vague '+(hp.wv|0);
    $('#padDown').classList.toggle('hidden', !my.d);
    const h=my.h|0, k=my.k|0, wv=hp.wv|0;
    if(lastHit!==null && h>lastHit){ vib(70); const f=$('#padFlash'); f.style.transition='none'; f.style.opacity='.45'; requestAnimationFrame(()=>{ f.style.transition='opacity .35s'; f.style.opacity='0'; }); }
    lastHit=h;
    if(lastKill!==null && k>lastKill) vib(14); lastKill=k;
    if(my.d && !lastDown) vib([120,60,120,60,240]); lastDown=my.d;
    if(lastWave!==null && wv!==lastWave && ph==='play') vib([40,60,40]); lastWave=wv;
  }
  return {start};
})();

/* ---------------- boot ---------------- */
function boot(){
  if(MODE_START()==='pad') Pad.start(); else Host.start();
}
function MODE_START(){ if(JOIN_PARAM) return 'pad'; return hashMode==='pad'||hashMode==='host' ? hashMode : (coarse && Math.min(screen.width,screen.height)<820 ? 'pad' : 'host'); }
boot();
})();
