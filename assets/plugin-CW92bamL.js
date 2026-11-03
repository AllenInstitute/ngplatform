import{s as kt}from"./source_url-CkBYFb6f.js";import{P as Ye,s as Nt}from"./sources-B730UoAO.js";import{p as Dt,a as Lt,s as Ot,i as Ut,b as It,d as Pt}from"./solid-Dqy4dp1l.js";import{bK as $t,aQ as zt}from"./worker_factories-DxGj-Cqg.js";import{w as jt,d as Ke,c as Je}from"./manifest-fSIeO8k-.js";import{k as Vt,u as Xt,v as Wt,Z as Gt}from"./store-DZI71XW6.js";import{J as Ht}from"./jpg-DHI4uRBb.js";function Ze(a,t){const[e,s,o,i]=a,[n,r,c,l]=t;return[i*n+e*l+s*c-o*r,i*r-e*c+s*l+o*n,i*c+e*r-s*n+o*l,i*l-e*n-s*r-o*c]}function qt(a){return[-a[0],-a[1],-a[2],a[3]]}function wt(a){const t=Math.hypot(...a)||1;return[a[0]/t,a[1]/t,a[2]/t,a[3]/t]}function Yt(a){let[t,e,s,o]=wt(a);o<0&&([t,e,s,o]=[-t,-e,-s,-o]);const i=Math.hypot(t,e,s);if(i<1e-12)return[0,0,0];const n=2*Math.atan2(i,o);return[t/i*n,e/i*n,s/i*n]}function Kt(a){const t=Math.hypot(...a);if(t<1e-12)return[0,0,0,1];const e=Math.sin(t/2)/t;return[a[0]*e,a[1]*e,a[2]*e,Math.cos(t/2)]}function Jt(a,t){return a*Math.pow(.75,t/(1e3/60))}class Zt{constructor(t){this.ctx=t}on=!1;samples=[];dragging=!1;glide;offs=[];set(t){t!==this.on&&(this.on=t,t?this.listen():this.unlisten())}orientation(){const t=this.ctx.viewer.getState().projectionOrientation;return Array.isArray(t)&&t.length===4?t:[0,0,0,1]}in3d(t){const e=t.target;return this.ctx.viewer.panels().some(s=>s.kind==="3d"&&e!==null&&s.element.contains(e))}listen(){const t=o=>{this.stop(),this.in3d(o)&&(this.dragging=!0,this.samples=[])},e=()=>{this.dragging&&(this.dragging=!1,this.start())},s=()=>this.stop();window.addEventListener("pointerdown",t,!0),window.addEventListener("pointerup",e,!0),window.addEventListener("wheel",s,!0),window.addEventListener("keydown",s,!0),this.offs.push(()=>window.removeEventListener("pointerdown",t,!0),()=>window.removeEventListener("pointerup",e,!0),()=>window.removeEventListener("wheel",s,!0),()=>window.removeEventListener("keydown",s,!0),this.ctx.viewer.onStateChanged(()=>{if(!this.dragging)return;const o=this.orientation();if(o===void 0)return;const i=performance.now();for(this.samples.push({t:i,q:o});this.samples.length>2&&i-this.samples[0].t>100;)this.samples.shift()}))}unlisten(){this.stop(),this.offs.splice(0).forEach(t=>t())}start(){const t=this.samples;if(t.length<2)return;const e=t[0],s=t[t.length-1],o=performance.now()-s.t,i=s.t-e.t;if(i<8||o>60)return;const n=Yt(Ze(s.q,qt(e.q)));let r=[n[0]/i,n[1]/i,n[2]/i];if(Math.hypot(...r)<1e-5)return;let c=performance.now();const l=()=>{const h=performance.now(),u=Math.min(h-c,50);c=h;const d=this.orientation();if(d===void 0)return;const p=Kt([r[0]*u,r[1]*u,r[2]*u]),w=wt(Ze(p,d)),g=Jt(1,u);if(r=[r[0]*g,r[1]*g,r[2]*g],this.ctx.viewer.patchState(v=>{v.projectionOrientation=w},{quiet:!0}),Math.hypot(...r)<2e-5){this.glide=void 0;return}this.glide=requestAnimationFrame(l)};this.glide=requestAnimationFrame(l)}stop(){this.glide!==void 0&&cancelAnimationFrame(this.glide),this.glide=void 0}dispose(){this.unlisten()}}const G=2048,Y=8,we=8+Y;function se(a,t){const e=new Float64Array(16);for(let s=0;s<4;++s)for(let o=0;o<4;++o){let i=0;for(let n=0;n<4;++n)i+=a[4*n+o]*t[4*s+n];e[4*s+o]=i}return e}function oe(a,t){const e=[0,0,0,0];for(let s=0;s<4;++s)e[s]=a[s]*t[0]+a[4+s]*t[1]+a[8+s]*t[2]+a[12+s];return e}function xe(a){const t=a[0],e=a[4],s=a[8],o=a[1],i=a[5],n=a[9],r=a[2],c=a[6],l=a[10],h=i*l-n*c,u=-(o*l-n*r),d=o*c-i*r,p=t*h+e*u+s*d;if(!Number.isFinite(p)||Math.abs(p)<1e-300)return;const w=new Float64Array(16);w[0]=h/p,w[4]=-(e*l-s*c)/p,w[8]=(e*n-s*i)/p,w[1]=u/p,w[5]=(t*l-s*r)/p,w[9]=-(t*n-s*o)/p,w[2]=d/p,w[6]=-(t*c-e*r)/p,w[10]=(t*i-e*o)/p;for(let g=0;g<3;++g)w[12+g]=-(w[g]*a[12]+w[4+g]*a[13]+w[8+g]*a[14]);return w[15]=1,w}function je(a){const t=a.rank,e=t+1,s=Float64Array.from(a.matrix);for(let o=0;o<t;++o){const i=a.output.scales[o];for(let n=0;n<t;++n){const r=a.input.scales[n];r>0&&i>0&&(s[e*n+o]*=r/i)}}return s}function Qt(a,t){const e=a.rank,s=e+1,o=je(a),i=new Float64Array(16);i[15]=1;for(let n=0;n<3;++n){const r=a.output.names.indexOf(t[n]);if(r<0)return;for(let c=0;c<Math.min(3,e);++c)i[4*c+n]=o[s*c+r];i[12+n]=o[s*e+r]}return i}function es(a){const t=a.rank,e=t+1,s=a.output.names,o=je(a),i=["x","y","z"].every(r=>s.includes(r))?["x","y","z"].map(r=>s.indexOf(r)):[0,1,2],n=new Float32Array(9);for(let r=0;r<3;++r){const c=i[r];if(c>=t)continue;const l=a.output.scales[c]||1;for(let h=0;h<Math.min(3,t);++h)n[3*h+r]=o[e*h+c]*l}return n}function Me(a,t,e){return{from:[0,1,2].map(s=>Math.floor(a[s]/e[s])),to:[0,1,2].map(s=>Math.floor(t[s]/e[s]))}}function Qe(a,t=1e6){const e=[];for(let s=a.from[0];s<=a.to[0];++s)for(let o=a.from[1];o<=a.to[1];++o)for(let i=a.from[2];i<=a.to[2];++i)if(e.push([s,o,i]),e.length>=t)return e;return e}function he(a,t,e){const s=[];for(let o=0;o<8;++o)s.push(oe(a,[o&1?e[0]:t[0],o&2?e[1]:t[1],o&4?e[2]:t[2]]));for(let o=0;o<3;++o)if(s.every(i=>i[o]<-i[3])||s.every(i=>i[o]>i[3]))return!1;return!0}function et(a,t){return{lower:a.map((e,s)=>e*t[s]),upper:a.map((e,s)=>(e+1)*t[s])}}function ts(a,t){for(let e=0;e<a.length;++e){const{vertexCount:s,visible:o,total:i}=a[e];if(!(s===void 0||i===0)&&s*o/i<=t)return e}return a.length-1}function yt(a,t,e){const s=oe(a,t);if(!(s[3]>0))return 0;let o=0;for(let i=0;i<3;++i){const n=[t[0],t[1],t[2]];n[i]+=1;const r=oe(a,n);if(!(r[3]>0))continue;const c=(r[0]/r[3]-s[0]/s[3])*e[0]/2,l=(r[1]/r[3]-s[1]/s[3])*e[1]/2;o+=Math.hypot(c,l)}return o/3}function Et(a,t,e,s){let o=1/0,i=1/0,n=-1/0,r=-1/0;for(let h=0;h<8;++h){const u=oe(a,[h&1?e[0]:t[0],h&2?e[1]:t[1],h&4?e[2]:t[2]]);if(!(u[3]>0))return s[0]*s[1];const d=u[0]/u[3],p=u[1]/u[3];o=Math.min(o,d),n=Math.max(n,d),i=Math.min(i,p),r=Math.max(r,p)}const c=Math.max(0,Math.min(1,n)-Math.max(-1,o))/2,l=Math.max(0,Math.min(1,r)-Math.max(-1,i))/2;return Math.max(1,c*s[0]*l*s[1])}function ye(a,t,e,s,o=1,i=!1){let n=0;for(const r of a){const c=i?.5*(r.area??0)*t**2:0;n+=(r.length*t*e+r.pointCount*Math.PI*(1.5*e)**2+c)*(r.light??r.shown??1)}return s>0?n*o/s:0}function ss(a){const t=a,e=h=>[t[h],t[4+h],t[8+h],t[12+h]],[s,o,i]=[e(0),e(1),e(3)],n=s[0]*(o[1]*i[2]-o[2]*i[1])-s[1]*(o[0]*i[2]-o[2]*i[0])+s[2]*(o[0]*i[1]-o[1]*i[0]),r=(h,u)=>[h[1]*u[2]-h[2]*u[1],h[2]*u[0]-h[0]*u[2],h[0]*u[1]-h[1]*u[0]],c=Math.max(...s.slice(0,3).map(Math.abs),...o.slice(0,3).map(Math.abs),...i.slice(0,3).map(Math.abs),1e-30);if(Math.abs(n)>1e-9*c**3){const h=[-s[3],-o[3],-i[3]],u=p=>[s[p],o[p],i[p]],d=p=>{const w=[0,1,2].map(b=>b===p?h:u(b)),[g,v,f]=w;return(g[0]*(v[1]*f[2]-v[2]*f[1])-v[0]*(g[1]*f[2]-g[2]*f[1])+f[0]*(g[1]*v[2]-g[2]*v[1]))/n};return[d(0),d(1),d(2),1]}const l=r(s.slice(0,3),o.slice(0,3));return[l[0],l[1],l[2],0]}function xt(a){let t=0,e=0;for(const s of a){const o=s.length+s.pointCount+(s.area??0);t+=o,e+=o*(s.shown??1)}return t>0?e/t:1}const Tt=4;function Ce(a,t){return a*1e6/Math.max(1/Tt,Math.min(1,t))}function os(a){return 1/Math.max(1,a)}function At(a,t,e=1){const s=a(t);if(s===void 0)return;const o=[[],[],[]];for(let n=0;n<t.length;++n){const r=t.slice();r[n]+=e;const c=a(r);if(c===void 0)return;o[0].push((c.x-s.x)/e),o[1].push((c.y-s.y)/e),o[2].push((c.depth-s.depth)/e)}const i=[s.x,s.y,s.depth];for(let n=0;n<3;++n){let r=0;for(let c=0;c<t.length;++c)r+=o[n][c]*t[c];o[n].push(i[n]-r)}return o}function is(a,t,e){const s=a.rank,o=s+1,i=je(a),n=t.length,r=t.map(l=>a.output.names.indexOf(l)),c=new Float64Array(16);c[15]=1;for(let l=0;l<3;++l)for(let h=0;h<4;++h){if(h<3&&h>=s)continue;const u=h<3?h:s;let d=h===3?e[l][n]:0;for(let p=0;p<n;++p){const w=r[p];w>=0&&(d+=e[l][p]*i[o*u+w])}c[4*h+l]=d}return c}function ns(a,t){const e=a.names.length,s=new Float64Array(16);s[15]=1;for(let o=0;o<3;++o){let i=t[o][e];for(let n=0;n<e;++n){const r=["x","y","z"].indexOf(a.names[n]),c=(a.units[n]==="m"?.001:1)/a.scales[n];r===-1?i+=t[o][n]*a.position[n]:s[4*r+o]+=t[o][n]*c}s[12+o]=i}return s}function rs(a){const t=a[2],e=a[6],s=a[10],o=Math.hypot(t,e,s);if(o>0)return[t/o,e/o,s/o,a[14]/o]}const as=1e5,tt=2e3,me=256,st=4096,cs=512*1024*1024;function ls(a,t,e,s,o){const i=a.objectRead;if(i===void 0||t<=0)return;const n=i==="curves"&&!e.startsWith("attribute:")?"curves":"skeletons";if(t>(n==="curves"?as:tt))return;const r=Tt*s*1e6;for(let c=0;c<a.levels.length;++c){const l=a.levels[c],h=l.objectShare??(c===0?1:void 0);if(h===void 0||h<.999)continue;const u=l.objects??a.levels[0].objects;if(o?.level===c){if(t*o.perObject<=2*r)return{level:c,mode:n};continue}if(l.vertexCount===void 0||u===void 0){if(t<=tt)return{level:c,mode:n};continue}if(t*l.vertexCount/u<=r)return{level:c,mode:n}}}function hs(a,t,e){const s=[];for(let n=0;n<a.length;++n)t(a[n])||s.push(a[n]);s.sort((n,r)=>n<r?-1:n>r?1:0);const o=[];let i=0;for(e&&s.length>me&&(o.push(s.slice(0,me)),i=me);i<s.length;i+=st)o.push(s.slice(i,i+st));return o}function St(a,t,e){let s=0;for(const o of a){const i=o.pieces;if(i===void 0){s+=o.segmentCount;continue}for(let n=0;n+we<=i.length;n+=we)t([i[n+2],i[n+3],i[n+4]],[i[n+5],i[n+6],i[n+7]])&&(s+=i[n+1])}return s<=e?Y:Math.max(1,Math.min(Y,Math.floor(Y*e/s)))}const us=a=>a===null?0:a.vertices.byteLength+a.segments.byteLength+a.slots.byteLength+a.objectIds.byteLength+a.objectWeight.byteLength+(a.pieces?.byteLength??0);class ds{constructor(t,e=2,s=cs){this.send=t,this.inFlight=e,this.budget=s}plan;scalar="";setOf=new Map;absent=new Set;sets=new Map;asked=new Map;asking=new Set;queue=[];wanted=new BigUint64Array(0);drawnKeys=[];bytes=0;nextKey=0;verticesRead=0;objectsRead=0;generation=0;arrivals=0;error;want(t,e,s){e!==void 0&&(this.plan===void 0||e.level!==this.plan.level||e.mode!==this.plan.mode||s!==this.scalar)&&((this.plan!==void 0||this.sets.size>0)&&this.clear(),this.plan=e,this.scalar=s),this.wanted=t===void 0||e===void 0?new BigUint64Array(0):t;const o=i=>this.setOf.has(i)||this.absent.has(i)||this.asking.has(i);this.queue=hs(this.wanted,o,this.setOf.size===0&&this.asked.size===0),this.updateDrawn(),this.pump()}clear(){this.setOf.clear(),this.absent.clear(),this.sets.clear(),this.asked.clear(),this.asking.clear(),this.queue=[],this.drawnKeys=[],this.bytes=0,this.verticesRead=this.objectsRead=0,++this.generation}measured(){if(!(this.plan===void 0||this.objectsRead<me))return{level:this.plan.level,perObject:this.verticesRead/this.objectsRead}}pump(){for(;this.asked.size<this.inFlight&&this.queue.length>0&&this.plan!==void 0;){const t=this.queue.shift(),e=`o${this.nextKey++}`;this.asked.set(e,t);for(const s of t)this.asking.add(s);this.send(e,this.plan,BigUint64Array.from(t))}}arrived(t,e,s){const o=this.asked.get(t);if(o===void 0)return;this.asked.delete(t);for(const c of o)this.asking.delete(c);const i=new Set;for(let c=0;c<s.length;++c)i.add(s[c]);const n=[];for(const c of o)i.has(c)?(this.setOf.set(c,t),n.push(c)):this.absent.add(c);const r=us(e);this.sets.set(t,{chunk:e,ids:n,bytes:r}),this.bytes+=r,this.verticesRead+=e?.vertexCount??0,this.objectsRead+=n.length,this.updateDrawn(),this.evict(),++this.arrivals,this.pump()}failed(t,e){const s=this.asked.get(t);if(s!==void 0){this.asked.delete(t);for(const o of s)this.asking.delete(o);this.error=e,++this.arrivals,this.pump()}}updateDrawn(){const t=new Set;for(const e of this.wanted){const s=this.setOf.get(e);s!==void 0&&t.add(s)}this.drawnKeys=[...t]}evict(){if(this.bytes<=this.budget)return;const t=new Set(this.drawnKeys);for(const[e,s]of this.sets){if(this.bytes<=this.budget)break;if(!t.has(e)){this.sets.delete(e),this.bytes-=s.bytes;for(const o of s.ids)this.setOf.get(o)===e&&this.setOf.delete(o)}}}drawn(){return this.drawnKeys}get(t){return this.sets.get(t)?.chunk}has(t){return this.sets.has(t)}progress(){let t=0,e=0;for(const s of this.wanted)this.setOf.has(s)?++t:this.absent.has(s)&&++e;return{wanted:this.wanted.length,read:t,absent:e,pending:this.wanted.length-t-e}}get busy(){return this.asked.size>0||this.queue.length>0}get level(){return this.plan?.level}}const fs=384*1024*1024,Be=a=>a.vertices.byteLength+a.segments.byteLength+a.slots.byteLength+a.objectIds.byteLength+a.objectWeight.byteLength+a.triangles.byteLength+a.normals.byteLength;class ps{constructor(t){this.storeUrl=t,this.worker=new Worker(new URL(""+new URL("luxar_worker-C69fb__8.js",import.meta.url).href,import.meta.url),{type:"module",name:"luxar"});let e,s;this.ready=new Promise((o,i)=>{e=o,s=i}),this.ready.catch(()=>{}),this.worker.onmessage=o=>{const i=o.data;if(i.type==="opened"){this.info=i.info,e(i.info),this.send();return}if(i.type==="error"&&i.key===void 0){this.error=i.message,s(new Error(i.message)),this.onChunk?.();return}if(i.scalar===this.scalar){if(i.type==="objects"||i.type==="objectsError"){if(i.type==="objects"){const n=i.chunk;n?.valueRange!==void 0&&this.widenRange(n.valueRange),this.objects.arrived(i.key,n,i.found)}else this.objects.failed(i.key,i.message);this.onChunk?.();return}if(this.requested.delete(i.key),i.type==="chunk"){const n=i.chunk;this.store(i.key,n),n.valueRange!==void 0&&this.widenRange(n.valueRange)}else i.type==="empty"?this.store(i.key,null):i.type==="error"&&(this.failed.add(i.key),this.error=i.message);++this.arrivals,this.onChunk?.()}},this.worker.postMessage({type:"open",storeUrl:t}),this.objects=new ds((o,i,n)=>this.worker.postMessage({type:"objects",key:o,level:i.level,mode:i.mode,ids:n,scalar:this.scalar},[n.buffer]))}worker;ready;info;error;chunks=new Map;bytes=0;requested=new Set;failed=new Set;wants=new Map;sendQueued=!1;scalar="none";onChunk;valueRange;generation=0;arrivals=0;objects;widenRange([t,e]){this.valueRange=this.valueRange===void 0?[t,e]:[Math.min(this.valueRange[0],t),Math.max(this.valueRange[1],e)]}get scalarName(){return this.scalar}store(t,e){const s=this.chunks.get(t);s&&(this.bytes-=Be(s)),this.chunks.delete(t),this.chunks.set(t,e),e&&(this.bytes+=Be(e));for(const[o,i]of this.chunks){if(this.bytes<=fs)break;o===t||i===null||(this.bytes-=Be(i),this.chunks.delete(o))}}setScalar(t){t!==this.scalar&&(this.scalar=t,this.chunks.clear(),this.bytes=0,this.requested.clear(),this.failed.clear(),this.valueRange=void 0,++this.generation,this.objects.clear(),this.send())}get(t){return this.chunks.get(t)}has(t){return this.chunks.has(t)||this.failed.has(t)}want(t,e){const s=this.wants.get(t);s!==void 0&&s.length===e.length&&s.every((o,i)=>o===e[i])||(this.wants.set(t,e),!this.sendQueued&&(this.sendQueued=!0,queueMicrotask(()=>{this.sendQueued=!1,this.send()})))}send(){if(this.info===void 0)return;const t=[...this.wants.values()],e=[],s=new Set;for(let o=0;t.some(i=>o<i.length);++o)for(const i of t){const n=i[o];n===void 0||s.has(n)||(s.add(n),!(this.chunks.has(n)||this.failed.has(n))&&e.push(n))}this.requested=new Set(e),this.worker.postMessage({type:"want",keys:e,scalar:this.scalar})}get pending(){return this.requested.size}dispose(){this.worker.terminate(),this.chunks.clear(),this.onChunk=void 0}}function vs(a,t){return t===0?BigInt(a>>>0):BigInt(t>>>0)<<32n|BigInt(a>>>0)}function Rt(a){return!a.all||a.colour!==void 0}function ms(a,t){return a.all?1:a.has(t)?a.chosenAlpha??1:a.othersAlpha??0}function gs(a){return a>0?Math.max(1,Math.min(255,Math.round(a*255))):0}function bs(a,t,e){const s=a.length/2,o=Math.max(1,Math.ceil(s/G)),i=new Uint8Array(o*G*4);let n=0,r=0,c=0,l=!1;for(let u=0;u<s;++u){const d=vs(a[2*u],a[2*u+1]),p=gs(ms(e,d)),w=t[u]??0;if(n+=w,p===0)continue;r+=w,c+=w*p/255,l=!0,i[4*u+3]=p;const g=e.colour?.(d);if(g!==void 0)for(let v=0;v<3;++v)i[4*u+v]=Math.round(Math.min(1,Math.max(0,g[v]))*255);else i.fill(255,4*u,4*u+3)}const h=u=>n>0?u/n:l?1:0;return{table:i,rows:o,shown:h(r),light:h(c)}}const Ie={on:!0,blending:"glow",colourBy:"direction",colormap:"viridis",colour:"#ffb347",width:2,exposure:0,sharpness:.5,absorption:1,toneMap:"aces-hue",slab:4,detail:2,autoBrightness:!0,bloom:0},ws=["glow","glow-through","emission","solid"],ys=["direction","object","attribute","solid","segment"],_t=["viridis","magma","inferno","plasma","turbo","grey"],Es=["aces-hue","aces","reinhard","clamp"],xs=[["glow","Glow (additive, behind things in front)"],["glow-through","Glow through (additive, over everything)"],["emission","Emission and absorption"],["solid","Solid tubes"]],Ts=[["direction","Direction (x red, y green, z blue)"],["object","Each object its own colour"],["attribute","An attribute, through a colormap"],["solid","One colour"],["segment","The layer's segment colours"]],ot=_t.map(a=>[a,a==="grey"?"Grey":a[0].toUpperCase()+a.slice(1)]),it=[["aces-hue","ACES filmic, keeping colour"],["aces","ACES filmic (bright light turns white)"],["reinhard","Reinhard"],["clamp","None (clamp)"]],ne=(a,t,e,s)=>typeof a=="number"&&Number.isFinite(a)?Math.min(e,Math.max(t,a)):s,fe=(a,t,e)=>t.includes(a)?a:e;function Mt(a){const t=a??{},e=Ie,s=Array.isArray(t.range)&&t.range.length===2&&t.range.every(o=>typeof o=="number"&&Number.isFinite(o))?[t.range[0],t.range[1]]:void 0;return{on:t.on!==!1,blending:fe(t.blending,ws,e.blending),colourBy:fe(t.colourBy,ys,e.colourBy),attribute:typeof t.attribute=="string"?t.attribute:void 0,colormap:fe(t.colormap,_t,e.colormap),range:s,colour:typeof t.colour=="string"&&/^#[0-9a-f]{6}$/i.test(t.colour)?t.colour:e.colour,width:ne(t.width,.5,40,e.width),exposure:ne(t.exposure,-12,12,e.exposure),sharpness:ne(t.sharpness,0,1,e.sharpness),absorption:ne(t.absorption,0,20,e.absorption),toneMap:fe(t.toneMap,Es,e.toneMap),slab:ne(t.slab,.01,1e3,e.slab),detail:ne(t.detail,.1,50,e.detail),autoBrightness:t.autoBrightness!==!1,bloom:ne(t.bloom,0,3,e.bloom)}}function nt(a){const t=a??{},e={};if(t.layers!==null&&typeof t.layers=="object")for(const[s,o]of Object.entries(t.layers))e[s]=Mt(o);return{layers:e,momentum:t.momentum===!0}}function Ve(a){const t=parseInt(a.slice(1),16);return[(t>>16&255)/255,(t>>8&255)/255,(t&255)/255]}const Xe={viridis:0,magma:1,inferno:2,plasma:3,turbo:4,grey:5},We={aces:0,reinhard:1,clamp:2,"aces-hue":3},As={direction:0,object:1,attribute:2,solid:3,segment:4};function rt(a){return a.colourBy==="attribute"&&a.attribute!==void 0?`attribute:${a.attribute}`:"object"}const at=5e4,Fe=(a,t)=>`${a}|${t.join(".")}`;function Te(a,t,e,s,o){const{lower:i,upper:n}=a.bounds,r=a.levels.length-1,c=a.levels.map((v,f)=>{const b=Me(i,n,v.chunkShape);if([0,1,2].reduce((m,E)=>m*(b.to[E]-b.from[E]+1),1)>at&&f!==r)return;const x=v.chunkShape,S=Qe(b,at).filter(m=>{const E=et(m,x);return t(E.lower,E.upper)}),y=m=>m.reduce((E,A,R)=>E+((A+.5)*x[R]-e[R])**2,0);return S.sort((m,E)=>y(m)-y(E))}),l=a.levels.map(v=>{const f=Me(i,n,v.chunkShape);return[0,1,2].reduce((b,T)=>b*(f.to[T]-f.from[T]+1),1)}),h=ts(a.levels.map((v,f)=>({vertexCount:c[f]===void 0?void 0:v.vertexCount,visible:c[f]?.length??0,total:l[f]})),s),u=c[h]??[],d=[],p=c[r]??[];for(const v of p){const f=Fe(r,v);o(f)||d.push(f)}const w=new Set;let g=!0;for(const v of u){const f=Fe(h,v);if(o(f)){w.add(f);continue}g=!1,h!==r&&d.push(f);const b=et(v,a.levels[h].chunkShape);for(let T=h+1;T<=r;++T){const x=a.levels[T].chunkShape,S={lower:b.lower.map((m,E)=>m+1e-6*x[E]),upper:b.upper.map((m,E)=>m-1e-6*x[E])},y=Qe(Me(S.lower,S.upper,x),64).map(m=>Fe(T,m));if(y.every(o)){for(const m of y)w.add(m);break}}}return{level:h,draw:[...w],want:d,complete:g}}class Ee{constructor(t,e,s){this.renderer=t,this.client=e,this.budget=s}map=new Map;bytes=0;generation=-1;arrived(t){return this.check(),this.map.has(t)||this.client.has(t)}check(){this.generation!==this.client.generation&&(this.generation=this.client.generation,this.clear())}take(t,e,s=96*1024*1024){this.check();const o=[];let i=0,n=!1;for(const c of t){let l=this.map.get(c);if(l===void 0){const h=this.client.get(c);if(h===void 0)continue;if(h===null)l=null;else if(i>s){n=!0;continue}else l=this.renderer.upload(h),i+=l.bytes,this.bytes+=l.bytes}else this.map.delete(c);this.map.set(c,l),l&&(e!==void 0&&this.renderer.shade(l,e),o.push(l))}const r=new Set(t);for(const[c,l]of this.map){if(this.bytes<=this.budget)break;r.has(c)||(this.map.delete(c),l&&(this.renderer.release(l),this.bytes-=l.bytes))}return{chunks:o,more:n}}get gpuBytes(){return this.bytes}clear(){for(const t of this.map.values())t&&this.renderer.release(t);this.map.clear(),this.bytes=0}}const ct=1,ke=.5,Ss=3,Rs=2,Ne=6;function _s(a,t){const e=new Float32Array(t+1);let s=0;for(let o=0;o<=t;++o)e[o]=Math.exp(-(o*o)/(2*a*a)),s+=o===0?e[o]:2*e[o];for(let o=0;o<=t;++o)e[o]/=s;return e}const Ms=`
vec3 brightPass(vec3 c) {
  float x = max(c.r, max(c.g, c.b));
  if (x <= 0.0) return vec3(0.0);
  float soft = clamp(x - ${ct.toFixed(4)} + ${ke.toFixed(4)}, 0.0, ${(2*ke).toFixed(4)});
  float curve = soft * soft / ${(4*ke).toFixed(4)};
  return c * (max(curve, x - ${ct.toFixed(4)}) / x);
}`,De=`#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;function Cs(a){return`#version 300 es
precision highp float;
uniform highp sampler2D uSource;
uniform float uEmission;
out vec4 outColour;
${Ms}
// The light as the composite shows it: with emission, screened by its own absorption.
vec3 shownLight(vec4 v) {
  if (uEmission < 0.5) return max(v.rgb, vec3(0.0));
  float tau = max(v.a, 0.0);
  float screen = tau < 1e-3 ? 1.0 - 0.5 * tau : (1.0 - exp(-tau)) / tau;
  return max(v.rgb, vec3(0.0)) * screen;
}
void main() {
  ivec2 size = textureSize(uSource, 0);
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  vec3 sum = vec3(0.0);
  for (int dy = 0; dy < 2; ++dy) {
    for (int dx = 0; dx < 2; ++dx) {
      vec4 v = texelFetch(uSource, min(p + ivec2(dx, dy), size - 1), 0);
      sum += ${a?"brightPass(shownLight(v))":"max(v.rgb, vec3(0.0))"};
    }
  }
  outColour = vec4(sum * 0.25, 1.0);
}`}function lt(){const a=_s(Rs,Ne);return`#version 300 es
precision highp float;
uniform highp sampler2D uSource;
uniform ivec2 uStep;
out vec4 outColour;
const float W[${Ne+1}] = float[](${Array.from(a,t=>t.toFixed(8)).join(", ")});
void main() {
  ivec2 size = textureSize(uSource, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 sum = texelFetch(uSource, p, 0).rgb * W[0];
  for (int i = 1; i <= ${Ne}; ++i) {
    sum += texelFetch(uSource, clamp(p + uStep * i, ivec2(0), size - 1), 0).rgb * W[i];
    sum += texelFetch(uSource, clamp(p - uStep * i, ivec2(0), size - 1), 0).rgb * W[i];
  }
  outColour = vec4(sum, 1.0);
}`}class Ae{constructor(t,e){this.renderer=t,this.float=e}levels=[];size=[0,0];make(t,e){this.release();const{gl:s}=this.renderer;let o=t,i=e;for(let n=0;n<Ss;++n){o=Math.max(1,Math.ceil(o/2)),i=Math.max(1,Math.ceil(i/2));const r=[],c=[];for(let l=0;l<2;++l){const h=s.createTexture();s.bindTexture(s.TEXTURE_2D,h),this.float?s.texImage2D(s.TEXTURE_2D,0,s.RGBA16F,o,i,0,s.RGBA,s.HALF_FLOAT,null):s.texImage2D(s.TEXTURE_2D,0,s.RGBA8,o,i,0,s.RGBA,s.UNSIGNED_BYTE,null),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_S,s.CLAMP_TO_EDGE),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_T,s.CLAMP_TO_EDGE);const u=s.createFramebuffer();s.bindFramebuffer(s.FRAMEBUFFER,u),s.framebufferTexture2D(s.FRAMEBUFFER,s.COLOR_ATTACHMENT0,s.TEXTURE_2D,h,0),r.push(h),c.push(u)}this.levels.push({size:[o,i],textures:r,framebuffers:c})}s.bindTexture(s.TEXTURE_2D,null),this.size=[t,e]}run(t,e,s,o){const{renderer:i}=this,{gl:n}=i;(this.size[0]!==e||this.size[1]!==s||this.levels.length===0)&&this.make(e,s),n.disable(n.BLEND),n.disable(n.DEPTH_TEST),n.disable(n.STENCIL_TEST),n.disable(n.SCISSOR_TEST),n.depthMask(!1);let r=t;for(let c=0;c<this.levels.length;++c){const l=this.levels[c];if(n.bindFramebuffer(n.FRAMEBUFFER,l.framebuffers[0]),n.drawBuffers([n.COLOR_ATTACHMENT0]),n.checkFramebufferStatus(n.FRAMEBUFFER)!==n.FRAMEBUFFER_COMPLETE)return;n.viewport(0,0,l.size[0],l.size[1]),i.fullScreen(`bloom-down|${c===0}`,De,Cs(c===0),{uSource:r},{},{uEmission:o?1:0}),n.bindFramebuffer(n.FRAMEBUFFER,l.framebuffers[1]),n.drawBuffers([n.COLOR_ATTACHMENT0]),i.fullScreen("bloom-blur",De,lt(),{uSource:l.textures[0]},{uStep:[1,0]}),n.bindFramebuffer(n.FRAMEBUFFER,l.framebuffers[0]),i.fullScreen("bloom-blur",De,lt(),{uSource:l.textures[1]},{uStep:[0,1]}),r=l.textures[0]}return this.levels.map(c=>c.textures[0])}release(){const{gl:t}=this.renderer;for(const e of this.levels)e.textures.forEach(s=>t.deleteTexture(s)),e.framebuffers.forEach(s=>t.deleteFramebuffer(s));this.levels=[],this.size=[0,0]}}function Bs(a){return`#version 300 es
precision highp float;
precision highp int;
${a}
uniform highp sampler2D uNormals;
// The eye in store coordinates: a point (w = 1) or, for a view from far away, a direction (w = 0).
uniform vec4 uEye;
layout(location = 0) in uint aVertex;
out vec3 vColour;
out vec3 vNormal;
out vec3 vToEye;
out float vWeight;

void main() {
  vec4 object = objectAt(aVertex);
  vColour = vec3(0.0);
  vNormal = vec3(0.0, 0.0, 1.0);
  vToEye = vec3(0.0, 0.0, 1.0);
  // How strongly the object is drawn (the layer's notSelectedAlpha for one not chosen).
  vWeight = object.a;
  if (hidden(object)) {
    // A hidden object's triangles shrink to a point outside the view.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 v = vertexAt(aVertex);
  vec3 n = texelFetch(uNormals, ivec2(int(aVertex % ${G}u), int(aVertex / ${G}u)), 0).xyz;
  gl_Position = uModelToClip * vec4(v.xyz, 1.0);
  vNormal = n;
  vToEye = uEye.w > 0.5 ? uEye.xyz - v.xyz : uEye.xyz;
  vColour = colourAt(v, n, object.rgb);
}
`}function Fs(a,t){const e=[`layout(location = ${t.color}) out vec4 outColour;`];t.z!==void 0&&e.push(`layout(location = ${t.z}) out highp vec4 outZ;`),t.pick!==void 0&&e.push(`layout(location = ${t.pick}) out highp vec4 outPick;`);const s=`${t.z!==void 0?"outZ = vec4(1.0 - fragDepth);":""}${t.pick!==void 0?"outPick = vec4(0.0);":""}`,o={accumulate:`
      // Lit from the eye, with a rim where the surface turns away: a glowing shell.
      float light = 0.2 + 0.6 * facing + 0.6 * pow(1.0 - facing, 3.0);
      float fragDepth = gl_FragCoord.z;
      // Seen edge on, the path through the surface is longer: it absorbs more.
      outColour = vec4(vColour * (light * uGain), uAbsorption / max(facing, 0.2)) * vWeight;
      ${s}`,solid:`
      vec3 shaded = vColour * (0.25 + 0.75 * facing) + vec3(0.2) * pow(facing, 24.0);
      float fragDepth = gl_FragCoord.z;
      outColour = vec4(shaded, 1.0);
      ${s}`,depth:`
      // A faint surface does not keep what is behind it from showing.
      if (vWeight < 0.5) discard;
      float fragDepth = uDepthNear ? 0.0 : gl_FragCoord.z;
      gl_FragDepth = fragDepth;
      outColour = vec4(0.0);
      ${s}`}[a];return`#version 300 es
precision highp float;
uniform float uGain;
uniform float uAbsorption;
uniform bool uDepthNear;
in vec3 vColour;
in vec3 vNormal;
in vec3 vToEye;
in float vWeight;
${e.join(`
`)}

void main() {
  vec3 n = length(vNormal) > 0.0 ? normalize(vNormal) : vec3(0.0, 0.0, 1.0);
  vec3 e = length(vToEye) > 0.0 ? normalize(vToEye) : vec3(0.0, 0.0, 1.0);
  // Either side faces the light at the eye.
  float facing = abs(dot(n, e));
  ${o}
}
`}function ks(a){return`#version 300 es
precision highp float;
precision highp int;
${a}
layout(location = 0) in uvec3 aFace;
out vec3 vColour;
out float vAcross;
out float vSection;
out float vFade;

void hide() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vColour = vec3(0.0);
  vAcross = 0.0;
  vSection = 0.0;
  vFade = 0.0;
}

// Where the edge from a to b crosses the section, if it does.
bool crossing(vec4 a, vec4 b, float da, float db, out vec4 p) {
  if ((da < 0.0) == (db < 0.0) || da == db) return false;
  p = mix(a, b, da / (da - db));
  return true;
}

void main() {
  vec4 object = objectAt(aFace.x);
  if (hidden(object)) {
    hide();
    return;
  }
  vec4 A = vertexAt(aFace.x);
  vec4 B = vertexAt(aFace.y);
  vec4 C = vertexAt(aFace.z);
  float dA = sectionDistance(A.xyz);
  float dB = sectionDistance(B.xyz);
  float dC = sectionDistance(C.xyz);
  vec4 p0 = vec4(0.0);
  vec4 p1 = vec4(0.0);
  vec4 q;
  int k = 0;
  if (crossing(A, B, dA, dB, q)) { p0 = q; k = 1; }
  if (crossing(B, C, dB, dC, q)) { if (k == 0) p0 = q; else p1 = q; ++k; }
  if (k < 2 && crossing(C, A, dC, dA, q)) { if (k == 0) p0 = q; else p1 = q; ++k; }
  if (k < 2) {
    hide();
    return;
  }
  bool atEnd = gl_VertexID >= 2;
  float side = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  vec4 c0 = uModelToClip * vec4(p0.xyz, 1.0);
  vec4 c1 = uModelToClip * vec4(p1.xyz, 1.0);
  vec2 s0 = c0.xy / c0.w * 0.5 * uViewport;
  vec2 s1 = c1.xy / c1.w * 0.5 * uViewport;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float halfWidth = max(uHalfWidth, 0.75);
  vFade = uHalfWidth / halfWidth * object.a;
  vec4 c = atEnd ? c1 : c0;
  c.xy += normal * side * halfWidth / (0.5 * uViewport) * c.w;
  gl_Position = c;
  vAcross = side;
  vSection = 0.0;
  vColour = colourAt(atEnd ? p1 : p0, cross(B.xyz - A.xyz, C.xyz - A.xyz), object.rgb);
}
`}const Ct=`// Colormaps as polynomial fits (viridis, magma, inferno and plasma after
// Matt Zucker's fits of matplotlib's, CC0; turbo after Google's).
vec3 colormap(int which, float t) {
  t = clamp(t, 0.0, 1.0);
  if (which == 5) return vec3(t);
  if (which == 4) {
    const vec4 kr = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
    const vec4 kg = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
    const vec4 kb = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
    const vec2 kr2 = vec2(-152.94239396, 59.28637943);
    const vec2 kg2 = vec2(4.27729857, 2.82956604);
    const vec2 kb2 = vec2(-89.90310912, 27.34824973);
    vec4 v4 = vec4(1.0, t, t * t, t * t * t);
    vec2 v2 = v4.zw * v4.z;
    return clamp(vec3(dot(v4, kr) + dot(v2, kr2), dot(v4, kg) + dot(v2, kg2), dot(v4, kb) + dot(v2, kb2)), 0.0, 1.0);
  }
  vec3 c0, c1, c2, c3, c4, c5, c6;
  if (which == 0) {
    c0 = vec3(0.2777273272234177, 0.005407344544966578, 0.3340998053353061);
    c1 = vec3(0.1050930431085774, 1.404613529898575, 1.384590162594685);
    c2 = vec3(-0.3308618287255563, 0.214847559468213, 0.09509516302823659);
    c3 = vec3(-4.634230498983486, -5.799100973351585, -19.33244095627987);
    c4 = vec3(6.228269936347081, 14.17993336680509, 56.69055260068105);
    c5 = vec3(4.776384997670288, -13.74514537774601, -65.35303263337234);
    c6 = vec3(-5.435455855934631, 4.645852612178535, 26.3124352495832);
  } else if (which == 1) {
    c0 = vec3(-0.002136485053939582, -0.000749655052795221, -0.005386127855323933);
    c1 = vec3(0.2516605407371642, 0.6775232436837668, 2.494026599312351);
    c2 = vec3(8.353717279216625, -3.577719514958484, 0.3144679030132573);
    c3 = vec3(-27.66873308576866, 14.26473078096533, -13.64921318813922);
    c4 = vec3(52.17613981234068, -27.94360607168351, 12.94416944238394);
    c5 = vec3(-50.76852536473588, 29.04658282127291, 4.23415299384598);
    c6 = vec3(18.65570506591883, -11.48977351997711, -5.601961508734096);
  } else if (which == 2) {
    c0 = vec3(0.0002189403691192265, 0.001651004631001012, -0.01948089843709184);
    c1 = vec3(0.1065134194856116, 0.5639564367884091, 3.932712388889277);
    c2 = vec3(11.60249308247187, -3.972853965665698, -15.9423941062914);
    c3 = vec3(-41.70399613139459, 17.43639888205313, 44.35414519872813);
    c4 = vec3(77.162935699427, -33.40235894210092, -81.80730925738993);
    c5 = vec3(-71.31942824499214, 32.62606426397723, 73.20951985803202);
    c6 = vec3(25.13112622477341, -12.24266895238567, -23.07032500287172);
  } else {
    c0 = vec3(0.05873234392399702, 0.02333670892565664, 0.5433401826748754);
    c1 = vec3(2.176514634195958, 0.2383834171260182, 0.7539604599784036);
    c2 = vec3(-2.689460476458034, -7.455851135738909, 3.110799939717086);
    c3 = vec3(6.130348345893603, 42.3461881477227, -28.51885465332158);
    c4 = vec3(-11.10743619062271, -82.66631109428045, 60.13984767418263);
    c5 = vec3(10.02306557647065, 71.41361770095349, -54.07218655560067);
    c6 = vec3(-3.658713842777788, -22.93153465461149, 18.19190778539828);
  }
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), 0.0, 1.0);
}`,Se=`
uniform highp sampler2D uVertices;
uniform mat4 uModelToClip;
uniform mat3 uDirections;
uniform vec2 uViewport;
uniform float uHalfWidth;
uniform int uColourBy;
uniform vec3 uColour;
uniform int uColormap;
uniform vec2 uRange;
uniform vec4 uPlane;
uniform float uSlab;
uniform highp usampler2D uSlots;
uniform lowp sampler2D uObjects;
uniform bool uObjectTable;
// Drawn opaque (solid): an object drawn faintly (the layer's notSelectedAlpha) is left out.
uniform bool uOpaque;

vec4 vertexAt(uint i) {
  return texelFetch(uVertices, ivec2(int(i % ${G}u), int(i / ${G}u)), 0);
}

// Whether an object (its table entry, from objectAt) is not drawn: not shown, or faint and drawn opaque.
bool hidden(vec4 object) {
  return object.a < 0.5 / 255.0 || (uOpaque && object.a < 254.5 / 255.0);
}

// A vertex's object: its colour (as the layer colours segments) and how strongly it is drawn (alpha; 0 not at all).
vec4 objectAt(uint i) {
  if (!uObjectTable) return vec4(1.0);
  uint slot = texelFetch(uSlots, ivec2(int(i % ${G}u), int(i / ${G}u)), 0).r;
  return texelFetch(uObjects, ivec2(int(slot % ${G}u), int(slot / ${G}u)), 0);
}

${Ct}

vec3 hue(float h) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(1.0), k, 0.75);
}

// A vertex's colour: by the direction there, its object, its value, one colour, or its segment's colour.
vec3 colourAt(vec4 v, vec3 tangent, vec3 segment) {
  if (uColourBy == 0) {
    vec3 d = uDirections * tangent;
    float l = length(d);
    return l > 0.0 ? abs(d) / l : vec3(0.5);
  }
  if (uColourBy == 1) return hue(v.w);
  if (uColourBy == 2) return colormap(uColormap, (v.w - uRange.x) / max(uRange.y - uRange.x, 1e-12));
  if (uColourBy == 4) return segment;
  return uColour;
}

float sectionDistance(vec3 p) {
  return dot(uPlane.xyz, p) + uPlane.w;
}
`,Ns=Bs(Se),Ds=ks(Se),Ls=`#version 300 es
precision highp float;
precision highp int;
${Se}
layout(location = 0) in uvec4 aSegment;
out vec3 vColour;
out float vAcross;
out float vSection;
out float vFade;

const float NEAR_W = 1e-6;

vec2 pixels(vec4 clip) {
  return clip.xy / clip.w * 0.5 * uViewport;
}

void hide() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vColour = vec3(0.0);
  vAcross = 0.0;
  vSection = 0.0;
  vFade = 0.0;
}

void main() {
  bool atEnd = gl_VertexID >= 2;
  float side = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  vec4 P = vertexAt(aSegment.x);
  vec4 A = vertexAt(aSegment.y);
  vec4 B = vertexAt(aSegment.z);
  vec4 N = vertexAt(aSegment.w);
  bool joinA = aSegment.x != aSegment.y;
  bool joinB = aSegment.w != aSegment.z;
  vec4 object = objectAt(aSegment.y);
  if (hidden(object)) {
    hide();
    return;
  }

  float dA = sectionDistance(A.xyz);
  float dB = sectionDistance(B.xyz);
  if (uSlab > 0.0 && ((dA > uSlab && dB > uSlab) || (dA < -uSlab && dB < -uSlab))) {
    hide();
    return;
  }

  vec4 cA = uModelToClip * vec4(A.xyz, 1.0);
  vec4 cB = uModelToClip * vec4(B.xyz, 1.0);
  if (cA.w < NEAR_W && cB.w < NEAR_W) {
    hide();
    return;
  }
  // A segment crossing the camera's plane is cut there, and joins nothing at that end.
  if (cA.w < NEAR_W) {
    cA = mix(cA, cB, (NEAR_W - cA.w) / (cB.w - cA.w));
    joinA = false;
  }
  if (cB.w < NEAR_W) {
    cB = mix(cB, cA, (NEAR_W - cB.w) / (cA.w - cB.w));
    joinB = false;
  }
  vec4 cP = uModelToClip * vec4(P.xyz, 1.0);
  vec4 cN = uModelToClip * vec4(N.xyz, 1.0);
  if (cP.w < NEAR_W) joinA = false;
  if (cN.w < NEAR_W) joinB = false;

  vec2 sA = pixels(cA);
  vec2 sB = pixels(cB);
  vec2 d = sB - sA;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);

  // At a joint the corner goes to the mitre: where the two segments' edges
  // meet.  Both segments work it out from the same three points, so they
  // agree exactly.  Past a 120 degree turn the mitre would reach too far,
  // and both square off instead.
  vec2 offset = normal;
  bool join = atEnd ? joinB : joinA;
  if (join) {
    vec2 other = atEnd ? pixels(cN) - sB : sA - pixels(cP);
    float otherLen = length(other);
    if (otherLen > 1e-6 && len > 1e-6) {
      vec2 o = other / otherLen;
      vec2 otherNormal = vec2(-o.y, o.x);
      vec2 m = normal + otherNormal;
      float k = dot(m, normal);
      if (k > 0.5) offset = m / k;
    }
  }

  // Thinner than a pixel and a half, a line is drawn that wide and dimmer, so its light is kept.
  float halfWidth = max(uHalfWidth, 0.75);
  // A faint object (the layer's notSelectedAlpha) gives that share of the light.
  vFade = uHalfWidth / halfWidth * object.a;

  vec4 c = atEnd ? cB : cA;
  c.xy += offset * side * halfWidth / (0.5 * uViewport) * c.w;
  gl_Position = c;
  vAcross = side;
  vSection = atEnd ? dB : dA;
  vec3 tangent = atEnd ? (joinB ? N.xyz - A.xyz : B.xyz - A.xyz) : (joinA ? B.xyz - P.xyz : B.xyz - A.xyz);
  vColour = colourAt(atEnd ? B : A, tangent, object.rgb);
}
`,Os=`#version 300 es
precision highp float;
precision highp int;
${Se}
out vec3 vColour;
out vec2 vCorner;
out float vSection;
out float vFade;

void main() {
  vec4 v = vertexAt(uint(gl_InstanceID));
  vec2 corner = vec2((gl_VertexID & 1) == 0 ? -1.0 : 1.0, gl_VertexID >= 2 ? 1.0 : -1.0);
  float d = sectionDistance(v.xyz);
  vec4 c = uModelToClip * vec4(v.xyz, 1.0);
  vec4 object = objectAt(uint(gl_InstanceID));
  if ((uSlab > 0.0 && abs(d) > uSlab) || c.w < 1e-6 || hidden(object)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float radius = max(uHalfWidth, 0.75);
  vFade = (uHalfWidth / radius) * (uHalfWidth / radius) * object.a;
  c.xy += corner * radius / (0.5 * uViewport) * c.w;
  gl_Position = c;
  vCorner = corner;
  vSection = d;
  vColour = colourAt(v, vec3(0.0), object.rgb);
}
`;function Us(a,t,e){const s=[];s.push(`layout(location = ${e.color}) out vec4 outColour;`),e.z!==void 0&&s.push(`layout(location = ${e.z}) out highp vec4 outZ;`),e.pick!==void 0&&s.push(`layout(location = ${e.pick}) out highp vec4 outPick;`);const o=`${e.z!==void 0?"outZ = vec4(1.0 - fragDepth);":""}${e.pick!==void 0?"outPick = vec4(0.0);":""}`,i={accumulate:`
      float fragDepth = gl_FragCoord.z;
      outColour = vec4(vColour * (light * uGain), light * uAbsorption);
      ${o}`,solid:`
      // A tube's shading: lit from the viewer, with a small highlight.
      float nz = sqrt(max(1.0 - r * r, 0.0));
      vec3 shaded = vColour * (0.3 + 0.7 * nz) + vec3(0.25) * pow(nz, 24.0);
      float fragDepth = gl_FragCoord.z;
      outColour = vec4(shaded, 1.0);
      ${o}`,depth:`
      if (light < uDepthCut) discard;
      float fragDepth = uDepthNear ? 0.0 : gl_FragCoord.z;
      gl_FragDepth = fragDepth;
      outColour = vec4(0.0);
      ${o}`}[t];return`#version 300 es
precision highp float;
uniform float uSharpness;
uniform float uGain;
uniform float uAbsorption;
uniform float uSlab;
uniform float uDepthCut;
uniform bool uDepthNear;
in vec3 vColour;
${a?"in vec2 vCorner;":"in float vAcross;"}
in float vSection;
in float vFade;
${s.join(`
`)}

void main() {
  float r = ${a?"length(vCorner)":"abs(vAcross)"};
  if (r >= 1.0) discard;
  // Luxar's cross-section: exp(-K r^beta), shifted and truncated so it is 1
  // on the centre line and reaches 0 at the edge (K = ln 100, a 1% floor).
  float beta = exp2(6.0 * uSharpness - 2.0);
  float light = max(exp(-4.605170186 * pow(r, beta)) - 0.01, 0.0) / 0.99;
  light *= vFade;
  if (uSlab > 0.0) {
    // In a 2-D view, lines fade with their distance from the section.
    float s = vSection / uSlab;
    if (abs(s) >= 1.0) discard;
    light *= max(exp(-4.605170186 * s * s) - 0.01, 0.0) / 0.99;
  }
  ${i}
}
`}const Is=`#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;function Ps(a,t){const e=t?[`layout(location = ${a.color}) out vec4 outColour;`,a.z!==void 0?`layout(location = ${a.z}) out highp vec4 outZ;`:"",a.pick!==void 0?`layout(location = ${a.pick}) out highp vec4 outPick;`:""].join(`
`):`layout(location = ${a.color}) out vec4 outColour;`,s=t?`
  if (shown.a < uCut) discard;
  float d = texelFetch(uDepth, ivec2(gl_FragCoord.xy) - uOrigin, 0).r;
  if (d >= 1.0) discard;
  float fragDepth = uNear ? 0.0 : d;
  gl_FragDepth = fragDepth;
  outColour = vec4(0.0);
  ${a.z!==void 0?"outZ = vec4(1.0 - fragDepth);":""}
  ${a.pick!==void 0?"outPick = vec4(0.0);":""}`:"outColour = shown;";return`#version 300 es
precision highp float;
uniform highp sampler2D uLight;
uniform highp sampler2D uDepth;
uniform ivec2 uOrigin;
uniform int uToneMap;
uniform bool uEmission;
uniform float uCut;
uniform bool uNear;
${t?"":`uniform highp sampler2D uBloom0;
uniform highp sampler2D uBloom1;
uniform highp sampler2D uBloom2;
uniform float uBloom;`}
${e}

// ACES filmic, Narkowicz's fit.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 tone(vec3 x) {
  if (uToneMap == 0) return aces(x);
  if (uToneMap == 3) {
    // The same curve on the brightest channel, the colour scaled with it:
    // where many lines add up the light stays their colour instead of
    // every channel reaching white.
    float m = max(x.r, max(x.g, x.b));
    return m > 0.0 ? x * (aces(vec3(m)).r / m) : vec3(0.0);
  }
  if (uToneMap == 1) return x / (1.0 + x);
  return clamp(x, 0.0, 1.0);
}

void main() {
  vec4 light = texelFetch(uLight, ivec2(gl_FragCoord.xy) - uOrigin, 0);
  // Bloom (./bloom.ts): the bright light blurred at three scales, added before tone mapping.
  vec3 bloom = vec3(0.0);
  ${t?"":`if (uBloom > 0.0) {
    vec2 uv = (vec2(ivec2(gl_FragCoord.xy) - uOrigin) + 0.5) / vec2(textureSize(uLight, 0));
    bloom = uBloom * (texture(uBloom0, uv).rgb + texture(uBloom1, uv).rgb + texture(uBloom2, uv).rgb) / 3.0;
  }`}
  vec4 shown;
  if (uEmission) {
    // Emission and absorption, order-independent: the light emitted, each
    // part dimmed by the absorption of the rest (Luxar's self-screening
    // (1 - e^-tau) / tau), over what is behind, which shows through e^-tau.
    float tau = max(light.a, 0.0);
    float through = exp(-tau);
    float screen = tau < 1e-3 ? 1.0 - 0.5 * tau : (1.0 - through) / tau;
    vec3 c = tone(light.rgb * screen + bloom);
    shown = vec4(c, 1.0 - through);
    ${t?"shown.a = max(shown.a, max(c.r, max(c.g, c.b)));":""}
  } else {
    vec3 c = tone(light.rgb + bloom);
    shown = vec4(c, max(c.r, max(c.g, c.b)));
  }
  ${s}
}`}class Re{constructor(t){this.gl=t,this.floatTargets=t.getExtension("EXT_color_buffer_float")!==null}programs=new Map;emptyVao;floatTargets;compile(t,e,s){let o=this.programs.get(t);if(o!==void 0)return o;const{gl:i}=this,n=(h,u)=>{const d=i.createShader(h);if(i.shaderSource(d,u),i.compileShader(d),!i.getShaderParameter(d,i.COMPILE_STATUS))throw new Error(`Luxar shader: ${i.getShaderInfoLog(d)??"did not compile"}`);return d},r=i.createProgram(),c=n(i.VERTEX_SHADER,e),l=n(i.FRAGMENT_SHADER,s);if(i.attachShader(r,c),i.attachShader(r,l),i.linkProgram(r),i.deleteShader(c),i.deleteShader(l),!i.getProgramParameter(r,i.LINK_STATUS))throw new Error(`Luxar program: ${i.getProgramInfoLog(r)??"did not link"}`);return o={program:r,uniforms:new Map},this.programs.set(t,o),o}uniform(t,e){let s=t.uniforms.get(e);return s===void 0&&(s=this.gl.getUniformLocation(t.program,e),t.uniforms.set(e,s)),s}upload(t){const{gl:e}=this,s=e.createTexture();e.bindTexture(e.TEXTURE_2D,s),e.pixelStorei(e.UNPACK_ALIGNMENT,4);const o=t.vertices.length/4/G;e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,G,o,0,e.RGBA,e.FLOAT,t.vertices),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST);const i=e.createTexture();e.bindTexture(e.TEXTURE_2D,i),e.texImage2D(e.TEXTURE_2D,0,e.R32UI,G,o,0,e.RED_INTEGER,e.UNSIGNED_INT,t.slots),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.bindTexture(e.TEXTURE_2D,null);const n=e.createVertexArray();let r;t.segmentCount>0&&(e.bindVertexArray(n),r=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,r),e.bufferData(e.ARRAY_BUFFER,t.segments,e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribIPointer(0,4,e.UNSIGNED_INT,0,0),e.vertexAttribDivisor(0,1),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null));let c,l,h,u;return t.triangleCount>0&&(c=e.createTexture(),e.bindTexture(e.TEXTURE_2D,c),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,G,o,0,e.RGBA,e.FLOAT,t.normals),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.bindTexture(e.TEXTURE_2D,null),l=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,l),e.bufferData(e.ARRAY_BUFFER,t.triangles,e.STATIC_DRAW),h=e.createVertexArray(),e.bindVertexArray(h),e.enableVertexAttribArray(0),e.vertexAttribIPointer(0,1,e.UNSIGNED_INT,0,0),u=e.createVertexArray(),e.bindVertexArray(u),e.enableVertexAttribArray(0),e.vertexAttribIPointer(0,3,e.UNSIGNED_INT,12,0),e.vertexAttribDivisor(0,1),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null)),{texture:s,segments:r,vao:n,segmentCount:t.segmentCount,pointCount:t.pointCount,bytes:t.vertices.byteLength+t.slots.byteLength+t.segmentCount*16+t.normals.byteLength+t.triangles.byteLength,length:t.length,slots:i,objectIds:t.objectIds,objectWeight:t.objectWeight,objects:void 0,tableVersion:-1,shown:1,light:1,lower:t.lower,upper:t.upper,pieces:t.pieces,triangleCount:t.triangleCount,area:t.area,normals:c,faces:l,meshVao:h,cutVao:u}}shade(t,e){if(t.tableVersion===e.version)return;if(t.tableVersion=e.version,!Rt(e)){t.shown=t.light=1;return}const{gl:s}=this,{table:o,rows:i,shown:n,light:r}=bs(t.objectIds,t.objectWeight,e);t.shown=n,t.light=r,t.objects??=s.createTexture(),s.bindTexture(s.TEXTURE_2D,t.objects),s.pixelStorei(s.UNPACK_ALIGNMENT,4),s.texImage2D(s.TEXTURE_2D,0,s.RGBA8,G,i,0,s.RGBA,s.UNSIGNED_BYTE,o),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.NEAREST),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.NEAREST),s.bindTexture(s.TEXTURE_2D,null)}release(t){const{gl:e}=this;e.deleteTexture(t.texture),e.deleteTexture(t.slots),t.objects&&e.deleteTexture(t.objects),t.segments&&e.deleteBuffer(t.segments),e.deleteVertexArray(t.vao),t.normals&&e.deleteTexture(t.normals),t.faces&&e.deleteBuffer(t.faces),t.meshVao&&e.deleteVertexArray(t.meshVao),t.cutVao&&e.deleteVertexArray(t.cutVao)}draw(t,e,s,o,i,n=Y){const{gl:r}=this;for(const c of["lines","points","triangles"]){const l=c==="points",h=f=>c==="lines"?f.segmentCount:l?f.pointCount:f.triangleCount,u=t.filter(f=>h(f)>0&&(!o.objectTable||f.shown>0&&f.objects!==void 0));if(u.length===0)continue;const d=c==="triangles"&&o.slab>0,p=c==="triangles"&&!d,w=`${d?"cut":c}|${e}|${s.color},${s.z},${s.pick}`,g=c==="lines"?Ls:l?Os:d?Ds:Ns,v=this.compile(w,g,p?Fs(e,s):Us(l,e,s));r.useProgram(v.program),r.uniformMatrix4fv(this.uniform(v,"uModelToClip"),!1,o.modelToClip),r.uniformMatrix3fv(this.uniform(v,"uDirections"),!1,o.directions),r.uniform2f(this.uniform(v,"uViewport"),o.viewport[0],o.viewport[1]),r.uniform1f(this.uniform(v,"uHalfWidth"),l?3*o.halfWidth:o.halfWidth),r.uniform1i(this.uniform(v,"uColourBy"),l&&o.colourBy===0?1:o.colourBy),r.uniform3fv(this.uniform(v,"uColour"),o.colour),r.uniform1i(this.uniform(v,"uColormap"),o.colormap),r.uniform2f(this.uniform(v,"uRange"),o.range[0],o.range[1]),r.uniform4fv(this.uniform(v,"uPlane"),o.plane),r.uniform1f(this.uniform(v,"uSlab"),o.slab),r.uniform1f(this.uniform(v,"uSharpness"),o.sharpness),r.uniform1f(this.uniform(v,"uGain"),o.gain),r.uniform1f(this.uniform(v,"uAbsorption"),o.absorption),r.uniform1f(this.uniform(v,"uDepthCut"),o.depthCut),r.uniform1i(this.uniform(v,"uDepthNear"),o.depthNear?1:0),r.uniform1i(this.uniform(v,"uVertices"),0),r.uniform1i(this.uniform(v,"uSlots"),1),r.uniform1i(this.uniform(v,"uObjects"),2),r.uniform1i(this.uniform(v,"uObjectTable"),o.objectTable?1:0),r.uniform1i(this.uniform(v,"uOpaque"),e==="solid"?1:0),r.uniform1i(this.uniform(v,"uNormals"),3),r.uniform4fv(this.uniform(v,"uEye"),o.eye);for(const f of u)if(r.activeTexture(r.TEXTURE3),r.bindTexture(r.TEXTURE_2D,f.normals??null),r.activeTexture(r.TEXTURE1),r.bindTexture(r.TEXTURE_2D,f.slots),r.activeTexture(r.TEXTURE2),r.bindTexture(r.TEXTURE_2D,f.objects??null),r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,f.texture),l)this.emptyVao??=r.createVertexArray(),r.bindVertexArray(this.emptyVao),r.drawArraysInstanced(r.TRIANGLE_STRIP,0,4,f.pointCount);else if(p)r.bindVertexArray(f.meshVao),r.drawArrays(r.TRIANGLES,0,3*f.triangleCount);else if(d)r.bindVertexArray(f.cutVao),r.drawArraysInstanced(r.TRIANGLE_STRIP,0,4,f.triangleCount);else if(f.pieces!==void 0&&f.segments!==void 0){r.bindVertexArray(f.vao),r.bindBuffer(r.ARRAY_BUFFER,f.segments);const{pieces:b}=f,T=Math.max(1,Math.min(Y,Math.round(n)));for(let x=0;x+we<=b.length;x+=we){if(i!==void 0&&!i([b[x+2],b[x+3],b[x+4]],[b[x+5],b[x+6],b[x+7]]))continue;const S=b[x+7+T];S!==0&&(r.vertexAttribIPointer(0,4,r.UNSIGNED_INT,0,b[x]*16),r.drawArraysInstanced(r.TRIANGLE_STRIP,0,4,S))}r.vertexAttribIPointer(0,4,r.UNSIGNED_INT,0,0),r.bindBuffer(r.ARRAY_BUFFER,null)}else r.bindVertexArray(f.vao),r.drawArraysInstanced(r.TRIANGLE_STRIP,0,4,f.segmentCount);r.bindVertexArray(null);for(const f of[r.TEXTURE3,r.TEXTURE2,r.TEXTURE1])r.activeTexture(f),r.bindTexture(r.TEXTURE_2D,null);r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,null)}}composite(t,e,s){const{gl:o}=this,i=s.depth,n=this.compile(`composite|${i?"depth":"colour"}|${e.color},${e.z},${e.pick}`,Is,Ps(e,i!==void 0));if(o.useProgram(n.program),o.activeTexture(o.TEXTURE0),o.bindTexture(o.TEXTURE_2D,t),o.uniform1i(this.uniform(n,"uLight"),0),i&&(o.activeTexture(o.TEXTURE1),o.bindTexture(o.TEXTURE_2D,i.texture),o.uniform1i(this.uniform(n,"uDepth"),1),o.uniform1f(this.uniform(n,"uCut"),i.cut),o.uniform1i(this.uniform(n,"uNear"),i.near?1:0)),!i){const r=s.bloom;for(let c=0;c<3;++c)o.activeTexture(o.TEXTURE1+c),o.bindTexture(o.TEXTURE_2D,r?.textures[c]??null),o.uniform1i(this.uniform(n,`uBloom${c}`),1+c);o.uniform1f(this.uniform(n,"uBloom"),r!==void 0&&r.textures.length>=3?r.amount:0),o.activeTexture(o.TEXTURE0)}if(o.uniform2i(this.uniform(n,"uOrigin"),s.origin[0],s.origin[1]),o.uniform1i(this.uniform(n,"uToneMap"),s.toneMap),o.uniform1i(this.uniform(n,"uEmission"),s.emission?1:0),this.emptyVao??=o.createVertexArray(),o.bindVertexArray(this.emptyVao),o.drawArrays(o.TRIANGLES,0,3),o.bindVertexArray(null),i)o.bindTexture(o.TEXTURE_2D,null),o.activeTexture(o.TEXTURE0);else{for(let r=3;r>=1;--r)o.activeTexture(o.TEXTURE0+r),o.bindTexture(o.TEXTURE_2D,null);o.activeTexture(o.TEXTURE0)}o.bindTexture(o.TEXTURE_2D,null)}fullScreen(t,e,s,o,i={},n={}){const{gl:r}=this,c=this.compile(t,e,s);r.useProgram(c.program);const l=Object.keys(o);l.forEach((h,u)=>{r.activeTexture(r.TEXTURE0+u),r.bindTexture(r.TEXTURE_2D,o[h]),r.uniform1i(this.uniform(c,h),u)});for(const[h,u]of Object.entries(i))r.uniform2i(this.uniform(c,h),u[0],u[1]);for(const[h,u]of Object.entries(n))r.uniform1f(this.uniform(c,h),u);this.emptyVao??=r.createVertexArray(),r.bindVertexArray(this.emptyVao),r.drawArrays(r.TRIANGLES,0,3),r.bindVertexArray(null);for(let h=l.length-1;h>=0;--h)r.activeTexture(r.TEXTURE0+h),r.bindTexture(r.TEXTURE_2D,null)}dispose(){for(const t of this.programs.values())this.gl.deleteProgram(t.program);this.programs.clear(),this.emptyVao&&this.gl.deleteVertexArray(this.emptyVao),this.emptyVao=void 0}}class _e{constructor(t,e){this.gl=t,this.float=e}framebuffer;texture;size=[0,0];depth=null;bind(t,e,s){const{gl:o}=this;return this.framebuffer===void 0||this.size[0]!==t||this.size[1]!==e?(this.release(),this.texture=o.createTexture(),o.bindTexture(o.TEXTURE_2D,this.texture),this.float?o.texImage2D(o.TEXTURE_2D,0,o.RGBA16F,t,e,0,o.RGBA,o.HALF_FLOAT,null):o.texImage2D(o.TEXTURE_2D,0,o.RGBA8,t,e,0,o.RGBA,o.UNSIGNED_BYTE,null),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_MIN_FILTER,o.NEAREST),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_MAG_FILTER,o.NEAREST),o.bindTexture(o.TEXTURE_2D,null),this.framebuffer=o.createFramebuffer(),o.bindFramebuffer(o.FRAMEBUFFER,this.framebuffer),o.framebufferTexture2D(o.FRAMEBUFFER,o.COLOR_ATTACHMENT0,o.TEXTURE_2D,this.texture,0),this.size=[t,e],this.depth=null):o.bindFramebuffer(o.FRAMEBUFFER,this.framebuffer),s!==this.depth&&(o.framebufferRenderbuffer(o.FRAMEBUFFER,o.DEPTH_STENCIL_ATTACHMENT,o.RENDERBUFFER,s),this.depth=s),o.drawBuffers([o.COLOR_ATTACHMENT0]),o.checkFramebufferStatus(o.FRAMEBUFFER)===o.FRAMEBUFFER_COMPLETE}release(){const{gl:t}=this;this.framebuffer&&t.deleteFramebuffer(this.framebuffer),this.texture&&t.deleteTexture(this.texture),this.framebuffer=this.texture=void 0,this.depth=null,this.size=[0,0]}}class $s{constructor(t){this.gl=t}framebuffer;texture;size=[0,0];bind(t,e){const{gl:s}=this;return this.framebuffer===void 0||this.size[0]!==t||this.size[1]!==e?(this.release(),this.texture=s.createTexture(),s.bindTexture(s.TEXTURE_2D,this.texture),s.texImage2D(s.TEXTURE_2D,0,s.DEPTH_COMPONENT24,t,e,0,s.DEPTH_COMPONENT,s.UNSIGNED_INT,null),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.NEAREST),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.NEAREST),s.bindTexture(s.TEXTURE_2D,null),this.framebuffer=s.createFramebuffer(),s.bindFramebuffer(s.FRAMEBUFFER,this.framebuffer),s.framebufferTexture2D(s.FRAMEBUFFER,s.DEPTH_ATTACHMENT,s.TEXTURE_2D,this.texture,0),this.size=[t,e]):s.bindFramebuffer(s.FRAMEBUFFER,this.framebuffer),s.drawBuffers([s.NONE]),s.checkFramebufferStatus(s.FRAMEBUFFER)!==s.FRAMEBUFFER_COMPLETE?!1:(s.depthMask(!0),s.clearDepth(1),s.clear(s.DEPTH_BUFFER_BIT),!0)}release(){const{gl:t}=this;this.framebuffer&&t.deleteFramebuffer(this.framebuffer),this.texture&&t.deleteTexture(this.texture),this.framebuffer=this.texture=void 0,this.size=[0,0]}}const zs=512*1024*1024,js=384*1024*1024;class Vs{constructor(t){this.view=t,this.overlay=t.ctx.ui.overlay(),this.canvas=document.createElement("canvas"),this.canvas.className="luxar-canvas",this.overlay.element.append(this.canvas),this.offRendered=t.ctx.viewer.onRendered(()=>this.schedule()),this.offScreenshot=t.ctx.ui.screenshotOverlay((e,s)=>this.paint(e,s)),this.canvas.addEventListener("webglcontextlost",e=>{e.preventDefault(),this.renderer=this.chunks=this.sets=this.target=this.bloom=void 0}),this.canvas.addEventListener("webglcontextrestored",()=>{this.gl=null,this.schedule()})}overlay;canvas;gl=null;renderer;chunks;sets;target;bloom;queued=!1;visible=!0;offRendered;offScreenshot;problem;selections=[];signature="";drawnStyle;more=!1;setVisible(t){this.visible=t,this.canvas.style.display=t?"":"none",this.schedule()}schedule(){this.queued||(this.queued=!0,requestAnimationFrame(()=>{this.queued=!1;try{this.render()}catch(t){this.problem=`2-D views: ${t.message}`}}))}context(){if(this.gl===null){if(this.gl=this.canvas.getContext("webgl2",{alpha:!0,premultipliedAlpha:!0,antialias:!1,depth:!0,stencil:!1,preserveDrawingBuffer:!0}),this.gl===null)return this.problem="No WebGL2 for the 2-D views.",null;this.renderer=new Re(this.gl),this.target=new _e(this.gl,this.renderer.floatTargets),this.chunks=new Ee(this.renderer,this.view.client,zs),this.bloom=new Ae(this.renderer,this.renderer.floatTargets)}return this.gl}panelMatrices(t,e,s,o,i){const n=this.view.transform();if(n===void 0)return;const r=At(v=>t.project(v),e.position);if(r===void 0)return;let c=0;e.names.forEach((v,f)=>{const b=e.units[f]==="m"?e.scales[f]*1e3:e.scales[f];c+=(r[2][f]/b)**2});const l=c>0?1/Math.sqrt(c):0,h=is(n,e.names,r),u=new Float64Array(16);u[0]=2/s,u[12]=-1,u[5]=-2/o,u[13]=1,u[10]=l>0?.999*l/i:0,u[15]=1;const d=se(u,h),p=[h[2]*l,h[6]*l,h[10]*l,h[14]*l],w=xe(h),g=w?oe(w,[s/2,o/2,0]):[0,0,0];return{modelToClip:d,plane:p,centre:g,slab:l>0?i:0}}render(){const{view:t}=this,e=t.client.info,s=this.visible?t.ctx.viewer.panels().filter(M=>M.kind==="2d"):[],o=s.length>0&&e!==void 0?this.context():this.gl;if(o===null)return;const i=this.overlay.element.getBoundingClientRect(),n=globalThis.devicePixelRatio||1,r=Math.max(1,Math.round(i.width*n)),c=Math.max(1,Math.round(i.height*n));(this.canvas.width!==r||this.canvas.height!==c)&&(this.canvas.width=r,this.canvas.height=c);const l=t.style;this.canvas.style.mixBlendMode=l.blending==="glow"||l.blending==="glow-through"?"plus-lighter":"normal";const h=t.ctx.viewer.getState(),u=h.dimensions??{},d=Object.keys(u),p={names:d,scales:d.map(M=>u[M][0]),units:d.map(M=>u[M][1]),position:d.map((M,C)=>h.position?.[C]??0)},w=l.slab/2,g=s.flatMap(M=>{const C=M.element.getBoundingClientRect();if(C.width<2||C.height<2)return[];const N=this.panelMatrices(M,p,C.width,C.height,w);return N===void 0?[]:[{rect:C,m:N}]}),v=JSON.stringify([r,c,t.client.arrivals,t.client.generation,t.client.objects.arrivals,t.client.objects.generation,t.drawing().version,t.held,t.budget("2d"),e===void 0,g.map(({rect:M,m:C})=>[M.left,M.top,M.width,M.height,Array.from(C.modelToClip,N=>+N.toPrecision(9))])]);if(v===this.signature&&l===this.drawnStyle&&!this.more||(this.signature=v,this.drawnStyle=l,o.bindFramebuffer(o.FRAMEBUFFER,null),o.viewport(0,0,r,c),o.clearColor(0,0,0,0),o.clearDepth(1),o.clear(o.COLOR_BUFFER_BIT|o.DEPTH_BUFFER_BIT),e===void 0||g.length===0||this.renderer===void 0))return;const f=l.blending==="solid",b=this.renderer,T=this.chunks,x=this.target;if(!f&&!x.bind(r,c,null)){this.problem="This GPU cannot add light up in a float target here.";return}o.viewport(0,0,r,c),o.clearColor(0,0,0,0),o.clear(o.COLOR_BUFFER_BIT),o.enable(o.SCISSOR_TEST),f?(o.enable(o.DEPTH_TEST),o.depthFunc(o.LESS),o.depthMask(!0),o.disable(o.BLEND)):(o.disable(o.DEPTH_TEST),o.enable(o.BLEND),o.blendFunc(o.ONE,o.ONE));const S=[];let y=!1;const m=[],E=t.budget("2d"),A=[],R=t.drawing();let B=[],F=Y;if(R.sets!==void 0){this.sets??=new Ee(b,t.client.objects,js);const M=this.sets.take(t.client.objects.drawn(),R.sets);B=M.chunks,y||=M.more}g.forEach(({rect:M,m:C})=>{let N=[],X=1;if(R.chunks!==void 0){const I=Te(e,(z,ie)=>he(C.modelToClip,z,ie),C.centre,E,z=>T.arrived(z));S.push(I),m.push(I.want);const $=T.take(I.draw,R.chunks);y||=$.more,N=$.chunks,A.push(...N);const W=e.levels[I.level].chunkShape;X=C.slab>0?Math.min(1,2*C.slab/((W[0]+W[1]+W[2])/3)):1}if(t.held||N.length===0&&B.length===0)return;const H=Math.round((M.left-i.left)*n),q=Math.round((i.bottom-M.bottom)*n),j=Math.round(M.width*n),P=Math.round(M.height*n);o.viewport(H,q,j,P),o.scissor(H,q,j,P);const Z=yt(C.modelToClip,C.centre,[j,P]),Q=Et(C.modelToClip,e.bounds.lower,e.bounds.upper,[j,P]),L=(I,$)=>he(C.modelToClip,I,$),U=Math.min(...e.levels[0].chunkShape)/2,O=C.slab>0?Math.min(1,2*C.slab/U):1,V=B.length>0?St(B,L,l.detail*1e6/O):Y;F=Math.min(F,V);const ee=B.reduce((I,$)=>{const W=($.upper[0]-$.lower[0]+$.upper[1]-$.lower[1]+$.upper[2]-$.lower[2])/3,z=C.slab>0&&W>0?Math.min(1,2*C.slab/W):1;return I+ye([$],Z,2*t.halfWidth,Q,z*V/Y)},0),K=ye(N,Z,2*t.halfWidth,Q,X),J=f?"solid":"accumulate",te=Float32Array.from(C.modelToClip);for(const[I,$,W]of[[N,K+ee,void 0],[B,ee,L]]){if(I.length===0)continue;const z=t.uniforms(te,[j,P],$);z.plane=C.plane,z.slab=C.slab,b.draw(I,J,{color:0},z,W,V)}}),t.reportSamples("2d",F),o.disable(o.SCISSOR_TEST);const _=[],D=new Set;for(let M=0;m.some(C=>M<C.length);++M)for(const C of m){const N=C[M];N!==void 0&&!D.has(N)&&(D.add(N),_.push(N))}if(t.client.want("2d",_),A.length>0&&t.reportShare("2d",xt(A)),this.selections=S,S.length>0){const M=S.reduce((C,N)=>C.level<=N.level?C:N);t.reportLevel("2d",{...M,complete:S.every(C=>C.complete)})}if(!f){const M=l.blending==="emission",C=l.bloom>0?this.bloom.run(x.texture,r,c,M):void 0;o.bindFramebuffer(o.FRAMEBUFFER,null),o.viewport(0,0,r,c),o.enable(o.BLEND),M?o.blendFunc(o.ONE,o.ONE_MINUS_SRC_ALPHA):o.blendFunc(o.ONE,o.ONE),b.composite(x.texture,{color:0},{toneMap:t.toneIndex,emission:M,origin:[0,0],bloom:C&&{textures:C,amount:l.bloom}}),o.disable(o.BLEND)}this.more=y,y&&this.schedule()}paint(t,e){if(!this.visible||this.gl===null)return;const s=e.getBoundingClientRect(),o=e.width/Math.max(1,s.width),i=this.overlay.element.getBoundingClientRect();t.save(),t.globalCompositeOperation=this.canvas.style.mixBlendMode==="plus-lighter"?"lighter":"source-over",t.drawImage(this.canvas,(i.left-s.left)*o,(i.top-s.top)*o,i.width*o,i.height*o),t.restore()}dispose(){this.offScreenshot(),this.offRendered(),this.chunks?.clear(),this.sets?.clear(),this.target?.release(),this.bloom?.release(),this.renderer?.dispose(),this.overlay.dispose(),this.gl?.getExtension("WEBGL_lose_context")?.loseContext()}}const Xs=768*1024*1024,Ws=512*1024*1024;class Gs{constructor(t){this.view=t}renderer;chunks;sets;target;nearest;bloom;broken=!1;selection;problem;isReady(){return(this.selection===void 0||this.selection.complete)&&this.view.objectsReady}save(t){const e=[];for(let s=0;s<4;++s)e.push(t.getParameter(t.DRAW_BUFFER0+s));for(;e.length>1&&e[e.length-1]===t.NONE;)e.pop();return{framebuffer:t.getParameter(t.DRAW_FRAMEBUFFER_BINDING),viewport:t.getParameter(t.VIEWPORT),blend:t.isEnabled(t.BLEND),depthTest:t.isEnabled(t.DEPTH_TEST),depthMask:t.getParameter(t.DEPTH_WRITEMASK),depthFunc:t.getParameter(t.DEPTH_FUNC),stencil:t.isEnabled(t.STENCIL_TEST),scissor:t.isEnabled(t.SCISSOR_TEST),drawBuffers:e}}restore(t,e){t.bindFramebuffer(t.FRAMEBUFFER,e.framebuffer),t.drawBuffers(e.drawBuffers),t.viewport(e.viewport[0],e.viewport[1],e.viewport[2],e.viewport[3]),e.blend?t.enable(t.BLEND):t.disable(t.BLEND),e.depthTest?t.enable(t.DEPTH_TEST):t.disable(t.DEPTH_TEST),t.depthMask(e.depthMask),t.depthFunc(e.depthFunc),e.stencil?t.enable(t.STENCIL_TEST):t.disable(t.STENCIL_TEST),e.scissor?t.enable(t.SCISSOR_TEST):t.disable(t.SCISSOR_TEST),t.blendFunc(t.ONE,t.ZERO),t.activeTexture(t.TEXTURE0)}draw(t){const{gl:e}=t,{view:s}=this;this.renderer?.gl!==e&&(this.dispose(),this.renderer=new Re(e),this.target=new _e(e,this.renderer.floatTargets),this.nearest=new $s(e),this.bloom=new Ae(this.renderer,this.renderer.floatTargets));const o=s.client.info,i=s.transform();if(o===void 0||i===void 0)return;const n=Qt(i,t.dimensions.names);if(n===void 0){this.problem=`The 3-D view shows ${t.dimensions.names.join(", ")}, which this layer does not have.`;return}this.problem=void 0,this.chunks??=new Ee(this.renderer,s.client,Xs),this.sets??=new Ee(this.renderer,s.client.objects,Ws);const r=this.chunks,c=se(t.viewProjection,n),l=xe(n),h=l?oe(l,t.position):[0,0,0],u=s.style,d=s.drawing();let p=[],w=!1;if(d.chunks!==void 0){const _=Te(o,(D,M)=>he(c,D,M),h,s.budget("3d"),D=>r.arrived(D));this.selection=_,s.client.want("3d",_.want),{chunks:p,more:w}=r.take(_.draw,d.chunks),s.reportLevel("3d",_),p.length>0&&s.reportShare("3d",xt(p))}else this.selection=void 0,s.client.want("3d",[]);let g=[];if(d.sets!==void 0){const _=this.sets.take(s.client.objects.drawn(),d.sets);g=_.chunks,w||=_.more}if(w&&s.redraw(),s.held||p.length===0&&g.length===0)return;const v=this.save(e),f=[v.viewport[2],v.viewport[3]],b=yt(c,h,f),T=Et(c,o.bounds.lower,o.bounds.upper,f),x=(_,D)=>he(c,_,D),S=St(g,x,u.detail*1e6);s.reportSamples("3d",g.length>0?S:Y);const y=ye(g,b,2*s.halfWidth,T,S/Y,!0),m=ye(p,b,2*s.halfWidth,T,1,!0),E=Float32Array.from(c),A=s.uniforms(E,f,m+y),R=s.uniforms(E,f,y);A.eye=R.eye=ss(c);const B=this.renderer,F=(_,D,M={})=>{p.length>0&&B.draw(p,_,D,{...A,...M}),g.length>0&&B.draw(g,_,D,{...R,...M},x,S)};try{if(u.blending==="solid"||this.broken){e.disable(e.BLEND),e.enable(e.DEPTH_TEST),e.depthMask(!0),F("solid",t.outputs);return}const _=e.getFramebufferAttachmentParameter(e.DRAW_FRAMEBUFFER,e.DEPTH_STENCIL_ATTACHMENT,e.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME)??null,[,,D,M]=v.viewport;if(!this.target.bind(D,M,_)){this.broken=!0,this.problem="This GPU cannot add light up in a float target here; drawing solid lines instead.";return}e.viewport(0,0,D,M),e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT),e.disable(e.STENCIL_TEST),e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE),e.depthMask(!1);const C=u.blending==="glow-through";C?e.disable(e.DEPTH_TEST):(e.enable(e.DEPTH_TEST),e.depthFunc(e.LEQUAL)),F("accumulate",{color:0});const N=this.nearest;N.bind(D,M)&&(e.disable(e.BLEND),e.enable(e.DEPTH_TEST),e.depthFunc(e.LESS),F("depth",{color:0},{depthCut:.05,depthNear:!1}));const X=u.blending==="emission",H=u.bloom>0?this.bloom.run(this.target.texture,D,M,X):void 0;e.enable(e.BLEND),e.bindFramebuffer(e.FRAMEBUFFER,v.framebuffer),e.viewport(v.viewport[0],v.viewport[1],D,M);const q=j=>v.drawBuffers.map((P,Z)=>Z===j?P:e.NONE);e.drawBuffers(q(t.outputs.color)),e.disable(e.DEPTH_TEST),X?e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA):e.blendFuncSeparate(e.ONE,e.ONE,e.ONE,e.ONE_MINUS_SRC_ALPHA),B.composite(this.target.texture,t.outputs,{toneMap:s.toneIndex,emission:X,origin:[v.viewport[0],v.viewport[1]],bloom:H&&{textures:H,amount:u.bloom}}),N.texture!==void 0&&(e.drawBuffers(v.drawBuffers.map((j,P)=>P===t.outputs.color?e.NONE:j)),e.disable(e.BLEND),e.enable(e.DEPTH_TEST),e.depthFunc(e.LESS),e.depthMask(!0),v.stencil&&e.enable(e.STENCIL_TEST),B.composite(this.target.texture,t.outputs,{toneMap:s.toneIndex,emission:X,origin:[v.viewport[0],v.viewport[1]],depth:{texture:N.texture,cut:.15,near:C}}))}finally{this.restore(e,v)}}dispose(){this.chunks?.clear(),this.sets?.clear(),this.sets=void 0,this.target?.release(),this.nearest?.release(),this.nearest=void 0,this.bloom?.release(),this.bloom=void 0,this.renderer?.dispose(),this.chunks=void 0,this.target=void 0,this.renderer=void 0}}let Hs=0;class re{constructor(t,e,s,o){this.ctx=t,this.name=e,this.storeUrl=s,this.style=o,this.client=new ps(s),this.client.setScalar(rt(o)),this.view3d=new Gs(this),this.view2d=new Vs(this),this.handle=t.viewer.draw3d(e,{draw:i=>this.view3d.draw(i),isReady:()=>this.view3d.isReady(),afterSections:!0,dispose:()=>this.view3d.dispose()}),this.offs.push(t.viewer.onSegmentsChanged(e,()=>{this.frozen||(this.current=void 0,this.colours.clear(),this.redraw(),this.onStatus?.())})),this.client.onChunk=()=>{this.redraw(),this.onStatus?.()},this.client.ready.then(()=>{this.redraw(),this.onStatus?.()},()=>this.onStatus?.())}client;handle;view3d;view2d;levels=new Map;transformCache;offs=[];current;colours=new Map;shares=new Map;samples=new Map;onStatus;held=!1;frozen=!1;chosen;setStyle(t){this.style=t,this.client.setScalar(rt(t)),this.redraw()}transform(){const t=performance.now();return(this.transformCache===void 0||t-this.transformCache.at>8)&&(this.transformCache={at:t,value:this.ctx.viewer.layerTransform(this.name)}),this.transformCache.value}redraw(){this.transformCache=void 0,this.handle.redraw(),this.view2d.schedule()}drawing(){const t=this.style.colourBy==="segment",e=this.client.objects.measured(),s=`${t}|${this.style.detail}|${this.client.scalarName}|${this.client.info!==void 0}|${e!==void 0}`;if(this.current!==void 0&&(this.current.key===s||this.frozen))return this.chosen?.drawing===this.current&&(this.chosen.at=performance.now()),this.current;const o=this.ctx.viewer.visibleSegments(this.name),{ctx:i,name:n,colours:r,client:c}=this,l=b=>{let T=r.get(b);return T===void 0&&(T=i.viewer.segmentColour(n,b)??[1,1,1],r.set(b,T)),T},h=o===void 0||o.all,u=h?0:o.size,d=h?0:Math.min(1,Math.max(0,o.notSelectedAlpha??0)),p=h||c.info===void 0?void 0:ls(c.info,u,c.scalarName,this.style.detail,e),w={version:++Hs,all:h,has:b=>o===void 0||o.has(b),colour:t?l:void 0},g=p===void 0?{...w,chosenAlpha:1,othersAlpha:d}:d>0?{...w,chosenAlpha:0,othersAlpha:d}:void 0,v=p===void 0?void 0:{...w,chosenAlpha:1,othersAlpha:0},f=p===void 0?void 0:o?.ids();return c.objects.want(f,p,c.scalarName),g===void 0&&this.levels.clear(),this.current={key:s,version:w.version,chunks:g,sets:v,size:u,plan:p,others:d,table:g===void 0||Rt(g)},u>0&&(this.chosen={drawing:this.current,ids:f,at:performance.now()}),this.current}freeze(){const t=this.chosen;this.current?.size===0&&t!==void 0&&performance.now()-t.at<3e3&&(this.current=t.drawing,this.client.objects.want(t.ids,t.drawing.plan,this.client.scalarName),this.levels.clear()),this.frozen=!0,this.redraw()}get objectsShown(){return this.drawing().plan===void 0?void 0:this.client.objects.progress().read}get ready(){if(this.client.info===void 0||!this.objectsReady)return!1;if(this.drawing().chunks===void 0)return!0;const t=[...this.levels.values()];return t.length>0&&t.every(e=>e.complete)}get toneIndex(){return We[this.style.toneMap]}get halfWidth(){return this.style.width*(globalThis.devicePixelRatio||1)/2}uniforms(t,e,s){const{style:o}=this,i=this.transform(),n=o.autoBrightness?os(s):1,r=2**o.exposure*n,c=o.range??this.client.valueRange??[0,1];return{modelToClip:t,directions:i?es(i):new Float32Array([1,0,0,0,1,0,0,0,1]),viewport:e,halfWidth:this.halfWidth,sharpness:o.sharpness,colourBy:As[o.colourBy],colour:Ve(o.colour),colormap:Xe[o.colormap],range:c,gain:r,absorption:o.blending==="emission"?o.absorption*n:0,plane:[0,0,0,0],slab:0,depthCut:.3,depthNear:!1,objectTable:this.drawing().table,eye:[0,0,1,0]}}budget(t){const e=this.drawing().chunks,s=this.shares.get(t);return Ce(this.style.detail,e===void 0||e.all||s?.version!==e.version?1:s.share)}reportShare(t,e){const{version:s}=this.drawing(),o=this.shares.get(t),i=o?.version===s?o.share:1;e>=i||(this.shares.set(t,{version:s,share:e}),Ce(1,e)>1.01*Ce(1,i)&&this.redraw())}reportSamples(t,e){this.samples.get(t)!==e&&(this.samples.set(t,e),this.onStatus?.())}reportLevel(t,e){const s=this.levels.get(t);this.levels.set(t,e),(s===void 0||s.level!==e.level||s.complete!==e.complete)&&this.onStatus?.()}status(){const{client:t}=this;if(t.error!==void 0&&t.info===void 0)return`Could not open the store: ${t.error}`;if(t.info===void 0)return"Opening the store…";const e=[this.view3d.problem,this.view2d.problem].filter(r=>r!==void 0),s=r=>{const c=t.info?.levels[r]?.objectShare;return c!==void 0&&c<1?`, ${+(c*100).toPrecision(2)}% of the objects`:""},o=[...this.levels.entries()].map(([r,c])=>`${r==="3d"?"3-D":"2-D"} level ${c.level}${s(c.level)}${c.complete?"":" (loading)"}`),i=[...new Set(o)],n=this.drawing();if(n.size>0){const r=n.size===1?"1 segment shown":`${n.size.toLocaleString()} segments shown`;if(n.plan===void 0)i.unshift(r);else{const c=t.objects.progress(),l=c.pending>0?`reading them whole: ${c.read.toLocaleString()} of ${(c.wanted-c.absent).toLocaleString()}`:`read whole (level ${n.plan.level})`,h=[...this.samples.entries()].filter(([,u])=>u<Y).map(([u,d])=>`${u==="3d"?"3-D":"2-D"} view ${d} in ${Y} of them (Detail)`);i.unshift(`${r}, ${l}${c.absent>0?` (${c.absent.toLocaleString()} not in the store)`:""}`,...h),n.chunks!==void 0&&i.splice(1,0,`the others at ${+(n.others*100).toPrecision(2)}%`)}}return t.pending>0&&i.push(`${t.pending} chunks to read`),t.error!==void 0&&i.push(`a chunk failed: ${t.error}`),t.objects.error!==void 0&&i.push(`reading objects whole failed: ${t.objects.error}`),[...e,i.join(" · ")].filter(r=>r).join(" ")}get objectsReady(){return this.drawing().plan===void 0||!this.client.objects.busy}setVisible(t){this.view2d.setVisible(t)}dispose(){this.offs.forEach(t=>t()),this.handle.dispose(),this.view2d.dispose(),this.client.dispose()}}const qs=`#version 300 es
precision highp float;
layout(location = 0) in vec3 aCentre;
layout(location = 1) in vec3 aCovA;
layout(location = 2) in vec3 aCovB;
layout(location = 3) in float aWeight;
uniform mat4 uModelToClip;
uniform vec2 uViewport;
// A 2-D view's section: millimetres from it, as dot(xyz, centre) + w (model units are mm); off in 3-D.
uniform bool uSection;
uniform vec4 uPlane;
// In a section, each Gaussian widened by this (its total kept), so a grid of cells reads as one image.
uniform float uWiden;
out vec2 vOffset;
out vec3 vInvCov;
out float vWeight;
out float vColourAt;

void main() {
  // The quad's corner, (±1, ±1).
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  mat3 S = mat3(aCovA.x, aCovA.y, aCovA.z, aCovA.y, aCovB.x, aCovB.y, aCovA.z, aCovB.y, aCovB.z);
  vec3 centre = aCentre;
  float weight = aWeight;
  if (uSection) {
    // The Gaussian cut by the section: its peak there (the weight times the Gaussian along
    // the plane's normal), its centre and covariance in the plane given where it is cut.
    vec3 n = uPlane.xyz;
    vec3 Sn = S * n;
    float s = max(dot(n, Sn), 1e-6);
    float d = dot(n, aCentre) + uPlane.w;
    if (d * d > 9.0 * s) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    // Light, not intensity times light: the colour says the intensity.
    weight = exp(-0.5 * d * d / s) / uWiden;
    centre -= Sn * (d / s);
    S = (S - outerProduct(Sn, Sn) / s) * uWiden;
  }
  vec4 c = uModelToClip * vec4(centre, 1.0);
  if (c.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 ndc = c.xy / c.w;
  // Pixels per unit of each model axis at the centre.
  vec2 hv = 0.5 * uViewport;
  vec2 j0 = hv * (uModelToClip[0].xy - ndc * uModelToClip[0].w) / c.w;
  vec2 j1 = hv * (uModelToClip[1].xy - ndc * uModelToClip[1].w) / c.w;
  vec2 j2 = hv * (uModelToClip[2].xy - ndc * uModelToClip[2].w) / c.w;
  mat3x2 J = mat3x2(j0, j1, j2);
  mat2 P = J * S * transpose(J) + mat2(0.3, 0.0, 0.0, 0.3);
  float det = P[0][0] * P[1][1] - P[0][1] * P[1][0];
  vInvCov = vec3(P[1][1], -P[0][1], P[0][0]) / det;
  // Three standard deviations along each screen axis.
  vec2 extent = 3.0 * sqrt(vec2(P[0][0], P[1][1]));
  vOffset = corner * extent;
  vWeight = weight;
  vColourAt = aWeight;
  gl_Position = vec4(c.xy + vOffset / hv * c.w, c.z, c.w);
}`,Ys=`#version 300 es
precision highp float;
uniform float uGain;
uniform float uAbsorption;
uniform int uColormap;
uniform bool uOneColour;
uniform vec3 uColour;
in vec2 vOffset;
in vec3 vInvCov;
in float vWeight;
in float vColourAt;
out vec4 outLight;

${Ct}

void main() {
  float power = -0.5 * (vInvCov.x * vOffset.x * vOffset.x + 2.0 * vInvCov.y * vOffset.x * vOffset.y + vInvCov.z * vOffset.y * vOffset.y);
  if (power < -4.5) discard;
  float g = exp(power) * vWeight;
  vec3 colour = uOneColour ? uColour : colormap(uColormap, vColourAt);
  // Light, and (for emission and absorption) optical depth.
  outLight = vec4(colour * g * uGain, g * uAbsorption);
}`;class Bt{constructor(t){this.gl=t;const e=(o,i)=>{const n=t.createShader(o);if(t.shaderSource(n,i),t.compileShader(n),!t.getShaderParameter(n,t.COMPILE_STATUS))throw new Error(t.getShaderInfoLog(n)??"the splat shader did not compile");return n},s=t.createProgram();if(t.attachShader(s,e(t.VERTEX_SHADER,qs)),t.attachShader(s,e(t.FRAGMENT_SHADER,Ys)),t.linkProgram(s),!t.getProgramParameter(s,t.LINK_STATUS))throw new Error(t.getProgramInfoLog(s)??"the splat program did not link");this.program=s}program;uniforms=new Map;u(t){return this.uniforms.has(t)||this.uniforms.set(t,this.gl.getUniformLocation(this.program,t)),this.uniforms.get(t)}upload(t,e,s){const{gl:o}=this,i=s.length,n=new Float32Array(10*i);for(let h=0;h<i;++h)n.set(t.subarray(3*h,3*h+3),10*h),n.set(e.subarray(6*h,6*h+6),10*h+3),n[10*h+9]=s[h];const r=o.createVertexArray(),c=o.createBuffer();o.bindVertexArray(r),o.bindBuffer(o.ARRAY_BUFFER,c),o.bufferData(o.ARRAY_BUFFER,n,o.STATIC_DRAW);const l=(h,u,d)=>{o.enableVertexAttribArray(h),o.vertexAttribPointer(h,u,o.FLOAT,!1,40,d),o.vertexAttribDivisor(h,1)};return l(0,3,0),l(1,3,12),l(2,3,24),l(3,1,36),o.bindVertexArray(null),o.bindBuffer(o.ARRAY_BUFFER,null),{vao:r,buffer:c,count:i,bytes:n.byteLength}}release(t){this.gl.deleteVertexArray(t.vao),this.gl.deleteBuffer(t.buffer)}draw(t,e){const{gl:s}=this;s.useProgram(this.program),s.uniformMatrix4fv(this.u("uModelToClip"),!1,e.modelToClip),s.uniform2fv(this.u("uViewport"),e.viewport),s.uniform1f(this.u("uGain"),e.gain),s.uniform1f(this.u("uAbsorption"),e.absorption),s.uniform1i(this.u("uColormap"),e.colormap),s.uniform1i(this.u("uOneColour"),e.colour?1:0),s.uniform3fv(this.u("uColour"),e.colour??[1,1,1]),s.uniform1i(this.u("uSection"),e.plane?1:0),s.uniform4fv(this.u("uPlane"),e.plane??[0,0,0,0]),s.uniform1f(this.u("uWiden"),e.widen??1);for(const o of t)s.bindVertexArray(o.vao),s.drawArraysInstanced(s.TRIANGLE_STRIP,0,4,o.count);s.bindVertexArray(null)}dispose(){this.gl.deleteProgram(this.program)}}function Ks(a){return new Worker(new URL(""+new URL("async_worker-CFyi6nEq.js",import.meta.url).href,import.meta.url),{type:"module",name:jt(a)})}/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Js(a){const t=new Set;for(const e of a.matchAll(/href\s*=\s*["']([^"'?#]+)\/["']/gi)){const s=decodeURIComponent(e[1]);s==="."||s===".."||s.includes("/")||s.includes(":")||t.add(s)}return[...t]}function Zs(a,t){const e=a.match(/^https:\/\/storage\.googleapis\.com\/([^/]+)\/(.*)$/);if(e===null)return;const s=e[2].endsWith("/")?e[2]:`${e[2]}/`,o=`prefix=${encodeURIComponent(s)}&delimiter=%2F&fields=prefixes%2CnextPageToken${t?`&pageToken=${encodeURIComponent(t)}`:""}`;return{url:`https://storage.googleapis.com/storage/v1/b/${e[1]}/o?${o}`,prefix:s}}async function Qs(a,t){const e=[];let s;for(let i=0;i<100;++i){const n=Zs(a,s);if(n===void 0)break;const r=await fetch(n.url,{signal:t});if(!r.ok)throw new Error(`${a}: listing failed (${r.status})`);const c=await r.json();for(const l of c.prefixes??[])l.startsWith(n.prefix)&&e.push(l.slice(n.prefix.length).replace(/\/$/,""));if(s=c.nextPageToken,s===void 0)return e.filter(l=>l!=="")}if(e.length>0)return e;const o=await fetch(a.endsWith("/")?a:`${a}/`,{signal:t});if(!o.ok||!/html/i.test(o.headers.get("Content-Type")??""))throw new Error(`${a}: no directory index`);return Js(await o.text())}function eo(a,t={}){return Vt({async read(e,s){const o={},i=s.byteRange;i!==void 0&&(o.Range="suffixLength"in i?`bytes=-${i.suffixLength}`:`bytes=${i.offset}-${i.offset+i.length-1}`);const n=await fetch(e,{headers:o,signal:s.signal});if(n.status===404||n.status===403)return;if(!n.ok)throw new Error(`${e}: ${n.status} ${n.statusText}`);let r=0;const l=n.headers.get("Content-Range")?.match(/bytes (\d+)-/);return n.status===206&&l?r=Number(l[1]):n.status===206&&i!==void 0&&"offset"in i&&(r=i.offset),{response:n,offset:r}},async list(e,s){if(!t.listing)throw new Error("listing is not supported over plain HTTP");return{directories:await Qs(e,s?.signal)}}},a)}function to(a,t){const e=t.map(i=>Math.ceil(Math.log2(i)));let s=0n,o=0n;for(let i=0;i<Math.max(...e);++i)for(let n=0;n<3;++n)i>=e[n]||(s|=BigInt(a[n]>>i&1)<<o,o+=1n);return s}function so(a,t){const e=t>>BigInt(a.preshift_bits),s=a.hash==="identity"?e:$t(0,e),o=Number(s&(1n<<BigInt(a.minishard_bits))-1n);return{shard:`${(s>>BigInt(a.minishard_bits)&(1n<<BigInt(a.shard_bits))-1n).toString(16).padStart(Math.ceil(a.shard_bits/4),"0")}.shard`,minishard:o}}function oo(a,t){const e=a.byteLength/24;if(!Number.isInteger(e))throw new Error(`a minishard index of ${a.byteLength} bytes`);const s=new DataView(a.buffer,a.byteOffset,a.byteLength),o=[],i=[],n=[];let r=0n,c=t;for(let l=0;l<e;++l){r+=s.getBigUint64(8*l,!0);const h=c+Number(s.getBigUint64(8*(e+l),!0));c=h+Number(s.getBigUint64(8*(2*e+l),!0)),o.push(r),i.push(h),n.push(c)}return{ids:o,starts:i,ends:n}}async function ht(a){const t=new Blob([a]).stream().pipeThrough(new DecompressionStream("gzip"));return new Uint8Array(await new Response(t).arrayBuffer())}const Ge=async(a,t,e)=>{const s={};t!==void 0&&(s.Range=`bytes=${t.offset}-${t.offset+t.length-1}`);const o=await fetch(a,{headers:s,signal:e});if(o.status===404||o.status===403)return;if(!o.ok)throw new Error(`${a}: ${o.status} ${o.statusText}`);const i=new Uint8Array(await o.arrayBuffer());return t!==void 0&&o.status===200&&i.byteLength>t.length?i.subarray(t.offset,t.offset+t.length):i};class io{constructor(t,e,s,o=Ge){this.url=t,this.scale=e,this.dataType=s,this.read=o,this.chunk=e.chunk_sizes[0],this.grid=[0,1,2].map(i=>Math.ceil(e.size[i]/this.chunk[i]))}chunk;grid;async readChunk(t,e){const{chunk:s,scale:o}=this;if(this.dataType!=="uint8")throw new Error(`${this.dataType} precomputed images are not drawn yet (uint8 only)`);if(o.encoding!=="raw"&&o.encoding!=="jpeg")throw new Error(`the ${o.encoding} encoding is not read yet (raw and jpeg only)`);const i=this.extent(t),n=await this.readBytes(t,e);if(n===void 0)return;const r=i[0]*i[1]*i[2];let c;if(o.encoding==="jpeg"){const l=new Ht;if(l.parse(n),l.width*l.height!==r)throw new Error(`a JPEG chunk of ${l.width} × ${l.height}, for ${i.join(" × ")} voxels`);c=l.getData(l.width,l.height,!1),l.numComponents!==1&&(c=c.filter((h,u)=>u%l.numComponents===0))}else if(c=n,c.byteLength<r)throw new Error(`a raw chunk of ${c.byteLength} bytes, for ${r} voxels`);return ut(c.subarray(0,r),i,s,new Uint8Array(s[0]*s[1]*s[2]))}async readLabels(t,e){const{chunk:s,scale:o}=this,i=await this.readBytes(t,e);if(i===void 0)return;const n=this.extent(t),r=n[0]*n[1]*n[2];let c;if(o.encoding==="compressed_segmentation"){const l=new Uint32Array(i.buffer.slice(i.byteOffset,i.byteOffset+(i.byteLength&-4)));if(c=new BigUint64Array(r),this.dataType==="uint64")Ke(c,l,0,[...n,1],o.compressed_segmentation_block_size??[8,8,8]);else{const h=Ke(new Uint32Array(r),l,0,[...n,1],o.compressed_segmentation_block_size??[8,8,8]);for(let u=0;u<r;++u)c[u]=BigInt(h[u])}}else if(o.encoding==="raw"){const l=i.slice(0,r*(this.dataType==="uint64"?8:4));if(this.dataType==="uint64")c=new BigUint64Array(l.buffer);else if(this.dataType==="uint32")c=BigUint64Array.from(new Uint32Array(l.buffer),h=>BigInt(h));else throw new Error(`${this.dataType} is not a segmentation type`)}else throw new Error(`the ${o.encoding} encoding is not read for segmentations (raw and compressed_segmentation only)`);return ut(c,n,s,new BigUint64Array(s[0]*s[1]*s[2]))}extent(t){return[0,1,2].map(e=>Math.min(this.chunk[e],this.scale.size[e]-t[e]*this.chunk[e]))}async readBytes(t,e){const{chunk:s,scale:o}=this;if(o.sharding!==void 0)return this.readSharded(to(t,this.grid),e);const i=o.voxel_offset??[0,0,0],n=[0,1,2].map(l=>t[l]*s[l]),r=this.extent(t),c=[0,1,2].map(l=>`${i[l]+n[l]}-${i[l]+n[l]+r[l]}`).join("_");return this.read(`${this.url}${o.key}/${c}`,void 0,e)}sharded;readSharded(t,e){return this.sharded??=new no(`${this.url}${this.scale.key}/`,this.scale.sharding,this.read),this.sharded.read(t,e)}}class no{constructor(t,e,s=Ge){this.folder=t,this.sharding=e,this.fetchRange=s}minishards=new Map;async read(t,e){const{shard:s,minishard:o}=so(this.sharding,t),i=`${this.folder}${s}`,n=`${s}#${o}`;let r=this.minishards.get(n);r===void 0&&(r=this.readMinishard(i,o,e),r.catch(()=>this.minishards.delete(n)),this.minishards.set(n,r));const c=await r;if(c===void 0)return;const l=c.ids.indexOf(t);if(l===-1)return;const h=await this.fetchRange(i,{offset:c.starts[l],length:c.ends[l]-c.starts[l]},e);if(h!==void 0)return this.sharding.data_encoding==="gzip"?ht(h):h}async readMinishard(t,e,s){const o=16*2**this.sharding.minishard_bits,i=await this.fetchRange(t,{offset:16*e,length:16},s);if(i===void 0)return;const n=new DataView(i.buffer,i.byteOffset,16),r=Number(n.getBigUint64(0,!0)),c=Number(n.getBigUint64(8,!0));if(r===c)return;let l=await this.fetchRange(t,{offset:o+r,length:c-r},s);if(l!==void 0)return this.sharding.minishard_index_encoding==="gzip"&&(l=await ht(l)),oo(l,o)}}async function ro(a,t=Ge,e,s){const o=await t(`${a}info`,void 0,e);if(o===void 0)throw new Error(`${a}: no info file`);const i=JSON.parse(new TextDecoder().decode(o)),n=i["@type"];if(n==="neuroglancer_skeletons")throw new Error(`${a}: precomputed skeletons, which have no spatial index to read a region from; use the segmentation volume of the same segments`);if(n==="neuroglancer_multilod_draco"||n==="neuroglancer_legacy_mesh")throw new Error(`${a}: precomputed meshes, which have no spatial index to read a region from; use the segmentation volume of the same segments`);if(i.num_channels!==1)throw new Error(`${a}: ${i.num_channels} channels (one only)`);return i}function ut(a,t,e,s){if(t[0]===e[0]&&t[1]===e[1]&&t[2]===e[2])return a;for(let o=0;o<t[2];++o)for(let i=0;i<t[1];++i){const n=(o*t[1]+i)*t[0];s.set(a.subarray(n,n+t[0]),(o*e[1]+i)*e[0])}return s}const ao=8;async function ae(a,t,e){let s=0;const o=async()=>{for(;s<a.length&&!t.aborted;)await e(a[s++])};await Promise.all(Array.from({length:Math.min(ao,a.length)},o)),t.throwIfAborted()}async function dt(a,t){const e=await fetch(a,{signal:t});if(!(e.status===404||e.status===403)){if(!e.ok)throw new Error(`${a}: ${e.status} ${e.statusText}`);return e.json()}}const ge={uint8:Uint8Array,int8:Int8Array,uint16:Uint16Array,int16:Int16Array,uint32:Uint32Array,int32:Int32Array,float32:Float32Array,float64:Float64Array},Le={uint64:"uint32",int64:"int32"};function ft(a,t){const e=Math.floor(a.byteLength/8),s=new DataView(a.buffer,a.byteOffset,a.byteLength),o=t==="uint64"?new Uint32Array(e):new Int32Array(e);for(let i=0;i<e;++i){const n=s.getUint32(8*i,!0),r=s.getInt32(8*i+4,!0);if(!(t==="uint64"?r===0:r===(n&2147483648?-1:0)))throw new Error(`a label of ${t==="uint64"?s.getBigUint64(8*i,!0):s.getBigInt64(8*i,!0)} is past what 32 bits hold`);o[i]=t==="uint64"?n:n|0}return new Uint8Array(o.buffer)}function ce(a,t){const e=ge[t],s=a.slice(0,a.byteLength-a.byteLength%e.BYTES_PER_ELEMENT);return new e(s.buffer)}function pt(a,[t,e]){const s=new Uint8Array(a.length),o=255/(e-t);for(let i=0;i<a.length;++i){const n=(a[i]-t)*o;s[i]=n<=0||n!==n?0:n>=255?255:n}return s}async function co(a,t,e,s){const o=await a(`${t}/zarr.json`,{signal:s});if(o===void 0)return;const i=JSON.parse(new TextDecoder().decode(o)),n=i?.codecs?.find(g=>g?.name==="transpose");if(n===void 0)return;const r=i.shape.length,c=n.configuration?.order,l=Array.isArray(c)?c.map(Number):c==="F"?[...Array(r).keys()].reverse():[...Array(r).keys()],h=i.chunk_grid.configuration.chunk_shape,u={...i,shape:l.map(g=>i.shape[g]),chunk_grid:{...i.chunk_grid,configuration:{...i.chunk_grid.configuration,chunk_shape:l.map(g=>h[g])}},codecs:i.codecs.filter(g=>g!==n),...Array.isArray(i.dimension_names)?{dimension_names:l.map(g=>i.dimension_names[g])}:{}},d=i.chunk_key_encoding?.configuration?.separator??"/",p=`${t}/c${d}`,w=new TextEncoder().encode(JSON.stringify(u));return{axes:l.map(g=>e[g]),read:async(g,v)=>{if(g===`${t}/zarr.json`)return w;if(g.startsWith(p)){const f=g.slice(p.length).split(d),b=new Array(f.length);return l.forEach((T,x)=>b[T]=f[x]),a(p+b.join(d),v)}return a(g,v)}}}class lo{constructor(t=256*1024*1024){this.cacheBytes=t}levels=[];cache=new Map;sizes=new Map;cached=0;remember(t,e){this.sizes.set(t,e),this.cached+=e;for(const[s]of this.cache){if(this.cached<=this.cacheBytes)break;s!==t&&(this.cached-=this.sizes.get(s)??0,this.sizes.delete(s),this.cache.delete(s))}}chunk(t,e){const s=`${t.info.url}${t.info.path}|${e.join(".")}`,o=this.cache.get(s);if(o!==void 0)return this.cache.delete(s),this.cache.set(s,o),o;const i=t.readChunk(e).then(n=>(this.remember(s,n?.byteLength??0),n));return i.catch(()=>this.cache.delete(s)),this.cache.set(s,i),i}async open(t,e,s){if(t.length===1&&t[0].startsWith(Ye))return this.openPrecomputed(t[0].slice(Ye.length),s);const o=await Promise.all(t.map(async c=>{const l=c.endsWith("/")?c:`${c}/`,h=await dt(`${l}zarr.json`,s)??await dt(`${l}.zattrs`,s);if(h===void 0)throw new Error(`${l}: no zarr.json`);if(h.attributes?.ngplatform?.rendering==="rgb")throw new Error("colour (RGB) images are not drawn as volumes yet");return Dt(l,h,e)})),i=Lt(o),n=new Map;this.levels=await Promise.all(i.map(async c=>{let l=n.get(c.url);l===void 0&&n.set(c.url,l={access:eo(c.url),shardIndexes:new Xt});const{access:h,shardIndexes:u}=l,d=await co(h.read,c.path,c.axes,s),p=d?.read??h.read;d!==void 0&&(c={...c,axes:d.axes});const w=await Wt(p,c.path,s);if(w===void 0)throw new Error(`${c.url}${c.path}: no array`);const g=w.elementType in Le?w.elementType:void 0;if(!(w.elementType in ge)&&g===void 0)throw new Error(`${c.url}${c.path}: ${w.elementType} images are not drawn`);if(w.shape.length!==3)throw new Error(`${c.url}${c.path}: ${w.shape.length}-D images are not drawn (3-D only)`);const v=[0,1,2].map(m=>c.axes.indexOf("xyz"[m])),f=w.readChunkShape,b={...c,shape:w.shape,chunk:f,size:[w.shape[v[0]],w.shape[v[1]],w.shape[v[2]]],type:g===void 0?w.elementType:Le[g]},T=new Gt(w,p,u),x=Number(w.fillValue??0),S=g===void 0?w.elementType:Le[g],y=async m=>{const E=await T.readChunk(m);return E===void 0||g===void 0?E:ft(E,g)};return{info:b,readChunk:async m=>{const E=await y(m);return E===void 0||S==="uint8"?E:pt(ce(E,S),this.window)},rawChunk:y,type:S,fill:Number.isFinite(x)?x:0,dimOf:v,grid:w.shape.map((m,E)=>Math.ceil(m/f[E]))}})),this.reset(),this.window=[0,255];const r=this.levels[this.levels.length-1];return r!==void 0&&r.type!=="uint8"&&(this.window=await this.windowOf(r,s)),{levels:this.levels.map(c=>c.info),name:o[0]?.name??"",description:o.find(c=>c.description)?.description}}window=[0,255];async windowOf(t,e){const s=[],o=[];for(let c=0;c<t.grid[0];++c)for(let l=0;l<t.grid[1];++l)for(let h=0;h<t.grid[2];++h)o.push([c,l,h]);const i=Math.max(1,Math.floor(o.length/64));for(let c=0;c<o.length;c+=i){e?.throwIfAborted();const l=await t.rawChunk?.(o[c]).catch(()=>{});if(l===void 0)continue;const h=ce(l,t.type),u=Math.max(1,Math.floor(h.length/2e4));for(let d=0;d<h.length;d+=u)Number.isFinite(h[d])&&s.push(h[d])}if(s.length===0)return[0,1];s.sort((c,l)=>c-l);const n=s[Math.floor(.005*(s.length-1))],r=s[Math.ceil(.995*(s.length-1))];return r>n?[n,r]:[n,n+1]}async openPrecomputed(t,e){const s=await ro(t,void 0,e);if(s.type!=="image"&&s.type!=="segmentation")throw new Error(`${t}: a precomputed ${s.type??"source"}, not an image or segmentation`);const o=s.type==="segmentation";return this.levels=s.scales.map(i=>{const n=new io(t,i,s.data_type),[r,c,l]=n.chunk,[h,u,d]=i.size,p={...Ot(t,i),shape:[d,u,h],chunk:[l,c,r],size:[h,u,d]},w={fill:0,dimOf:[2,1,0],grid:[n.grid[2],n.grid[1],n.grid[0]]};if(!o)return{info:p,readChunk:([v,f,b])=>n.readChunk([b,f,v]),type:"uint8",...w};const g=async([v,f,b])=>{const T=await n.readLabels([b,f,v]);return T&&ft(new Uint8Array(T.buffer,T.byteOffset,T.byteLength),"uint64")};return{info:{...p,type:"uint32"},readChunk:async v=>{const f=await g(v);return f&&pt(ce(f,"uint32"),this.window)},rawChunk:g,type:"uint32",...w}}).sort((i,n)=>i.info.voxelSize-n.info.voxelSize),this.reset(),this.window=[0,255],{levels:this.levels.map(i=>i.info),name:t.replace(/\/$/,"").split("/").pop()??""}}reset(){this.cache.clear(),this.sizes.clear(),this.cached=0}async volume(t,e,s,o){const i=this.levels[t],{chunk:n,shape:r}=i.info,{dimOf:c}=i,l=o?.lo??[0,0,0],h=o?.hi??i.info.size,u=[0,1,2].map(y=>Math.max(0,h[y]-l[y])),d=new Uint8Array(u[0]*u[1]*u[2]).fill(i.fill),p=[0,0,0],w=[0,0,0],g=[0,0,0],v=[1,u[0],u[0]*u[1]];for(let y=0;y<3;++y)p[c[y]]=Math.max(0,l[y]),w[c[y]]=Math.min(r[c[y]],h[y]),g[c[y]]=v[y];const f=[0,0,0];for(let y=0;y<3;++y)f[c[y]]=l[y];const b=[0,1,2].map(y=>Math.floor(p[y]/n[y])),T=[0,1,2].map(y=>Math.ceil(w[y]/n[y])-1),x=[];for(let y=b[0];y<=T[0];++y)for(let m=b[1];m<=T[1];++m)for(let E=b[2];E<=T[2];++E)x.push([y,m,E]);let S=0;return await ae(x,e,async y=>{const m=await this.chunk(i,y);if(m!==void 0){const E=[0,1,2].map(F=>y[F]*n[F]),A=[0,1,2].map(F=>Math.max(E[F],p[F])),R=[0,1,2].map(F=>Math.min(E[F]+n[F],w[F])),B=R[2]-A[2];for(let F=A[0];F<R[0];++F)for(let _=A[1];_<R[1];++_){let D=((F-E[0])*n[1]+(_-E[1]))*n[2]+(A[2]-E[2]),M=(F-f[0])*g[0]+(_-f[1])*g[1]+(A[2]-f[2])*g[2];if(g[2]===1)d.set(m.subarray(D,D+B),M);else for(let C=0;C<B;++C,++D,M+=g[2])d[M]=m[D]}}s?.(++S,x.length)}),{data:d,size:u}}async rawVolume(t,e,s){const o=this.levels[t],{chunk:i,shape:n,size:r}=o.info,{dimOf:c,type:l}=o,h=ge[l].BYTES_PER_ELEMENT,u=new Uint8Array(r[0]*r[1]*r[2]*h);o.fill!==0&&new ge[l](u.buffer).fill(o.fill);const d=[0,0,0],p=[1,r[0],r[0]*r[1]];for(let f=0;f<3;++f)d[c[f]]=p[f];const w=o.rawChunk??o.readChunk,g=[];for(let f=0;f<o.grid[0];++f)for(let b=0;b<o.grid[1];++b)for(let T=0;T<o.grid[2];++T)g.push([f,b,T]);let v=0;return await ae(g,e,async f=>{const b=await w(f);if(b!==void 0){const T=[0,1,2].map(y=>f[y]*i[y]),x=[0,1,2].map(y=>Math.min(T[y]+i[y],n[y])),S=x[2]-T[2];for(let y=T[0];y<x[0];++y)for(let m=T[1];m<x[1];++m){const E=((y-T[0])*i[1]+(m-T[1]))*i[2],A=y*d[0]+m*d[1]+T[2]*d[2];if(d[2]===1)u.set(b.subarray(E*h,(E+S)*h),A*h);else for(let R=0;R<S;++R)u.set(b.subarray((E+R)*h,(E+R+1)*h),(A+R*d[2])*h)}}s?.(++v,g.length)}),{data:u,size:r,type:l,fill:o.fill}}async eachRawChunk(t,e,s,o,i){const n=this.levels[t],{chunk:r,shape:c,size:l}=n.info,{dimOf:h,type:u}=n,d=i?.lo??[0,0,0],p=i?.hi??l,w=[0,0,0],g=[0,0,0];for(let m=0;m<3;++m)w[h[m]]=Math.max(0,d[m]),g[h[m]]=Math.min(c[h[m]],p[m]);if(w.some((m,E)=>m>=g[E]))return;const v=[r[1]*r[2],r[2],1],f=[0,1,2].map(m=>v[h[m]]),b=n.rawChunk??n.readChunk,T=[0,1,2].map(m=>Math.floor(w[m]/r[m])),x=[0,1,2].map(m=>Math.ceil(g[m]/r[m])-1),S=[];for(let m=T[0];m<=x[0];++m)for(let E=T[1];E<=x[1];++E)for(let A=T[2];A<=x[2];++A)S.push([m,E,A]);let y=0;await ae(S,e,async m=>{const E=await b(m);if(E!==void 0&&!e.aborted){const A=ce(E,n.rawChunk?u:"uint8"),R=[0,1,2].map(_=>Math.max(m[_]*r[_],w[_])),B=[0,1,2].map(_=>Math.min((m[_]+1)*r[_],g[_])),F=(R[0]-m[0]*r[0])*v[0]+(R[1]-m[1]*r[1])*v[1]+(R[2]-m[2]*r[2]);s(A,{lo:[0,1,2].map(_=>R[h[_]]),hi:[0,1,2].map(_=>B[h[_]]),start:F,stride:f})}o?.(++y,S.length)})}rawRegion(t,e,s,o){return this.region(t,e,s,o,i=>new Float32Array(i))}exactRegion(t,e,s,o){return this.region(t,e,s,o,i=>new Float64Array(i))}async region(t,e,s,o,i){const n=this.levels[t],{chunk:r,shape:c}=n.info,{dimOf:l,type:h}=n,u=[0,1,2].map(m=>Math.max(0,e.hi[m]-e.lo[m])),d=i(u[0]*u[1]*u[2]);d.fill(NaN);const p=[0,0,0],w=[0,0,0],g=[0,0,0],v=[1,u[0],u[0]*u[1]],f=[0,0,0];for(let m=0;m<3;++m)p[l[m]]=Math.max(0,e.lo[m]),w[l[m]]=Math.min(c[l[m]],e.hi[m]),g[l[m]]=v[m],f[l[m]]=e.lo[m];if(p.some((m,E)=>m>=w[E]))return{data:d,size:u};for(let m=p[0];m<w[0];++m)for(let E=p[1];E<w[1];++E)for(let A=p[2];A<w[2];++A)d[(m-f[0])*g[0]+(E-f[1])*g[1]+(A-f[2])*g[2]]=n.fill;const b=n.rawChunk??n.readChunk,T=[0,1,2].map(m=>Math.floor(p[m]/r[m])),x=[0,1,2].map(m=>Math.ceil(w[m]/r[m])-1),S=[];for(let m=T[0];m<=x[0];++m)for(let E=T[1];E<=x[1];++E)for(let A=T[2];A<=x[2];++A)S.push([m,E,A]);let y=0;return await ae(S,s,async m=>{const E=await b(m);if(E!==void 0){const A=ce(E,n.rawChunk?h:"uint8"),R=[0,1,2].map(_=>m[_]*r[_]),B=[0,1,2].map(_=>Math.max(R[_],p[_])),F=[0,1,2].map(_=>Math.min(R[_]+r[_],w[_]));for(let _=B[0];_<F[0];++_)for(let D=B[1];D<F[1];++D){let M=((_-R[0])*r[1]+(D-R[1]))*r[2]+(B[2]-R[2]),C=(_-f[0])*g[0]+(D-f[1])*g[1]+(B[2]-f[2])*g[2];for(let N=B[2];N<F[2];++N,++M,C+=g[2])d[C]=A[M]}}o?.(++y,S.length)}),{data:d,size:u}}async rawPoints(t,e,s,o){const i=this.levels[t],{chunk:n,shape:r,size:c}=i.info,{dimOf:l,type:h}=i,u=e.length/3,d=new Float64Array(u).fill(NaN),p=(x,S,y)=>x+c[0]*(S+c[1]*y),w=(x,S,y)=>x>=0&&S>=0&&y>=0&&x<c[0]&&S<c[1]&&y<c[2],g=new Map,v=s==="nearest"?1:8;for(let x=0;x<u;++x){const S=[e[3*x],e[3*x+1],e[3*x+2]],y=s==="nearest"?S.map(Math.round):S.map(Math.floor);for(let m=0;m<v;++m){const E=y[0]+(m&1),A=y[1]+(m>>1&1),R=y[2]+(m>>2&1);w(E,A,R)&&g.set(p(E,A,R),i.fill)}}const f=new Map;for(const x of g.keys()){const S=[x%c[0],Math.floor(x/c[0])%c[1],Math.floor(x/(c[0]*c[1]))],y=[0,0,0];for(let R=0;R<3;++R)y[l[R]]=S[R];const m=y.map((R,B)=>Math.floor(R/n[B])),E=m.join(".");let A=f.get(E);A===void 0&&f.set(E,A={index:m,voxels:[]}),A.voxels.push(S)}const b=i.rawChunk??i.readChunk;await ae([...f.values()],o,async({index:x,voxels:S})=>{const y=await b(x);if(y===void 0)return;const m=ce(y,i.rawChunk?h:"uint8");for(const E of S){const A=[0,0,0];for(let R=0;R<3;++R)A[l[R]]=E[R];A.some((R,B)=>R>=r[B])||g.set(p(E[0],E[1],E[2]),m[((A[0]-x[0]*n[0])*n[1]+(A[1]-x[1]*n[1]))*n[2]+(A[2]-x[2]*n[2])])}});const T=(x,S,y)=>w(x,S,y)?g.get(p(x,S,y))??NaN:NaN;for(let x=0;x<u;++x){const S=e[3*x],y=e[3*x+1],m=e[3*x+2];if(s==="nearest"){d[x]=T(Math.round(S),Math.round(y),Math.round(m));continue}const E=Math.floor(S),A=Math.floor(y),R=Math.floor(m),B=[S-E,y-A,m-R];let F=0,_=0;for(let D=0;D<8;++D){const M=[D&1,D>>1&1,D>>2&1],C=(M[0]?B[0]:1-B[0])*(M[1]?B[1]:1-B[1])*(M[2]?B[2]:1-B[2]);if(C===0)continue;const N=T(E+M[0],A+M[1],R+M[2]);N===N&&(F+=C*N,_+=C)}d[x]=_>0?F/_:NaN}return d}async plane(t,e,s,o,i){const n=this.levels[t],{dimOf:r,grid:c}=n,{chunk:l,shape:h}=n.info,{axis:u,value:d,rect:p,texel:w}=e,[g,v]=[0,1,2].filter(L=>L!==u),f=Math.max(1,Math.min(4096,Math.round((p[1]-p[0])/w))),b=Math.max(1,Math.min(4096,Math.round((p[3]-p[2])/w))),T=(p[1]-p[0])/f,x=(p[3]-p[2])/b,S=Ut(n.info.voxelToRas),y=(L,U)=>{const O=[0,0,0];return O[u]=d,O[g]=L,O[v]=U,[0,1,2].map(V=>S[4*V]*O[0]+S[4*V+1]*O[1]+S[4*V+2]*O[2]+S[4*V+3])},m=y(p[0]+T/2,p[2]+x/2),E=y(p[0]+T/2+T,p[2]+x/2),A=y(p[0]+T/2,p[2]+x/2+x),R=[0,1,2].map(L=>E[L]-m[L]),B=[0,1,2].map(L=>A[L]-m[L]),F=new Uint8Array(f*b).fill(n.fill),_=new Int32Array(f*b).fill(-1),D=new Uint32Array(f*b),M=new Map,C=[l[1]*l[2],l[2],1],N=[0,0,0];for(let L=0;L<b;++L)for(let U=0;U<f;++U){let O=!0;for(let I=0;I<3;++I){const $=Math.round(m[I]+U*R[I]+L*B[I]),W=r[I];if($<0||$>=h[W]){O=!1;break}N[W]=$}if(!O)continue;const V=Math.floor(N[0]/l[0]),ee=Math.floor(N[1]/l[1]),K=Math.floor(N[2]/l[2]),J=(V*c[1]+ee)*c[2]+K,te=L*f+U;_[te]=J,D[te]=(N[0]-V*l[0])*C[0]+(N[1]-ee*l[1])*C[1]+(N[2]-K*l[2])*C[2],M.set(J,(M.get(J)??0)+1)}const X=new Map,H=new Map;for(const[L,U]of M)X.set(L,new Uint32Array(U));for(let L=0;L<_.length;++L){const U=_[L];if(U<0)continue;const O=H.get(U)??0;X.get(U)[O]=L,H.set(U,O+1)}const q=L=>[Math.floor(L/(c[1]*c[2])),Math.floor(L/c[2])%c[1],L%c[2]],j=[...X.keys()],P=_[(b>>1)*f+(f>>1)];if(P>=0){const L=q(P),U=O=>q(O).reduce((V,ee,K)=>V+(ee-L[K])**2,0);j.sort((O,V)=>U(O)-U(V))}let Z=0,Q=performance.now();return await ae(j,s,async L=>{const U=await this.chunk(n,q(L));if(!s.aborted){if(U!==void 0)for(const O of X.get(L))F[O]=U[D[O]];o?.(++Z,j.length),i!==void 0&&Z<j.length&&performance.now()-Q>400&&(Q=performance.now(),i({data:F.slice(),width:f,height:b}))}}),{data:F,width:f,height:b}}}const pe=1/12;function ho(a,t,e,s=.5){const[o,i,n]=t,r=t.map(v=>Math.ceil(v/e)),c=r[0]*r[1]*r[2],l=new Float32Array(3*c),h=new Float32Array(6*c),u=new Float32Array(c),d=new Float32Array(c);let p=0;const w=e*e/12+pe,g=e**3/Math.sqrt((2*Math.PI)**3*w**3);for(let v=0;v<r[2];++v)for(let f=0;f<r[1];++f)for(let b=0;b<r[0];++b){const T=b*e,x=f*e,S=v*e,y=Math.min(o,T+e),m=Math.min(i,x+e),E=Math.min(n,S+e);let A=0,R=0,B=0,F=0,_=0,D=0,M=0,C=0,N=0,X=0;for(let K=S;K<E;++K){const J=K-S;for(let te=x;te<m;++te){const I=te-x;let $=T+o*(te+i*K);for(let W=T;W<y;++W,++$){const z=a[$];if(!(z>0))continue;const ie=W-T;A+=z,R+=z*ie,B+=z*I,F+=z*J,_+=z*ie*ie,D+=z*ie*I,M+=z*ie*J,C+=z*I*I,N+=z*I*J,X+=z*J*J}}}if(A<s)continue;const H=R/A,q=B/A,j=F/A;l[3*p]=T+H,l[3*p+1]=x+q,l[3*p+2]=S+j;const P=6*p;h[P]=_/A-H*H+pe,h[P+1]=D/A-H*q,h[P+2]=M/A-H*j,h[P+3]=C/A-q*q+pe,h[P+4]=N/A-q*j,h[P+5]=X/A-j*j+pe;const[Z,Q,L,U,O,V]=h.subarray(P,P+6),ee=Z*(U*V-O*O)-Q*(Q*V-O*L)+L*(Q*O-U*L);u[p]=Math.min(1,A/Math.sqrt((2*Math.PI)**3*Math.max(ee,1e-12))/g),d[p]=A,++p}return{centres:l.slice(0,3*p),covariances:h.slice(0,6*p),weights:u.slice(0,p),masses:d.slice(0,p),count:p}}function uo(a,t){const e=t,s=new Float32Array(a.centres.length),o=new Float32Array(a.covariances.length);for(let i=0;i<a.count;++i){const n=[a.centres[3*i],a.centres[3*i+1],a.centres[3*i+2]];for(let u=0;u<3;++u)s[3*i+u]=e[4*u]*n[0]+e[4*u+1]*n[1]+e[4*u+2]*n[2]+e[4*u+3];const r=a.covariances.subarray(6*i,6*i+6),c=[[r[0],r[1],r[2]],[r[1],r[3],r[4]],[r[2],r[4],r[5]]],l=[0,1,2].map(u=>[0,1,2].map(d=>e[4*u]*c[0][d]+e[4*u+1]*c[1][d]+e[4*u+2]*c[2][d])),h=(u,d)=>l[u][0]*e[4*d]+l[u][1]*e[4*d+1]+l[u][2]*e[4*d+2];o.set([h(0,0),h(0,1),h(0,2),h(1,1),h(1,2),h(2,2)],6*i)}return{...a,centres:s,covariances:o}}zt(()=>Ks(["org.ngplatform.zarr-vectors"]));const Pe=32,He=4,fo=.08,po=4,$e=new lo;let de,Ft=0,ze=[];const be=new Set;let Oe=0;const le=(a,t=[])=>self.postMessage(a,t);async function vo(a){const{levels:t}=await $e.open([a],void 0),e=await $e.volume(t.length-1,new AbortController().signal),s=It(e.data,e.size),o=s<128;Ft=(o?s:255-s)/255,de={levels:t.map(i=>({size:i.size,voxelToRas:Array.from(i.voxelToRas),voxelSize:i.voxelSize})),darkBackground:o},le({type:"opened",info:de}),qe()}async function mo(a){const[t,e]=a.split("|"),s=Number(t),o=de.levels[s],n=e.split(".").map(Number).map(f=>f*Pe),r=n.map((f,b)=>Math.min(o.size[b],f+Pe));if(n.some((f,b)=>f>=r[b]||f<0)){le({type:"empty",key:a});return}const{data:c,size:l}=await $e.volume(s,new AbortController().signal,void 0,{lo:n,hi:r}),h=Ft+fo,u=1/Math.max(.001,1-h),d=de.darkBackground,p=new Float32Array(c.length);for(let f=0;f<c.length;++f){const b=(d?c[f]:255-c[f])/255;p[f]=b>h?(b-h)*u:0}const w=ho(p,l,He);if(w.count===0){le({type:"empty",key:a});return}const g=o.voxelToRas.slice();for(let f=0;f<3;++f)g[4*f+3]+=g[4*f]*n[0]+g[4*f+1]*n[1]+g[4*f+2]*n[2];const v=uo(w,g);le({type:"splats",key:a,centres:v.centres,covariances:v.covariances,weights:v.weights},[v.centres.buffer,v.covariances.buffer,v.weights.buffer])}function qe(){for(;Oe<po&&ze.length>0;){const a=ze.shift();be.has(a)||(be.add(a),Oe++,mo(a).catch(t=>le({type:"error",key:a,message:t.message})).finally(()=>{be.delete(a),Oe--,qe()}))}}self.onmessage=a=>{const t=a.data;t.type==="open"?vo(t.store).catch(e=>le({type:"error",message:e.message})):t.type==="want"&&(ze=t.keys.filter(e=>!be.has(e)),de!==void 0&&qe())};const vt=256*1024*1024,go=3,bo=12/(2*Math.PI)*1.4,wo=a=>Float32Array.from({length:16},(t,e)=>a[4*(e%4)+Math.floor(e/4)]);class yo{constructor(t){this.view=t,this.overlay=t.ctx.ui.overlay(),this.canvas=document.createElement("canvas"),this.canvas.className="luxar-canvas",this.canvas.style.mixBlendMode="plus-lighter",this.overlay.element.append(this.canvas),this.offRendered=t.ctx.viewer.onRendered(()=>this.schedule()),this.offScreenshot=t.ctx.ui.screenshotOverlay((e,s)=>this.paint(e,s)),this.canvas.addEventListener("webglcontextlost",e=>{e.preventDefault(),this.renderer=this.composite=this.target=void 0,this.gpu.clear(),this.gpuBytes=0}),this.canvas.addEventListener("webglcontextrestored",()=>{this.gl=null,this.schedule()})}overlay;canvas;gl=null;renderer;composite;target;bloom;gpu=new Map;gpuBytes=0;frame=0;visible=!0;queued=!1;offRendered;offScreenshot;selections=[];problem;setVisible(t){this.visible=t,this.canvas.style.display=t?"":"none",this.schedule()}schedule(){this.queued||(this.queued=!0,requestAnimationFrame(()=>{this.queued=!1;try{this.render()}catch(t){this.problem=`2-D views: ${t.message}`}}))}context(){if(this.gl===null){if(this.gl=this.canvas.getContext("webgl2",{alpha:!0,premultipliedAlpha:!0,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!0}),this.gl===null)return this.problem="No WebGL2 for the 2-D views.",null;this.renderer=new Bt(this.gl),this.composite=new Re(this.gl),this.target=new _e(this.gl,this.composite.floatTargets),this.bloom=new Ae(this.composite,this.composite.floatTargets)}return this.gl}render(){const{view:t}=this,e=t.info,s=this.visible?t.ctx.viewer.panels().filter(E=>E.kind==="2d"):[],o=s.length>0&&e!==void 0?this.context():this.gl;if(o===null)return;const i=this.overlay.element.getBoundingClientRect(),n=globalThis.devicePixelRatio||1,r=Math.max(1,Math.round(i.width*n)),c=Math.max(1,Math.round(i.height*n));if((this.canvas.width!==r||this.canvas.height!==c)&&(this.canvas.width=r,this.canvas.height=c),o.bindFramebuffer(o.FRAMEBUFFER,null),o.viewport(0,0,r,c),o.clearColor(0,0,0,0),o.clear(o.COLOR_BUFFER_BIT),e===void 0||s.length===0||this.renderer===void 0){t.want("2d",[]);return}const l=t.ctx.viewer.getState(),h=l.dimensions??{},u=Object.keys(h),d={names:u,scales:u.map(E=>h[E][0]),units:u.map(E=>h[E][1]),position:u.map((E,A)=>l.position?.[A]??0)},p=t.style,w=wo(e.levels[0].voxelToRas),g=t.storeInfo(e),v=Math.max(p.slab/2,2*He*e.levels[0].voxelSize),f=this.target;if(!f.bind(r,c,null)){this.problem="This GPU cannot add light up in a float target here.";return}o.viewport(0,0,r,c),o.clearColor(0,0,0,0),o.clear(o.COLOR_BUFFER_BIT),o.enable(o.SCISSOR_TEST),o.disable(o.DEPTH_TEST),o.enable(o.BLEND),o.blendFunc(o.ONE,o.ONE),++this.frame;const b=[],T=[];for(const E of s){const A=this.drawPanel(E,d,i,n,g,w,v);A!==void 0&&(b.push(A),T.push(A.want))}o.disable(o.SCISSOR_TEST);const x=[],S=new Set;for(let E=0;T.some(A=>E<A.length);++E)for(const A of T){const R=A[E];R!==void 0&&!S.has(R)&&(S.add(R),x.push(R))}t.want("2d",x),this.selections=b,this.evict();const y=t.style.bloom,m=y>0?this.bloom.run(f.texture,r,c,!1):void 0;o.bindFramebuffer(o.FRAMEBUFFER,null),o.viewport(0,0,r,c),o.enable(o.BLEND),o.blendFunc(o.ONE,o.ONE),this.composite.composite(f.texture,{color:0},{toneMap:We.clamp,emission:!1,origin:[0,0],bloom:m&&{textures:m,amount:y}}),o.disable(o.BLEND)}drawPanel(t,e,s,o,i,n,r){const c=this.gl,l=this.view,h=l.info,u=t.element.getBoundingClientRect();if(u.width<2||u.height<2)return;const d=At(B=>t.project(B),e.position);if(d===void 0)return;const p=ns(e,d),w=rs(p);if(w===void 0)return;const g=B=>{const F=new Float64Array(16);if(F[0]=2/u.width,F[12]=-1,F[5]=-2/u.height,F[13]=1,F[15]=1,B){const _=Math.hypot(p[2],p[6],p[10]);F[10]=.999/(_*r)}return F},v=se(g(!1),p),f=se(se(g(!0),p),n),b=xe(se(p,n)),T=b?oe(b,[u.width/2,u.height/2,0]).slice(0,3):h.levels[0].size.map(B=>B/2),x=Te(i,(B,F)=>he(f,B,F),T,l.style.detail*1e6,B=>l.arrived(B)),S=new Map;for(const B of x.draw){const F=this.upload(B);if(F===void 0)continue;const _=Number(B.split("|")[0]);S.set(_,[...S.get(_)??[],F])}const y=Math.round((u.left-s.left)*o),m=Math.round((s.bottom-u.bottom)*o),E=Math.round(u.width*o),A=Math.round(u.height*o);c.viewport(y,m,E,A),c.scissor(y,m,E,A);const R=l.style;for(const B of S.values())this.renderer.draw(B,{modelToClip:Float32Array.from(v),viewport:[E,A],gain:2**R.exposure*bo,widen:go,absorption:0,colormap:Xe[R.colormap],colour:R.colourBy==="solid"?Ve(R.colour):void 0,plane:w});return x}upload(t){const e=this.gpu.get(t);if(e!==void 0)return e.used=this.frame,e.splats;const s=this.view.blockData(t);if(s===void 0||this.renderer===void 0)return;const o=this.renderer.upload(s.centres,s.covariances,s.weights);return this.gpu.set(t,{splats:o,used:this.frame}),this.gpuBytes+=o.bytes,o}evict(){if(this.gpuBytes<=vt)return;const t=[...this.gpu.entries()].sort((e,s)=>e[1].used-s[1].used);for(const[e,s]of t){if(this.gpuBytes<=vt*.8||s.used===this.frame)break;this.renderer.release(s.splats),this.gpuBytes-=s.splats.bytes,this.gpu.delete(e)}}paint(t,e){if(!this.visible||this.gl===null)return;const s=e.getBoundingClientRect(),o=e.width/Math.max(1,s.width),i=this.overlay.element.getBoundingClientRect();t.save(),t.globalCompositeOperation="lighter",t.drawImage(this.canvas,(i.left-s.left)*o,(i.top-s.top)*o,i.width*o,i.height*o),t.restore()}dispose(){this.offScreenshot(),this.offRendered();for(const t of this.gpu.values())this.renderer?.release(t.splats);this.gpu.clear(),this.target?.release(),this.bloom?.release(),this.renderer?.dispose(),this.composite?.dispose(),this.overlay.dispose(),this.gl?.getExtension("WEBGL_lose_context")?.loseContext()}}const mt=512*1024*1024,gt=.5,Eo=.3,xo=.3,ve=a=>Float32Array.from({length:16},(t,e)=>a[4*(e%4)+Math.floor(e/4)]);class Ue{constructor(t,e,s,o){this.ctx=t,this.name=e,this.storeUrl=s,this.style=o,this.worker=new Worker(new URL(""+new URL("splat_worker-Cij354wj.js",import.meta.url).href,import.meta.url),{type:"module",name:"luxar splats"}),this.worker.onmessage=i=>{const n=i.data;n.type==="opened"?this.info=n.info:n.type==="splats"?this.blocks.set(n.key,{data:n,used:this.frame}):n.type==="empty"?this.empty.add(n.key):n.type==="error"&&(this.error=n.message),this.handle.redraw(),this.view2d.schedule(),this.onStatus?.()},this.worker.postMessage({type:"open",store:s}),this.handle=t.viewer.draw3d(e,{draw:i=>this.draw(i),isReady:()=>this.selection===void 0||this.selection.complete,afterSections:!0,dispose:()=>this.release()}),this.view2d=new yo(this)}worker;info;error;blocks=new Map;empty=new Set;wanted=[];wants=new Map;view2d;renderer;composite;target;bloom;gl;gpuBytes=0;frame=0;selection;problem;handle;offs=[];onStatus;setStyle(t){this.style=t,this.handle.redraw(),this.view2d.schedule()}setVisible(t){this.view2d.setVisible(t)}arrived(t){return this.blocks.has(t)||this.empty.has(t)}blockData(t){const e=this.blocks.get(t);return e!==void 0&&(e.used=this.frame),e?.data}want(t,e){this.wants.set(t,e.filter(o=>!this.arrived(o)));const s=[...new Set([...this.wants.get("3d")??[],...this.wants.get("2d")??[]])];s.join()!==this.wanted.join()&&(this.wanted=s,this.worker.postMessage({type:"want",keys:s}))}storeInfo(t){const e=t.levels[0],s=(o,i)=>Math.hypot(o[i],o[4+i],o[8+i]);return{bounds:{lower:[0,0,0],upper:e.size.slice()},levels:t.levels.map((o,i)=>({index:i,chunkShape:[0,1,2].map(n=>Pe*(s(o.voxelToRas,n)/s(e.voxelToRas,n))),vertexCount:Math.round(o.size.reduce((n,r)=>n*Math.ceil(r/He),1)*xo)}))}}release(){for(const t of this.blocks.values())t.gpu&&this.renderer?.release(t.gpu);for(const t of this.blocks.values())t.gpu=void 0;this.gpuBytes=0,this.target?.release(),this.bloom?.release(),this.renderer?.dispose(),this.composite?.dispose(),this.renderer=this.composite=this.target=this.bloom=void 0,this.gl=void 0}draw(t){const{gl:e}=t,s=this.info;if(s===void 0)return;this.gl!==e&&(this.release(),this.gl=e,this.renderer=new Bt(e),this.composite=new Re(e),this.target=new _e(e,this.composite.floatTargets),this.bloom=new Ae(this.composite,this.composite.floatTargets));const o=Pt(t.dimensions);if(o===void 0){this.problem=`The 3-D view shows ${t.dimensions.names.join(", ")}; splats need x, y and z.`;return}this.problem=void 0,++this.frame;const i=se(t.viewProjection,ve(o)),n=se(i,ve(s.levels[0].voxelToRas)),r=xe(se(ve(o),ve(s.levels[0].voxelToRas))),c=r?oe(r,t.position).slice(0,3):s.levels[0].size.map(f=>f/2),l=this.storeInfo(s),h=Te(l,(f,b)=>he(n,f,b),c,this.style.detail*1e6,f=>this.arrived(f));this.selection=h,this.want("3d",h.want);const u=new Map;for(const f of h.draw){const b=this.blocks.get(f);if(b!==void 0&&(b.used=this.frame,b.gpu===void 0&&b.data!==void 0&&(b.gpu=this.renderer.upload(b.data.centres,b.data.covariances,b.data.weights),this.gpuBytes+=b.gpu.bytes),b.gpu)){const T=Number(f.split("|")[0]);u.set(T,[...u.get(T)??[],b.gpu])}}if(this.evict(),this.onStatus?.(),u.size===0)return;const d={framebuffer:e.getParameter(e.DRAW_FRAMEBUFFER_BINDING),viewport:e.getParameter(e.VIEWPORT),drawBuffers:[0,1,2,3].map(f=>e.getParameter(e.DRAW_BUFFER0+f)),blend:e.isEnabled(e.BLEND),depthTest:e.isEnabled(e.DEPTH_TEST),depthMask:e.getParameter(e.DEPTH_WRITEMASK),depthFunc:e.getParameter(e.DEPTH_FUNC),stencil:e.isEnabled(e.STENCIL_TEST),scissor:e.isEnabled(e.SCISSOR_TEST)};for(;d.drawBuffers.length>1&&d.drawBuffers[d.drawBuffers.length-1]===e.NONE;)d.drawBuffers.pop();const[p,w,g,v]=d.viewport;try{const f=e.getFramebufferAttachmentParameter(e.DRAW_FRAMEBUFFER,e.DEPTH_STENCIL_ATTACHMENT,e.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME)??null;if(!this.target.bind(g,v,f)){this.problem="This GPU cannot add light up in a float target here.";return}e.viewport(0,0,g,v),e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT),e.disable(e.STENCIL_TEST),e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE),e.depthMask(!1),e.enable(e.DEPTH_TEST),e.depthFunc(e.LEQUAL);const b=this.style,T=b.blending==="emission";for(const[S,y]of u)this.renderer.draw(y,{modelToClip:Float32Array.from(i),viewport:[g,v],gain:2**b.exposure*gt*(s.levels[S].voxelSize/s.levels[0].voxelSize)*(T?Math.max(b.absorption,.05):Eo),absorption:T?b.absorption*gt*(s.levels[S].voxelSize/s.levels[0].voxelSize):0,colormap:Xe[b.colormap],colour:b.colourBy==="solid"?Ve(b.colour):void 0});const x=b.bloom>0?this.bloom.run(this.target.texture,g,v,T):void 0;e.enable(e.BLEND),e.bindFramebuffer(e.FRAMEBUFFER,d.framebuffer),e.viewport(p,w,g,v),e.drawBuffers(d.drawBuffers.map((S,y)=>y===t.outputs.color?S:e.NONE)),e.disable(e.DEPTH_TEST),T?e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA):e.blendFuncSeparate(e.ONE,e.ONE,e.ONE,e.ONE_MINUS_SRC_ALPHA),this.composite.composite(this.target.texture,t.outputs,{toneMap:We[b.toneMap],emission:T,origin:[p,w],bloom:x&&{textures:x,amount:b.bloom}})}finally{e.bindFramebuffer(e.FRAMEBUFFER,d.framebuffer),e.drawBuffers(d.drawBuffers),e.viewport(p,w,g,v),d.blend?e.enable(e.BLEND):e.disable(e.BLEND),d.depthTest?e.enable(e.DEPTH_TEST):e.disable(e.DEPTH_TEST),e.depthMask(d.depthMask),e.depthFunc(d.depthFunc),d.stencil&&e.enable(e.STENCIL_TEST),d.scissor&&e.enable(e.SCISSOR_TEST),e.blendFunc(e.ONE,e.ZERO)}}evict(){if(this.gpuBytes<=mt)return;const t=[...this.blocks.entries()].filter(([,e])=>e.gpu!==void 0).sort((e,s)=>e[1].used-s[1].used);for(const[e,s]of t){if(this.gpuBytes<=mt*.8||s.used>=this.frame-1)break;this.renderer.release(s.gpu),this.gpuBytes-=s.gpu.bytes,this.blocks.delete(e)}}status(){if(this.error!==void 0&&this.info===void 0)return`Could not open the image: ${this.error}`;if(this.info===void 0)return"Opening the image…";if(this.problem)return this.problem;if(this.view2d.problem)return this.view2d.problem;const t=this.selection??this.view2d.selections[0];if(t===void 0)return"";const e=this.info.levels[t.level],s=e.voxelSize>=.1?`${+e.voxelSize.toFixed(2)} mm`:`${+(e.voxelSize*1e3).toFixed(1)} µm`;let o=0;for(const i of t.draw)o+=this.blocks.get(i)?.data?.weights.length??0;return`Splats from level ${t.level} (${s} voxels): ${o.toLocaleString()} in ${t.draw.length} blocks${t.complete?"":`, ${this.wanted.length} blocks to read`}${this.error?` · a block failed: ${this.error}`:""}`}dispose(){this.offs.forEach(t=>t()),this.handle.dispose(),this.view2d.dispose(),this.worker.terminate()}}function To(a){if(typeof a!="object"||a===null||a.enableDefaultSubsources!==!1)return!0;const t=a.subsources;return t===null||typeof t!="object"?!1:Object.values(t).some(e=>e===!0||typeof e=="object"&&e!==null)}function Ao(a,t){const e=t?.source,s=Array.isArray(e)?e:e===void 0?[]:[e],o=new Set(s.filter(i=>!To(i)).map(i=>String(typeof i=="object"&&i!==null?i.url:i)));return a.filter(i=>!o.has(i))}const bt=3e4;function k(a,t={},...e){const s=document.createElement(a);for(const[o,i]of Object.entries(t))i===void 0||i===!1||(o.startsWith("on")&&typeof i=="function"?s.addEventListener(o.slice(2),i):o==="class"?s.className=String(i):o==="value"?s.value=String(i):s.setAttribute(o,i===!0?"":String(i)));for(const o of e)o!=null&&o!==!1&&s.append(o);return s}function ue(a){return a.type==="image"?Nt(a.sources[0]):void 0}function So(a,t){if(!(a.type!=="segmentation"&&a.type!=="auto"))for(const e of Ao(a.sources,t)){const s=kt(e);if(s!==void 0)return s}}class Ro{constructor(t){this.ctx=t,this.saved=nt(t.state.get()),this.momentum=new Zt(t),this.offs.push(t.state.onChanged(()=>{const e=nt(t.state.get());JSON.stringify(e)!==JSON.stringify(this.saved)&&(this.saved=e,this.sync(),this.panelUpdate?.())}),t.viewer.onLayersChanged(()=>{this.sync(),this.panelUpdate?.()}),t.workspace.onChanged(()=>this.panelUpdate?.())),this.sync()}saved;views=new Map;outgoing=new Map;drawingHidden=new Set;panelUpdate;statusUpdate;editing;momentum;offs=[];candidates(){return this.ctx.viewer.layers().filter(t=>this.storeOf(t)!==void 0||ue(t)!==void 0)}storeOf(t){return So(t,this.ctx.viewer.layerSpec(t.name))}write(t){this.saved=t,this.ctx.state.set(t),this.sync(),this.panelUpdate?.()}styleOf(t){const e=this.saved.layers[t];if(e!==void 0)return e;const s=this.ctx.viewer.layers().find(n=>n.name===t);if(s!==void 0&&ue(s)!==void 0)return{...Ie,on:!1,blending:"emission",colourBy:"attribute",colormap:"grey",absorption:.3};const o=this.ctx.viewer.layerSpec(t),i=o?.segmentDefaultColor!==void 0||typeof o?.segmentColors=="object"&&o.segmentColors!==null&&Object.keys(o.segmentColors).length>0;return{...Ie,on:!1,...i?{colourBy:"segment"}:{}}}setStyle(t,e,s=!0){const o=Mt({...this.styleOf(t),...e});s?this.write({...this.saved,layers:{...this.saved.layers,[t]:o}}):(this.saved={...this.saved,layers:{...this.saved.layers,[t]:o}},this.views.get(t)?.setStyle(o))}toggle(t){const e=this.styleOf(t);this.setStyle(t,{on:!e.on}),this.editing=t}handOver(t){const e=this.outgoing.get(t);if(e===void 0)return;const s=this.views.get(t),o=e.view.objectsShown,i=s instanceof re?s.client.info?.levels[0]?.objects:void 0;if(s instanceof re&&s.held&&o!==void 0&&(!s.ready||i!==void 0&&i<o)){clearTimeout(e.timer),e.timer=setTimeout(()=>this.handOver(t),bt);return}this.finishHandOver(t)}finishHandOver(t){const e=this.outgoing.get(t);if(e===void 0)return;this.outgoing.delete(t),clearTimeout(e.timer),e.view.dispose();const s=this.views.get(t);s instanceof re&&s.held&&(s.held=!1,s.redraw())}sync(){const t=new Map(this.ctx.viewer.layers().map(s=>[s.name,s]));for(const[s,o]of this.views){const i=t.get(s),n=this.saved.layers[s],r=i&&(this.storeOf(i)??ue(i));(i===void 0||n===void 0||!n.on||r!==o.storeUrl)&&(this.views.delete(s),o instanceof re&&!o.held&&n?.on&&i?.visible&&r!==void 0&&this.storeOf(i)!==void 0?(this.finishHandOver(s),o.freeze(),o.setVisible(!0),this.outgoing.set(s,{view:o,timer:setTimeout(()=>this.handOver(s),bt)})):o.dispose())}for(const s of[...this.outgoing.keys()]){const o=this.saved.layers[s];(!t.has(s)||o===void 0||!o.on)&&this.finishHandOver(s)}for(const[s,o]of Object.entries(this.saved.layers)){const i=t.get(s);if(i===void 0||!o.on)continue;const n=this.storeOf(i),r=n===void 0?ue(i):void 0;if(n===void 0&&r===void 0)continue;let c=this.views.get(s);if(c===void 0){if(r!==void 0)c=new Ue(this.ctx,s,r,o),c.onStatus=()=>this.statusUpdate?.();else{const h=new re(this.ctx,s,n,o);h.held=this.outgoing.has(s),h.onStatus=()=>{h.held&&h.ready&&this.views.get(s)===h&&this.handOver(s),this.statusUpdate?.()},c=h}this.views.set(s,c)}else c.style!==o&&c.setStyle(o);c.setVisible(i.visible);const l=this.outgoing.get(s);l!==void 0&&(l.view.style!==o&&l.view.setStyle(o),l.view.setVisible(i.visible))}for(const s of[...this.drawingHidden])this.views.has(s)||(this.drawingHidden.delete(s),t.has(s)&&this.ctx.viewer.hideLayerDrawing(s,!1));for(const s of this.views.keys())this.drawingHidden.add(s),this.ctx.viewer.hideLayerDrawing(s,!0);const e=[...this.views.values()].some(s=>s instanceof Ue);this.ctx.viewer.setTemporaryBackground(e?[0,0,0]:void 0),this.momentum.set(this.saved.momentum)}render(t){const e=()=>{const s=this.candidates();if(this.editing===void 0||!s.some(r=>r.name===this.editing)){const r=this.ctx.workspace.selectedLayer();this.editing=s.find(c=>c.name===r)?.name??s.find(c=>this.saved.layers[c.name]?.on)?.name??s[0]?.name}const o=k("div",{class:"lx-layers"});for(const r of s){const c=k("input",{type:"checkbox","aria-label":`Luxar rendering of ${r.name}`});c.checked=this.styleOf(r.name).on,c.addEventListener("change",()=>{this.editing=r.name,this.setStyle(r.name,{on:c.checked})});const l=k("div",{class:`lx-layer${r.name===this.editing?" lx-editing":""}`},c,k("button",{class:"lx-name",type:"button",title:"Show this layer's settings",onclick:()=>(this.editing=r.name,e())},r.name));o.append(l)}const i=k("p",{class:"note lx-status"}),n=()=>{const r=this.editing===void 0?void 0:this.views.get(this.editing),c=this.editing===void 0?void 0:this.outgoing.get(this.editing);i.textContent=r===void 0?"":c!==void 0?`${c.view.status()} — its new store, not drawn until read: ${r.status()}`:r.status()};this.statusUpdate=n,n(),t.replaceChildren(k("div",{class:"lx-panel"},k("p",{class:"note"},"Draws a Zarr Vectors layer the way Luxar does, in these views: light added up and tone mapped, smooth lines with mitred joins. Tick a layer; the others stay as they are."),s.length?o:k("p",{class:"note"},"No Zarr Vectors layer in this scene (a store, or a .trk, .tck, .trx or SWC file opened in place)."),this.editing?this.settings(this.editing):null,i,k("label",{class:"field check"},this.checkbox(this.saved.momentum,r=>this.write({...this.saved,momentum:r})),k("span",{},"Momentum when rotating the 3-D view (Luxar's camera feel)"))))};return this.panelUpdate=e,e(),()=>{this.panelUpdate===e&&(this.panelUpdate=void 0),this.statusUpdate=void 0}}checkbox(t,e){const s=k("input",{type:"checkbox"});return s.checked=t,s.addEventListener("change",()=>e(s.checked)),s}select(t,e,s,o){const i=k("select",{class:"text-input","aria-label":t});for(const[n,r]of s)i.append(k("option",{value:n},r));return i.value=e,i.addEventListener("change",()=>o(i.value)),k("label",{class:"field"},k("span",{},t),i)}slider(t,e,s,o,i,n,r){const c=this.styleOf(t),l=k("input",{type:"range",min:o,max:i,step:n,value:c[s],"aria-label":e}),h=k("span",{class:"lx-value"},r(c[s]));return l.addEventListener("input",()=>{h.textContent=r(Number(l.value)),this.setStyle(t,{[s]:Number(l.value)},!1)}),l.addEventListener("change",()=>this.setStyle(t,{[s]:Number(l.value)})),k("label",{class:"field"},k("span",{},e),k("div",{class:"lx-row"},l,h))}bloomSlider(t){return this.slider(t,"Bloom (glow around bright light)","bloom",0,3,.05,e=>e===0?"off":e.toFixed(2))}splatSettings(t){const e=this.styleOf(t),s=n=>this.setStyle(t,n),o=e.colourBy==="solid",i=[k("h3",{class:"lx-heading"},`Settings: ${t}`),k("p",{class:"note"},"Drawn as Gaussian splats made from its voxels as they are read, each level of the image giving its own: in the 3-D view, and cut by each section in the 2-D views, in place of Neuroglancer's drawing of it."),this.select("Blending",e.blending==="emission"?"emission":"glow",[["emission","Emission and absorption (looks solid)"],["glow","Glow (light added up)"]],n=>s({blending:n})),this.select("Colour",o?"solid":"attribute",[["attribute","By intensity, through a colormap"],["solid","One colour"]],n=>s({colourBy:n}))];if(o){const n=k("input",{type:"color",value:e.colour,"aria-label":"Colour"});n.addEventListener("input",()=>this.setStyle(t,{colour:n.value},!1)),n.addEventListener("change",()=>s({colour:n.value})),i.push(k("label",{class:"field"},k("span",{},"Colour"),n))}else i.push(this.select("Colormap",e.colormap,ot,n=>s({colormap:n})));return i.push(this.slider(t,"Brightness (stops)","exposure",-8,8,.25,n=>n>0?`+${n}`:`${n}`),...e.blending==="emission"?[this.slider(t,"Absorption","absorption",0,8,.05,n=>n.toFixed(2))]:[],this.select("Tone map",e.toneMap,it,n=>s({toneMap:n})),this.bloomSlider(t),this.slider(t,"Detail (splats per view)","detail",.25,12,.25,n=>`${n} M`)),e.on||i.push(k("p",{class:"note"},"Tick the layer above to draw it this way.")),k("div",{class:"lx-settings"},...i)}settings(t){const e=this.styleOf(t),s=this.ctx.viewer.layers().find(d=>d.name===t);if(s!==void 0&&ue(s)!==void 0)return this.splatSettings(t);const o=this.views.get(t),i=o instanceof re?o:void 0,n=i?.client.info,r=d=>this.setStyle(t,d),c=n?.attributes??[],l=[k("h3",{class:"lx-heading"},`Settings: ${t}`),this.select("Blending",e.blending,xs,d=>r({blending:d})),this.select("Colour",e.colourBy,Ts,d=>r({colourBy:d,attribute:d==="attribute"?e.attribute??c[0]?.id:e.attribute}))];if(e.colourBy==="attribute"){c.length===0?l.push(k("p",{class:"note"},n?"This store has no vertex attributes.":"The store's attributes show once it is open.")):l.push(this.select("Attribute",e.attribute??c[0].id,c.map(v=>[v.id,v.name]),v=>r({attribute:v,range:void 0}))),l.push(this.select("Colormap",e.colormap,ot,v=>r({colormap:v})));const d=e.range??i?.client.valueRange,p=k("input",{type:"number",class:"text-input",step:"any",value:d?+d[0].toPrecision(4):"","aria-label":"Range from"}),w=k("input",{type:"number",class:"text-input",step:"any",value:d?+d[1].toPrecision(4):"","aria-label":"Range to"}),g=()=>{const v=Number(p.value),f=Number(w.value);p.value!==""&&w.value!==""&&Number.isFinite(v)&&Number.isFinite(f)&&v!==f&&r({range:[v,f]})};p.addEventListener("change",g),w.addEventListener("change",g),l.push(k("div",{class:"field"},k("span",{},e.range?"Range":"Range (from what has loaded)"),k("div",{class:"lx-row"},p,w,e.range?k("button",{type:"button",class:"lx-small",onclick:()=>r({range:void 0})},"Auto"):null)))}if(e.colourBy==="solid"){const d=k("input",{type:"color",value:e.colour,"aria-label":"Colour"});d.addEventListener("input",()=>this.setStyle(t,{colour:d.value},!1)),d.addEventListener("change",()=>r({colour:d.value})),l.push(k("label",{class:"field"},k("span",{},"Line colour"),d))}const h=n?.primitive==="points",u=n?.primitive==="triangles";return u&&l.push(k("p",{class:"note"},"A mesh: lit surfaces in the 3-D view (direction colours by the surface's normal), and in the 2-D views the outline where the section cuts it.")),l.push(h?this.slider(t,"Point size (pixels)","width",.5,12,.25,d=>`${3*d} px`):this.slider(t,u?"Outline width in 2-D (pixels)":"Width (pixels)","width",.5,12,.25,d=>`${d} px`),this.slider(t,"Brightness (stops)","exposure",-8,8,.25,d=>d>0?`+${d}`:`${d}`),this.slider(t,"Sharpness","sharpness",0,1,.05,d=>d.toFixed(2))),e.blending==="emission"&&l.push(this.slider(t,"Absorption","absorption",0,8,.05,d=>d.toFixed(2))),e.blending!=="solid"&&l.push(this.select("Tone map",e.toneMap,it,d=>r({toneMap:d})),this.bloomSlider(t)),l.push(this.slider(t,"2-D slab (thickness shown around a section)","slab",.5,40,.5,d=>`${d} mm`),this.slider(t,"Detail (vertices per view)","detail",.25,12,.25,d=>`${d} M`),k("label",{class:"field check"},this.checkbox(e.autoBrightness,d=>r({autoBrightness:d})),k("span",{},"Automatic brightness (dimmer lines where they crowd the view)"))),e.on||l.push(k("p",{class:"note"},"Tick the layer above to draw it this way.")),k("div",{class:"lx-settings"},...l)}dispose(){this.offs.forEach(e=>e());for(const e of[...this.outgoing.keys()])this.finishHandOver(e);for(const e of this.views.values())e.dispose();const t=[...this.views.values()].some(e=>e instanceof Ue);for(const e of this.drawingHidden)this.ctx.viewer.hideLayerDrawing(e,!1);t&&this.ctx.viewer.setTemporaryBackground(void 0),this.drawingHidden.clear(),this.views.clear(),this.momentum.dispose()}}const _o=`
.lx-panel { display: grid; gap: 10px; }
.lx-layers { display: grid; gap: 2px; }
.lx-layer { display: flex; align-items: center; gap: 8px; padding: 2px 4px; border-radius: 4px; }
.lx-layer.lx-editing { background: var(--hover, rgba(255,255,255,0.06)); }
.lx-name { all: unset; cursor: pointer; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.lx-settings { display: grid; gap: 10px; }
.lx-heading { font-size: 12px; font-weight: 600; margin: 6px 0 0; }
.lx-row { display: flex; align-items: center; gap: 8px; }
.lx-row input[type="range"] { flex: 1; min-width: 0; }
.lx-row input[type="number"] { flex: 1; min-width: 0; }
.lx-value { font-size: 11px; color: var(--muted); min-width: 44px; text-align: right; }
.lx-small { font-size: 11px; }
.luxar-canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
`,Lo={activate(a){const t=k("style",{},_o);document.head.append(t);const e=new Ro(a);a.subscriptions.push(()=>t.remove()),a.subscriptions.push(()=>{e.dispose()}),a.ui.panel(Je,s=>e.render(s)),a.commands.register("luxar.toggle",()=>{const s=a.workspace.selectedLayer(),o=s===void 0?void 0:e.candidates().find(i=>i.name===s);if(o===void 0){a.ui.toast("Select a Zarr Vectors layer first.");return}e.toggle(o.name)}),a.commands.register("luxar.show",()=>a.ui.showPanel(Je))}};export{ue as imageOfLayer,Lo as plugin,So as storeOfLayer};
