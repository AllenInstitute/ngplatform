function I(a,t){const e=new Float64Array(16);for(let o=0;o<4;++o)for(let i=0;i<4;++i){let n=0;for(let s=0;s<4;++s)n+=a[4*o+s]*t[4*s+i];e[4*o+i]=n}return e}function O(a){const t=Array.from({length:4},(e,o)=>[...a.slice(4*o,4*o+4),...[0,1,2,3].map(i=>i===o?1:0)]);for(let e=0;e<4;++e){let o=e;for(let n=e+1;n<4;++n)Math.abs(t[n][e])>Math.abs(t[o][e])&&(o=n);if(Math.abs(t[o][e])<1e-300)throw new Error("singular transform");[t[e],t[o]]=[t[o],t[e]];const i=t[e][e];for(let n=0;n<8;++n)t[e][n]/=i;for(let n=0;n<4;++n){if(n===e)continue;const s=t[n][e];if(s!==0)for(let r=0;r<8;++r)t[n][r]-=s*t[e][r]}}return Float64Array.from(t.flatMap(e=>e.slice(4)))}const $={meter:1e3,m:1e3,millimeter:1,mm:1,micrometer:.001,um:.001,µm:.001,micron:.001,nanometer:1e-6,nm:1e-6},P=a=>typeof a=="string"?a:a?.name;function N(a,t){const o=Array.from({length:t+1},(i,n)=>Array.from({length:t+1},(s,r)=>n===r?1:0));switch(a.type){case"identity":return o;case"scale":return a.scale.forEach((i,n)=>o[n][n]=i),o;case"translation":return a.translation.forEach((i,n)=>o[n][t]=i),o;case"affine":{const i=Array.isArray(a.affine[0])?a.affine:H(a.affine,t+1);for(let n=0;n<t;++n)for(let s=0;s<=t;++s)o[n][s]=i[n][s];return o}case"sequence":return(a.transformations??[]).reduce((i,n)=>X(N(n,t),i),o);default:throw new Error(`unsupported coordinate transform "${a.type}"`)}}function H(a,t){const e=[];for(let o=0;o<a.length;o+=t)e.push(a.slice(o,o+t));return e}function X(a,t){return a.map(e=>t[0].map((o,i)=>e.reduce((n,s,r)=>n+s*t[r][i],0)))}function mt(a,t,e){const o=t?.attributes??t??{},n=(o.ome??o)?.multiscales?.[0];if(n===void 0)throw new Error(`${a}: not an OME-Zarr image (no multiscales)`);const s=n.coordinateSystems??[],r=n.datasets??[];if(r.length===0)throw new Error(`${a}: the image has no datasets`);const d=P(r[0].coordinateTransformations?.[0]?.output),c=s.find(m=>m.name===d)??s[0],u=c?.axes??n.axes??[],p=u.length;if(p===0)throw new Error(`${a}: the image names no axes`);if(u.filter(m=>["x","y","z"].includes(m.name)).length!==3||p!==3)throw new Error(`${a}: only 3-D images (axes z, y, x) are shown; this one has ${u.map(m=>m.name).join(", ")}`);const v=n.coordinateTransformations??[],x=v.filter(m=>P(m.input)!==void 0||P(m.output)!==void 0),T=v.filter(m=>!x.includes(m));let l=u,h=c?.name??"physical",f=T.reduce((m,R)=>X(N(R,p),m),N({type:"identity"},p));const y=m=>x.find(R=>P(R.input)===h&&P(R.output)===m&&s.some(_=>_.name===m)),b=(e!==void 0?y(e):void 0)??x.find(m=>P(m.input)===h&&y(P(m.output))!==void 0),w=s.find(m=>m.name===P(b?.output));b!==void 0&&w!==void 0&&w.name!==h&&(f=X(N(b,p),f),l=w.axes,h=w.name);const k=Array.from({length:4},(m,R)=>Array.from({length:p+1},(_,D)=>R===3&&D===p?1:0));l.forEach((m,R)=>{const _={x:0,y:1,z:2}[m.name],D=$[m.unit??"millimeter"]??1;k[_][R]=D});const A=Array.from({length:p+1},(m,R)=>Array.from({length:4},(_,D)=>R===p&&D===3?1:0));u.forEach((m,R)=>{A[R][{x:0,y:1,z:2}[m.name]]=1});const M=r.map(m=>{const R=(m.coordinateTransformations??[]).reduce((z,K)=>X(N(K,p),z),N({type:"identity"},p)),_=X(k,X(f,X(R,A))),D=Float64Array.from(_.flat()),B=[0,1,2].map(z=>Math.hypot(D[z],D[4+z],D[8+z]));return{url:a.endsWith("/")?a:`${a}/`,path:m.path,voxelToRas:D,voxelSize:(B[0]+B[1]+B[2])/3,axes:u.map(z=>z.name)}}),U=n.metadata?.description;return{levels:M,space:h,name:String(n.name??a),description:typeof U=="string"?U:void 0}}function pt(a){const t=a.flatMap(o=>o.levels),e=[];for(const o of t)e.some(i=>Math.abs(i.voxelSize-o.voxelSize)<=.02*i.voxelSize)||e.push(o);return e.sort((o,i)=>o.voxelSize-i.voxelSize)}function Tt(a,t){const e=t.voxel_offset??[0,0,0],o=t.resolution.map(n=>n*1e-6),i=new Float64Array(16);for(let n=0;n<3;++n)i[5*n]=o[n],i[4*n+3]=(e[n]+.5)*o[n];return i[15]=1,{url:a,path:t.key,voxelToRas:i,voxelSize:(o[0]+o[1]+o[2])/3,axes:["z","y","x"]}}const g=32,S=g+2,Y=0,q=1,Z=2,L=8,J=1<<22,Q=6,tt=a=>a.map(t=>Math.ceil(t/g));function et(a,t){const e=[];let o=0,i=0,n=0,s=0,r=0;for(const d of a){if(d.some(c=>c>t)||(i+d[2]>t&&(o+=n,i=0,n=0),o+d[0]>t))return;e.push([o,0,i]),i+=d[2],n=Math.max(n,d[0]),s=Math.max(s,d[1]),r=Math.max(r,i)}return{size:[o+n,s,r],grids:a,offsets:e}}function ot(a,t){for(let e=Math.max(0,a.length-L);e<a.length;++e){const o=a.slice(e),i=et(o.map(n=>tt(n.size)),t);if(i!==void 0&&i.size[0]*i.size[1]*i.size[2]<=J)return{levels:o,layout:i}}}function it(a,t){return{lo:[0,1,2].map(e=>Math.max(0,t[e]*g-1)),hi:[0,1,2].map(e=>Math.min(a[e],t[e]*g+g+1))}}function st(a,t,e,o){const i=[0,1,2].map(u=>t.hi[u]-t.lo[u]),n=[0,1,2].map(u=>Int32Array.from({length:S},(p,E)=>Math.min(e[u]-1,Math.max(0,o[u]*g-1+E))-t.lo[u])),s=new Uint8Array(S*S*S),r=a[(n[2][0]*i[1]+n[1][0])*i[0]+n[0][0]];let d=!0,c=0;for(let u=0;u<S;++u)for(let p=0;p<S;++p){const E=(n[2][u]*i[1]+n[1][p])*i[0];for(let v=0;v<S;++v,++c){const x=a[E+n[0][v]];s[c]=x,x!==r&&(d=!1)}}return{data:s,constant:d?r:void 0}}function j(a,t){const e=[0,0,0,0];for(let o=0;o<4;++o)e[o]=a[o]*t[0]+a[4+o]*t[1]+a[8+o]*t[2]+a[12+o];return e}function nt(a,t,e,o){const i=j(a,[t,e,o]);return[i[0]/i[3],i[1]/i[3],i[2]/i[3]]}const rt=[[1,0,0,1],[-1,0,0,1],[0,1,0,1],[0,-1,0,1],[0,0,1,1],[0,0,-1,1]];class at{constructor(t,e,o,i,n){this.context=i,this.load=n,this.levels=t,this.layout=e,this.slotsPerAxis=o,this.slots=o**3,this.slotBrick=new Int32Array(this.slots).fill(-1),this.slotWanted=new Float64Array(this.slots),this.pages=new Uint8Array(e.size[0]*e.size[1]*e.size[2]*4);let s=0;for(const r of e.grids)this.firstId.push(s),s+=r[0]*r[1]*r[2];this.toContext=O(i.voxelToRas)}levels;layout;slotsPerAxis;slots;pages;dirty=new Set;firstId=[];slotBrick;slotWanted;slotOf=new Map;constants=new Map;failed=new Set;tissue=new Map;toContext;wanted=[];wantedSet=new Set;choice=0;loading=new Map;uploads=[];onChange;inTissue(t,e){const{data:o,size:i,darkBackground:n}=this.context,[s,r,d]=t.map(Math.round);if(s<0||r<0||d<0||s>=i[0]||r>=i[1]||d>=i[2])return!1;const c=o[(d*i[1]+r)*i[0]+s];return(n?c:255-c)>=e*255}id(t,e){const o=this.layout.grids[t];return this.firstId[t]+(e[2]*o[1]+e[1])*o[0]+e[0]}brick(t){let e=this.firstId.length-1;for(;this.firstId[e]>t;)--e;const o=this.layout.grids[e],i=t-this.firstId[e];return{level:e,b:[i%o[0],Math.floor(i/o[0])%o[1],Math.floor(i/(o[0]*o[1]))]}}page(t){const{level:e,b:o}=this.brick(t),i=this.layout.offsets[e],n=this.layout.size;return((i[2]+o[2])*n[1]+i[1]+o[1])*n[0]+i[0]+o[0]}setPage(t,e){const o=this.page(t);this.pages.set(e,4*o),this.dirty.add(o)}takeDirty(){const t=[...this.dirty];return this.dirty.clear(),t}slotAt(t){const e=this.slotsPerAxis;return[t%e,Math.floor(t/e)%e,Math.floor(t/(e*e))]}get held(){return this.slotOf.size}get pending(){return this.loading.size}tissueNear(t){const e=this.tissue.get(t);if(e!==void 0)return[e>>8,e&255];const{level:o,b:i}=this.brick(t),n=this.levels[o],s=I(this.toContext,n.voxelToRas),r=[1/0,1/0,1/0],d=[-1/0,-1/0,-1/0];for(const l of W(n.size,i))for(let h=0;h<3;++h){const f=s[4*h]*l[0]+s[4*h+1]*l[1]+s[4*h+2]*l[2]+s[4*h+3];r[h]=Math.min(r[h],f),d[h]=Math.max(d[h],f)}const{data:c,size:u,darkBackground:p}=this.context,E=r.map(l=>Math.floor(l)-1),v=d.map(l=>Math.ceil(l)+1);let x=E.some(l=>l<0)||v.some((l,h)=>l>u[h]-1)?0:255,T=0;for(let l=Math.max(0,E[2]);l<=Math.min(u[2]-1,v[2]);++l)for(let h=Math.max(0,E[1]);h<=Math.min(u[1]-1,v[1]);++h){const f=(l*u[1]+h)*u[0];for(let y=Math.max(0,E[0]);y<=Math.min(u[0]-1,v[0]);++y){const b=p?c[f+y]:255-c[f+y];b<x&&(x=b),b>T&&(T=b)}}return T<x&&(x=T),this.tissue.set(t,x<<8|T),[x,T]}occlusion;hidden(t){const e=this.occlusion;return e===void 0?!1:[[0,1,2].map(i=>t.reduce((n,s)=>n+s[i],0)/t.length),...t].every(i=>this.blocked(e.eye,i))}blocked(t,e){const o=this.occlusion,{data:i,size:n,darkBackground:s}=this.context,r=F(o.toContext,t),d=F(o.toContext,e),c=Math.hypot(d[0]-r[0],d[1]-r[1],d[2]-r[2]),u=o.view.threshold*255,p=o.view.cut;for(let E=1;E<c-3;E+=1.5){const v=E/c,x=Math.round(r[0]+(d[0]-r[0])*v),T=Math.round(r[1]+(d[1]-r[1])*v),l=Math.round(r[2]+(d[2]-r[2])*v);if(x<0||T<0||l<0||x>=n[0]||T>=n[1]||l>=n[2])continue;const h=i[(l*n[1]+T)*n[0]+x];if(!((s?h:255-h)<u)){if(p!==void 0){const f=[0,1,2].map(y=>t[y]+(e[y]-t[y])*v);if([0,1,2].every(y=>(f[y]-p.point[y])*p.side[y]>=0))continue}return!0}}return!1}candidate(t,e,o,i,n){const s=this.id(t,e),r=W(this.levels[t].size,e).map(h=>F(n,h)),d=r.map(h=>j(o.viewProjection,h));for(const h of rt)if(d.every(f=>h[0]*f[0]+h[1]*f[1]+h[2]*f[2]+h[3]*f[3]<0))return;let c=!1;if(o.cut!==void 0){const{point:h,side:f}=o.cut;let y=!0,b=!0;for(let w=0;w<3;++w){const k=r.map(A=>(A[w]-h[w])*f[w]);Math.min(...k)<0&&(y=!1),Math.max(...k)<0&&(b=!1)}if(y)return;c=b}const[u,p]=this.tissueNear(s),E=o.threshold*255;if(p<E||u>=E&&!c||this.hidden(r))return;let v=d[0],x=r[0];d.forEach((h,f)=>{h[3]<v[3]&&(v=h,x=r[f])});let T=0;if(v[3]>1e-9){const[h,f,y]=[v[0]/v[3],v[1]/v[3],v[2]/v[3]],b=nt(o.invViewProjection,h,f+2/o.height,y);T=Math.hypot(b[0]-x[0],b[1]-x[1],b[2]-x[2])}const l=c?2:1;return{id:s,level:t,corners:r,error:T>0?i/T*l:1/0,near:T/l}}choose(t){const e=this.levels.length,o=Math.min(Math.max(0,t.finest),e-1),i=this.levels.map(l=>I(t.toDisplay,l.voxelToRas)),n=i.map(l=>Math.min(...[0,1,2].map(h=>Math.hypot(l[h],l[4+h],l[8+h])))),s=l=>this.constants.has(l.id)?0:1,r=lt(t.viewProjection),d=I(this.toContext,O(t.toDisplay));this.occlusion=r===void 0?void 0:{eye:r,toContext:d,view:t},r!==void 0&&this.inTissue(F(d,r),t.threshold)&&(this.occlusion=void 0);const c=e-1,u=new Set;let p=[];const E=this.layout.grids[c];for(let l=0;l<E[2];++l)for(let h=0;h<E[1];++h)for(let f=0;f<E[0];++f){const y=this.candidate(c,[f,h,l],t,n[c],i[c]);y!==void 0&&p.push(y),u.add(this.id(c,[f,h,l]))}p.sort((l,h)=>h.error-l.error);let v=0;p=p.filter(l=>(v+=s(l))<=this.slots);const x=new ct((l,h)=>l.error>h.error);for(const l of p)x.push(l);const T=[];for(let l=x.pop();l!==void 0;l=x.pop()){if(l.error<=1||l.level<=o){T.push(l);continue}const h=[],f=l.level-1,y=O(i[f]),b=[1/0,1/0,1/0],w=[-1/0,-1/0,-1/0];for(const m of l.corners){const R=F(y,m);for(let _=0;_<3;++_)b[_]=Math.min(b[_],R[_]),w[_]=Math.max(w[_],R[_])}const k=this.layout.grids[f],A=b.map(m=>Math.max(0,Math.floor((m+.5+1e-6)/g))),M=w.map((m,R)=>Math.min(k[R]-1,Math.floor((m+.5-1e-6)/g)));for(let m=A[2];m<=M[2];++m)for(let R=A[1];R<=M[1];++R)for(let _=A[0];_<=M[0];++_){const D=this.id(f,[_,R,m]);if(u.has(D))continue;u.add(D);const B=this.candidate(f,[_,R,m],t,n[f],i[f]);B!==void 0&&h.push(B)}const U=h.reduce((m,R)=>m+s(R),0)-s(l);if(v+U>this.slots){T.push(l);continue}v+=U;for(const m of h)x.push(m)}T.sort((l,h)=>l.near-h.near),this.wanted=T.map(l=>l.id),this.wantedSet=new Set(this.wanted),this.choice+=1;for(const l of this.wanted){const h=this.slotOf.get(l);h!==void 0&&(this.slotWanted[h]=this.choice)}for(const[l,h]of this.loading)this.wantedSet.has(l)||(h.abort(),this.loading.delete(l));return this.pump(),this.wanted}pump(){for(const t of this.wanted){if(this.loading.size>=Q)break;if(this.slotOf.has(t)||this.constants.has(t)||this.failed.has(t)||this.loading.has(t))continue;const e=new AbortController;this.loading.set(t,e);const{level:o,b:i}=this.brick(t),n=this.levels[o],s=it(n.size,i);this.load(n.index,s,e.signal).then(r=>{if(e.signal.aborted)return;this.loading.delete(t);const d=st(r,s,n.size,i);this.place(t,d.data,d.constant),this.pump(),this.onChange?.()},()=>{e.signal.aborted||(this.loading.delete(t),this.failed.add(t),this.pump())})}}place(t,e,o){if(o!==void 0){this.constants.set(t,o),this.setPage(t,[o,0,0,Z]);return}if(!this.wantedSet.has(t))return;let i=this.slotOf.get(t);if(i===void 0){i=0;for(let s=0;s<this.slots;++s){if(this.slotBrick[s]===-1){i=s;break}this.slotWanted[s]<this.slotWanted[i]&&(i=s)}const n=this.slotBrick[i];n!==-1&&(this.slotOf.delete(n),this.setPage(n,[0,0,0,Y])),this.slotBrick[i]=t,this.slotOf.set(t,i)}this.slotWanted[i]=this.choice,this.setPage(t,[...this.slotAt(i),q]),this.uploads.push({slot:i,data:e})}dispose(){for(const t of this.loading.values())t.abort();this.loading.clear(),this.onChange=void 0}}function W(a,t){const e=t.map(i=>i*g-.5),o=t.map((i,n)=>Math.min(a[n],i*g+g)-.5);return Array.from({length:8},(i,n)=>[0,1,2].map(s=>n>>s&1?o[s]:e[s]))}function F(a,t){const e=[0,0,0];for(let o=0;o<3;++o)e[o]=a[4*o]*t[0]+a[4*o+1]*t[1]+a[4*o+2]*t[2]+a[4*o+3];return e}class ct{constructor(t){this.before=t}items=[];push(t){const e=this.items;e.push(t);for(let o=e.length-1;o>0;){const i=o-1>>1;if(!this.before(e[o],e[i]))break;[e[o],e[i]]=[e[i],e[o]],o=i}}pop(){const t=this.items;if(t.length===0)return;const e=t[0],o=t.pop();if(t.length>0){t[0]=o;for(let i=0;;){const n=2*i+1,s=n+1;let r=i;if(n<t.length&&this.before(t[n],t[r])&&(r=n),s<t.length&&this.before(t[s],t[r])&&(r=s),r===i)break;[t[i],t[r]]=[t[r],t[i]],i=r}}return e}}function lt(a){const t=[0,1,3].map(s=>[a[s],a[4+s],a[8+s],a[12+s]]),e=t.map(s=>s.slice(0,3)),o=t.map(s=>-s[3]),i=s=>s[0][0]*(s[1][1]*s[2][2]-s[1][2]*s[2][1])-s[0][1]*(s[1][0]*s[2][2]-s[1][2]*s[2][0])+s[0][2]*(s[1][0]*s[2][1]-s[1][1]*s[2][0]),n=i(e);if(!(Math.abs(n)<1e-12))return[0,1,2].map(s=>i(e.map((r,d)=>r.map((c,u)=>u===s?o[d]:c)))/n)}const C=8,ut=128*1024*1024,ht=`#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`,ft=(a,t)=>`#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp usampler3D;
${t?"#define BRICKS":""}
const int MAX_LEVELS = ${L};
const float BRICK = ${g}.0;
const float SLOT = ${S}.0;
uniform sampler3D uVolume;
uniform sampler3D uOccupancy;
uniform mat4 uInvViewProj;
uniform mat4 uViewProj;
uniform mat4 uWorldToTex;
uniform vec3 uOccScale;
uniform vec3 uBoxLo;
uniform vec3 uBoxHi;
uniform float uStep;
uniform float uBlockStep;
uniform float uThreshold;
uniform bool uCut;
uniform vec3 uCutPoint;
uniform vec3 uCutSide;
uniform vec3 uVoxel;
uniform bool uDarkBackground;
uniform vec2 uWindow;
uniform bool uHasDetail;
uniform sampler3D uDetail;
uniform mat4 uWorldToDetail;
uniform float uDetailStep;
uniform vec3 uDetailVoxel;
#ifdef BRICKS
uniform sampler3D uAtlas;
uniform highp usampler3D uPages;
uniform vec3 uAtlasTexel;
uniform int uFirstLevel;
uniform int uLevelCount;
uniform mat4 uWorldToLevel[MAX_LEVELS];
uniform ivec3 uPageOffset[MAX_LEVELS];
uniform ivec3 uPageGrid[MAX_LEVELS];
uniform float uLevelStep[MAX_LEVELS];
uniform vec3 uLevelVoxel[MAX_LEVELS];
#endif
in vec2 vNdc;
layout(location = ${a.color}) out vec4 out_color;
layout(location = ${a.z}) out highp vec4 out_z;
layout(location = ${a.pick}) out highp vec4 out_pickId;

vec2 slab(vec3 o, vec3 inv, vec3 lo, vec3 hi, out vec3 tExit) {
  vec3 a = (lo - o) * inv;
  vec3 b = (hi - o) * inv;
  vec3 tmin = min(a, b);
  tExit = max(a, b);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tExit.x, tExit.y), tExit.z));
}

vec3 texOf(vec3 p) { return (uWorldToTex * vec4(p, 1.0)).xyz; }

// Inside the detail box (its texture coordinates, half a voxel in from its edges).
bool inDetail(vec3 p, out vec3 tc) {
  if (!uHasDetail) return false;
  tc = (uWorldToDetail * vec4(p, 1.0)).xyz;
  return all(greaterThan(tc, vec3(0.0))) && all(lessThan(tc, vec3(1.0)));
}

// A value and where it came from: the step and voxel there, and the brick
// (level -1: the coarse level or the detail).
struct Sample {
  float v;
  float stepSize;
  vec3 voxel;
  int level;
  vec3 brick;
  bool constant;
};

Sample sampleAt(vec3 p) {
  Sample s;
  s.level = -1;
  s.brick = vec3(0.0);
  s.constant = false;
#ifdef BRICKS
  // The finest brick held here, from the finest level allowed.
  for (int l = 0; l < MAX_LEVELS; ++l) {
    if (l >= uLevelCount) break;
    if (l < uFirstLevel) continue;
    vec3 x = (uWorldToLevel[l] * vec4(p, 1.0)).xyz;
    vec3 b = floor((x + 0.5) / BRICK);
    ivec3 bi = ivec3(b);
    if (any(lessThan(bi, ivec3(0))) || any(greaterThanEqual(bi, uPageGrid[l]))) continue;
    uvec4 e = texelFetch(uPages, uPageOffset[l] + bi, 0);
    if (e.a == 0u) continue;
    s.level = l;
    s.brick = b;
    s.stepSize = uLevelStep[l];
    s.voxel = uLevelVoxel[l];
    s.constant = e.a == 2u;
    // The slot's voxel 0 is the brick's voxel -1 (the apron).
    s.v = s.constant ? float(e.r) / 255.0 : texture(uAtlas, (vec3(e.rgb) * SLOT + x - b * BRICK + 1.5) * uAtlasTexel).r;
    return s;
  }
#else
  vec3 dc;
  if (inDetail(p, dc)) {
    s.v = texture(uDetail, dc).r;
    s.stepSize = uDetailStep;
    s.voxel = uDetailVoxel;
    return s;
  }
#endif
  s.stepSize = uStep;
  s.voxel = uVoxel;
  vec3 tc = texOf(p);
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) s.v = uDarkBackground ? 0.0 : 1.0;
  else s.v = texture(uVolume, tc).r;
  return s;
}

float raw(vec3 p) { return sampleAt(p).v; }

#ifdef BRICKS
// Where the ray leaves brick b of level l.
float brickExit(vec3 o, vec3 d, int l, vec3 b) {
  mat4 m = uWorldToLevel[l];
  vec3 dl = mat3(m) * d;
  vec3 tExit;
  return slab((m * vec4(o, 1.0)).xyz, 1.0 / (dl + vec3(equal(dl, vec3(0.0))) * 1e-9), b * BRICK - 0.5, b * BRICK + BRICK - 0.5, tExit).y;
}
#endif

// The tissue's range stretched to black..white.
float shown(float v) {
  return clamp((v - uWindow.x) / max(uWindow.y - uWindow.x, 1e-3), 0.0, 1.0);
}

// How like the background a point is: 1 is background, lower is tissue.
float value(vec3 p) {
  float v = raw(p);
  return uDarkBackground ? 1.0 - v : v;
}

float occupied(vec3 p) {
  vec3 tc = texOf(p) * uOccScale;
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) return 0.0;
  return texture(uOccupancy, tc).r;
}

bool removed(vec3 p) {
  if (!uCut) return false;
  vec3 s = (p - uCutPoint) * uCutSide;
  return s.x > 0.0 && s.y > 0.0 && s.z > 0.0;
}

void main() {
  vec4 n = uInvViewProj * vec4(vNdc, -1.0, 1.0);
  vec4 f = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 o = n.xyz / n.w;
  vec3 d = f.xyz / f.w - o;
  float far = length(d);
  d /= far;
  vec3 inv = 1.0 / (d + vec3(equal(d, vec3(0.0))) * 1e-9);
  vec3 unused;
  vec2 box = slab(o, inv, uBoxLo, uBoxHi, unused);
  float t = max(box.x, 0.0);
  box.y = min(box.y, far);
  if (t >= box.y) discard;
  vec2 oct = vec2(1.0, 0.0);
  vec3 octExit = vec3(0.0);
  if (uCut) {
    vec3 up = step(0.0, uCutSide);
    vec3 lo = mix(uBoxLo - 1.0, uCutPoint, up);
    vec3 hi = mix(uCutPoint, uBoxHi + 1.0, up);
    oct = slab(o, inv, lo, hi, octExit);
  }
  float threshold = 1.0 - uThreshold;
  bool hit = false;
  bool face = false;
  // Where the ray left the cut through a face that is not tissue there.
  float emptyFace = -1.0;
  float before = t;
  for (int i = 0; i < 4096; ++i) {
    if (t > box.y) break;
    if (oct.x < oct.y && t >= oct.x && t < oct.y) {
      t = oct.y + 1e-4 * uStep;
      face = true;
      if (value(o + d * t) >= threshold) emptyFace = t;
      continue;
    }
    vec3 p = o + d * t;
    if (occupied(p) < uThreshold) {
      before = t;
      t += uBlockStep;
      face = false;
      continue;
    }
    Sample s = sampleAt(p);
    if ((uDarkBackground ? 1.0 - s.v : s.v) < threshold) {
      hit = true;
      break;
    }
    face = false;
    before = t;
#ifdef BRICKS
    if (s.constant) {
      // A brick of background throughout: on to where the ray leaves it (or meets the cut).
      float exit = brickExit(o, d, s.level, s.brick);
      if (t < oct.x && oct.x < oct.y) exit = min(exit, oct.x);
      before = max(t, exit - 1e-3 * s.stepSize);
      t = max(exit, t) + 0.05 * s.stepSize;
      continue;
    }
#endif
    t += s.stepSize;
  }
  if (!hit) discard;
  vec3 p = o + d * t;
  vec3 colour;
  float behind = 0.0;
  if (face) {
    colour = vec3(shown(raw(p)));
    behind = 2e-5;
  } else {
    // Down to a tenth of a step where the surface is (a jump over empty
    // blocks or a brick of background is many of a fine level's voxels).
    float a = before;
    float b = t;
    float within = 0.1 * sampleAt(p).stepSize;
    for (int k = 0; k < 16; ++k) {
      if (b - a < within) break;
      float m = 0.5 * (a + b);
      vec3 q = o + d * m;
      if (!removed(q) && value(q) < threshold) b = m; else a = m;
    }
    t = b;
    p = o + d * t;
    vec3 h = sampleAt(p).voxel;
    vec3 g = vec3(
      value(p + vec3(h.x, 0.0, 0.0)) - value(p - vec3(h.x, 0.0, 0.0)),
      value(p + vec3(0.0, h.y, 0.0)) - value(p - vec3(0.0, h.y, 0.0)),
      value(p + vec3(0.0, 0.0, h.z)) - value(p - vec3(0.0, 0.0, h.z))) / h;
    vec3 normal = length(g) > 1e-6 ? normalize(g) : -d;
    if (dot(normal, d) > 0.0) normal = -normal;
    float tissue = raw(p - normal * 2.0 * h);
    vec3 base = vec3(0.25 + 0.75 * shown(tissue));
    vec3 light = normalize(-d + vec3(0.0, 0.0, 0.35));
    float diffuse = max(dot(normal, light), 0.0);
    float spec = pow(max(dot(reflect(-light, normal), -d), 0.0), 24.0);
    colour = base * (0.28 + 0.72 * diffuse) + 0.12 * spec;
  }
  // Through a face that is not tissue, the section shows only background
  // there: the solid behind it is drawn at the face, a hair in front.
  vec3 at = emptyFace > 0.0 && !face ? o + d * emptyFace : p;
  if (emptyFace > 0.0 && !face) behind = -2e-5;
  vec4 clip = uViewProj * vec4(at, 1.0);
  float depth = clamp(clip.z / clip.w * 0.5 + 0.5 + behind, 0.0, 1.0);
  gl_FragDepth = depth;
  out_color = vec4(colour, 1.0);
  out_z = vec4(1.0 - depth);
  out_pickId = vec4(0.0);
}`;function dt(a,t){const[e,o,i]=t;let n=0,s=0;for(let r=0;r<i;++r)for(let d=0;d<o;++d){const c=(r*o+d)*e;if(r===0||r===i-1||d===0||d===o-1){for(let u=0;u<e;++u)n+=a[c+u];s+=e}else n+=a[c]+a[c+e-1],s+=2}return s===0?255:n/s}function vt(a,t){const e=new Float64Array(256);for(let c=0;c<a.length;++c)e[a[c]]++;const[o,i]=t?[21,256]:[0,235];let n=0;for(let c=o;c<i;++c)n+=e[c];if(n===0)return[0,1];const s=c=>{let u=0;for(let p=o;p<i;++p)if(u+=e[p],u>=c*n)return p;return i-1},r=s(.01),d=Math.max(s(.995),r+1);return[r/255,d/255]}function V(a){const t=new Float32Array(16);for(let e=0;e<4;++e)for(let o=0;o<4;++o)t[4*o+e]=a[4*e+o];return t}function G(a){const t=new Float64Array(16);t[15]=1;for(let e=0;e<3;++e){const o=["x","y","z"].indexOf(a.names[e]);if(o===-1)return;const n=a.units[e]==="m"?.001:1;t[4*e+o]=n/a.scales[e]}return t}class xt{options={threshold:.08,cut:!0};program;programFor;vao;gl;volumeTexture;occupancy;uploaded;pending;detail;detailTexture;detailPending;voxelToRas;occScale=[1,1,1];darkBackground=!0;window=[0,1];voxelSize=1;brickSource;bricks;atlas;atlasSlots=0;pageTexture;chosenFor;choosing;bricksFailed;onBricks;problem;onProblem;setVolume(t,e,o,i){this.voxelToRas=o,this.voxelSize=i,this.darkBackground=dt(t,e)<128,this.window=vt(t,this.darkBackground),this.pending={data:t,size:e,voxelToDisplay:o}}setDetail(t,e,o){this.detailPending=t===void 0?null:{data:t,size:e,voxelToDisplay:o}}setBricks(t){t?.key!==this.brickSource?.key&&this.dropBricks(),this.brickSource=t}brickStatus(){const t=this.bricks;if(t===void 0)return;const e=this.brickSource?.finest??0;return{held:t.held,slots:t.slots,loading:t.pending,wanted:t.wanted.length,levels:t.levels.map(o=>o.index).filter(o=>o>=e)}}dropBricks(){this.bricks?.dispose(),this.bricks=void 0,this.chosenFor=void 0,clearTimeout(this.choosing),this.pageTexture&&this.gl&&this.gl.deleteTexture(this.pageTexture),this.pageTexture=void 0}makeBricks(t,e,o){const i=t.getParameter(t.MAX_3D_TEXTURE_SIZE),n=ot(e.levels,i),s=Math.min(Math.floor(i/S),Math.floor(Math.cbrt(ut/S**3))),r=u=>{this.bricksFailed=u,this.atlas&&t.deleteTexture(this.atlas),this.atlas=void 0,this.dropBricks(),this.onBricks?.()};if(s<2)return r(`3-D textures here are at most ${i} voxels a side`);if(n===void 0)return r("the levels' page tables do not fit in a 3-D texture");for(let u=0;u<16&&t.getError()!==t.NO_ERROR;++u);if(this.atlas===void 0||this.atlasSlots!==s){this.atlas&&t.deleteTexture(this.atlas),this.atlas=t.createTexture(),this.atlasSlots=s,t.bindTexture(t.TEXTURE_3D,this.atlas),t.texStorage3D(t.TEXTURE_3D,1,t.R8,s*S,s*S,s*S);for(const u of[t.TEXTURE_MIN_FILTER,t.TEXTURE_MAG_FILTER])t.texParameteri(t.TEXTURE_3D,u,t.LINEAR);for(const u of[t.TEXTURE_WRAP_S,t.TEXTURE_WRAP_T,t.TEXTURE_WRAP_R])t.texParameteri(t.TEXTURE_3D,u,t.CLAMP_TO_EDGE)}const d=n.layout.size;this.pageTexture=t.createTexture(),t.bindTexture(t.TEXTURE_3D,this.pageTexture),t.texStorage3D(t.TEXTURE_3D,1,t.RGBA8UI,d[0],d[1],d[2]);for(const u of[t.TEXTURE_MIN_FILTER,t.TEXTURE_MAG_FILTER])t.texParameteri(t.TEXTURE_3D,u,t.NEAREST);t.bindTexture(t.TEXTURE_3D,null);const c=t.getError();if(c!==t.NO_ERROR)return r(c===t.OUT_OF_MEMORY?"the GPU has no memory for the bricks":`the bricks' textures could not be made (WebGL error ${c})`);this.bricks=new at(n.levels,n.layout,s,{data:o.data,size:o.size,voxelToRas:o.voxelToDisplay,darkBackground:this.darkBackground},e.load),this.bricks.onChange=()=>this.onBricks?.()}uploadBricks(t,e){if(t.pixelStorei(t.UNPACK_ALIGNMENT,1),e.uploads.length>0){t.bindTexture(t.TEXTURE_3D,this.atlas);for(const{slot:i,data:n}of e.uploads){const[s,r,d]=e.slotAt(i);t.texSubImage3D(t.TEXTURE_3D,0,s*S,r*S,d*S,S,S,S,t.RED,t.UNSIGNED_BYTE,n)}e.uploads=[]}const o=e.takeDirty();if(o.length>0){const[i,n,s]=e.layout.size;if(t.bindTexture(t.TEXTURE_3D,this.pageTexture),o.length>256)t.texSubImage3D(t.TEXTURE_3D,0,0,0,0,i,n,s,t.RGBA_INTEGER,t.UNSIGNED_BYTE,e.pages);else for(const r of o)t.texSubImage3D(t.TEXTURE_3D,0,r%i,Math.floor(r/i)%n,Math.floor(r/(i*n)),1,1,1,t.RGBA_INTEGER,t.UNSIGNED_BYTE,e.pages,4*r)}t.bindTexture(t.TEXTURE_3D,null)}chooseBricks(t,e,o,i,n){const s=this.options.cut?{point:[...t.position],side:i}:void 0,r={viewProjection:Float64Array.from(t.viewProjection),invViewProjection:Float64Array.from(t.invViewProjection),height:t.height,toDisplay:o,cut:s,threshold:this.options.threshold,finest:n},d=JSON.stringify([Array.from(r.viewProjection,c=>c.toPrecision(5)),t.height,s,r.threshold,n]);d!==this.chosenFor&&(this.chosenFor=d,clearTimeout(this.choosing),this.choosing=setTimeout(()=>{this.bricks===e&&(e.choose(r),this.onBricks?.())},150))}get hasDetail(){return this.detailPending!==null&&(this.detailPending!==void 0||this.detail!==void 0)}uploadDetail(t,e){if(this.detailTexture&&t.deleteTexture(this.detailTexture),this.detailTexture=void 0,this.detail=e??void 0,e!==null){t.pixelStorei(t.UNPACK_ALIGNMENT,1),this.detailTexture=t.createTexture(),t.bindTexture(t.TEXTURE_3D,this.detailTexture),t.texImage3D(t.TEXTURE_3D,0,t.R8,e.size[0],e.size[1],e.size[2],0,t.RED,t.UNSIGNED_BYTE,e.data);for(const o of[t.TEXTURE_MIN_FILTER,t.TEXTURE_MAG_FILTER])t.texParameteri(t.TEXTURE_3D,o,t.LINEAR);for(const o of[t.TEXTURE_WRAP_S,t.TEXTURE_WRAP_T,t.TEXTURE_WRAP_R])t.texParameteri(t.TEXTURE_3D,o,t.CLAMP_TO_EDGE);t.bindTexture(t.TEXTURE_3D,null)}}get hasVolume(){return this.pending!==void 0||this.uploaded!==void 0}isReady(){return!0}setProblem(t){t!==this.problem&&(this.problem=t,this.onProblem?.())}compile(t,e,o){const i=JSON.stringify([e,o]);if(this.program!==void 0&&this.programFor===i)return this.program;const n=(r,d)=>{const c=t.createShader(r);if(t.shaderSource(c,d),t.compileShader(c),!t.getShaderParameter(c,t.COMPILE_STATUS))throw new Error(t.getShaderInfoLog(c)??"shader did not compile");return c},s=t.createProgram();if(t.attachShader(s,n(t.VERTEX_SHADER,ht)),t.attachShader(s,n(t.FRAGMENT_SHADER,ft(e,o))),t.linkProgram(s),!t.getProgramParameter(s,t.LINK_STATUS))throw new Error(t.getProgramInfoLog(s)??"program did not link");return this.program&&t.deleteProgram(this.program),this.program=s,this.programFor=i,this.vao??=t.createVertexArray(),s}upload(t,e){const{data:o,size:i}=e;this.volumeTexture&&t.deleteTexture(this.volumeTexture),this.occupancy&&t.deleteTexture(this.occupancy),t.pixelStorei(t.UNPACK_ALIGNMENT,1),this.volumeTexture=t.createTexture(),t.bindTexture(t.TEXTURE_3D,this.volumeTexture),t.texImage3D(t.TEXTURE_3D,0,t.R8,i[0],i[1],i[2],0,t.RED,t.UNSIGNED_BYTE,o);for(const c of[t.TEXTURE_MIN_FILTER,t.TEXTURE_MAG_FILTER])t.texParameteri(t.TEXTURE_3D,c,t.LINEAR);for(const c of[t.TEXTURE_WRAP_S,t.TEXTURE_WRAP_T,t.TEXTURE_WRAP_R])t.texParameteri(t.TEXTURE_3D,c,t.CLAMP_TO_EDGE);const n=this.darkBackground,s=i.map(c=>Math.ceil(c/C)),r=new Uint8Array(s[0]*s[1]*s[2]);for(let c=0;c<i[2];++c){const u=c/C|0;for(let p=0;p<i[1];++p){const E=p/C|0;let v=(c*i[1]+p)*i[0];const x=(u*s[1]+E)*s[0];for(let T=0;T<i[0];++T,++v){const l=n?o[v]:255-o[v],h=x+(T/C|0);l>r[h]&&(r[h]=l)}}}const d=new Uint8Array(r.length);for(let c=0;c<s[2];++c)for(let u=0;u<s[1];++u)for(let p=0;p<s[0];++p){let E=0;for(let v=-1;v<=1;++v)for(let x=-1;x<=1;++x)for(let T=-1;T<=1;++T){const l=p+T,h=u+x,f=c+v;if(l<0||h<0||f<0||l>=s[0]||h>=s[1]||f>=s[2])continue;const y=r[(f*s[1]+h)*s[0]+l];y>E&&(E=y)}d[(c*s[1]+u)*s[0]+p]=E}this.occupancy=t.createTexture(),t.bindTexture(t.TEXTURE_3D,this.occupancy),t.texImage3D(t.TEXTURE_3D,0,t.R8,s[0],s[1],s[2],0,t.RED,t.UNSIGNED_BYTE,d);for(const c of[t.TEXTURE_MIN_FILTER,t.TEXTURE_MAG_FILTER])t.texParameteri(t.TEXTURE_3D,c,t.NEAREST);for(const c of[t.TEXTURE_WRAP_S,t.TEXTURE_WRAP_T,t.TEXTURE_WRAP_R])t.texParameteri(t.TEXTURE_3D,c,t.CLAMP_TO_EDGE);t.bindTexture(t.TEXTURE_3D,null),this.occScale=i.map((c,u)=>c/(s[u]*C)),this.uploaded=e,this.dropBricks()}geometry(t,e,o){const i=I(e,this.voxelToRas),n=[1/0,1/0,1/0],s=[-1/0,-1/0,-1/0];for(let v=0;v<8;++v){const x=[0,1,2].map(T=>v>>T&1?o[T]-.5:-.5);for(let T=0;T<3;++T){const l=i[4*T]*x[0]+i[4*T+1]*x[1]+i[4*T+2]*x[2]+i[4*T+3];n[T]=Math.min(n[T],l),s[T]=Math.max(s[T],l)}}const r=[0,1,2].map(v=>Math.hypot(i[4*v],i[4*v+1],i[4*v+2])),d=t.invViewProjection,c=v=>{const x=d[11]*v+d[15];return[0,1,2].map(T=>(d[8+T]*v+d[12+T])/x)},u=c(-1),p=c(1),E=[0,1,2].map(v=>p[v]-u[v]>0?-1:1);return{voxelToDisplay:i,lo:n,hi:s,voxel:r,side:E}}sectionClip(t){const e=this.uploaded??this.pending;if(e===void 0||this.voxelToRas===void 0)return;const o=G(t.dimensions);if(o===void 0)return;if(!this.options.cut)return{lower:[1,1,1],upper:[0,0,0]};const{lo:i,hi:n,voxel:s,side:r}=this.geometry(t,o,e.size),d=Math.min(...s)*.01,c=t.position;return{lower:[0,1,2].map(u=>(r[u]>0?c[u]:i[u])-d),upper:[0,1,2].map(u=>(r[u]>0?n[u]:c[u])+d)}}draw(t){const{gl:e}=t;this.gl!==e&&(this.dropBricks(),this.atlas=void 0,this.gl=e,this.program=void 0,this.vao=void 0,this.uploaded&&(this.pending??=this.uploaded),this.detail&&(this.detailPending??=this.detail)),this.pending!==void 0&&(this.upload(e,this.pending),this.pending=void 0),this.detailPending!==void 0&&(this.uploadDetail(e,this.detailPending),this.detailPending=void 0);const o=this.uploaded;if(o===void 0||this.voxelToRas===void 0)return;const i=G(t.dimensions);if(i===void 0){this.setProblem(`The 3-D view shows ${t.dimensions.names.join(", ")}; the volume needs x, y and z.`);return}this.setProblem(void 0);const{size:n}=o,{voxelToDisplay:s,lo:r,hi:d,voxel:c,side:u}=this.geometry(t,i,n),p=this.brickSource;p!==void 0&&this.bricks===void 0&&this.bricksFailed===void 0&&this.makeBricks(e,p,o);const E=p!==void 0?this.bricks:void 0;let v=0;E!==void 0&&(this.uploadBricks(e,E),v=Math.max(0,E.levels.findIndex(b=>b.index>=p.finest)),this.chooseBricks(t,E,i,u,v));const x=this.compile(e,t.outputs,E!==void 0);if(x===void 0)return;const T=Float64Array.from([1/n[0],0,0,.5/n[0],0,1/n[1],0,.5/n[1],0,0,1/n[2],.5/n[2],0,0,0,1]),l=I(T,O(s)),h=Math.min(...c)*(t.moving?.9:.45);e.useProgram(x);const f=b=>e.getUniformLocation(x,b);e.uniformMatrix4fv(f("uInvViewProj"),!1,t.invViewProjection),e.uniformMatrix4fv(f("uViewProj"),!1,t.viewProjection),e.uniformMatrix4fv(f("uWorldToTex"),!1,V(l)),e.uniform3fv(f("uOccScale"),this.occScale),e.uniform3fv(f("uBoxLo"),r),e.uniform3fv(f("uBoxHi"),d),e.uniform1f(f("uStep"),h),e.uniform1f(f("uBlockStep"),Math.min(...c)*C*.5),e.uniform1f(f("uThreshold"),this.options.threshold),e.uniform1i(f("uCut"),this.options.cut?1:0),e.uniform3fv(f("uCutPoint"),t.position),e.uniform3fv(f("uCutSide"),u),e.uniform3fv(f("uVoxel"),c),e.uniform1i(f("uDarkBackground"),this.darkBackground?1:0),e.uniform2fv(f("uWindow"),this.window),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_3D,this.volumeTexture),e.uniform1i(f("uVolume"),0),e.activeTexture(e.TEXTURE1),e.bindTexture(e.TEXTURE_3D,this.occupancy),e.uniform1i(f("uOccupancy"),1);const y=this.detail;if(e.uniform1i(f("uHasDetail"),y!==void 0&&this.detailTexture!==void 0?1:0),e.activeTexture(e.TEXTURE2),e.bindTexture(e.TEXTURE_3D,this.detailTexture??this.volumeTexture),e.uniform1i(f("uDetail"),2),y!==void 0){const b=y.size,w=I(i,y.voxelToDisplay),k=Float64Array.from([1/b[0],0,0,.5/b[0],0,1/b[1],0,.5/b[1],0,0,1/b[2],.5/b[2],0,0,0,1]);e.uniformMatrix4fv(f("uWorldToDetail"),!1,V(I(k,O(w))));const A=[0,1,2].map(M=>Math.hypot(w[4*M],w[4*M+1],w[4*M+2]));e.uniform1f(f("uDetailStep"),Math.min(...A)*(t.moving?.9:.45)),e.uniform3fv(f("uDetailVoxel"),A)}if(E!==void 0){const b=new Float32Array(16*L),w=new Int32Array(3*L),k=new Int32Array(3*L),A=new Float32Array(L),M=new Float32Array(3*L);E.levels.forEach((U,m)=>{const R=I(i,U.voxelToRas);b.set(V(O(R)),16*m),w.set(E.layout.offsets[m],3*m),k.set(E.layout.grids[m],3*m);const _=[0,1,2].map(D=>Math.hypot(R[4*D],R[4*D+1],R[4*D+2]));M.set(_,3*m),A[m]=Math.min(..._)*(t.moving?.9:.45)}),e.uniformMatrix4fv(f("uWorldToLevel"),!1,b),e.uniform3iv(f("uPageOffset"),w),e.uniform3iv(f("uPageGrid"),k),e.uniform1fv(f("uLevelStep"),A),e.uniform3fv(f("uLevelVoxel"),M),e.uniform1i(f("uLevelCount"),E.levels.length),e.uniform1i(f("uFirstLevel"),v),e.uniform3fv(f("uAtlasTexel"),new Array(3).fill(1/(E.slotsPerAxis*S))),e.activeTexture(e.TEXTURE3),e.bindTexture(e.TEXTURE_3D,this.atlas),e.uniform1i(f("uAtlas"),3),e.activeTexture(e.TEXTURE4),e.bindTexture(e.TEXTURE_3D,this.pageTexture),e.uniform1i(f("uPages"),4)}e.bindVertexArray(this.vao),e.drawArrays(e.TRIANGLES,0,3),E!==void 0&&(e.activeTexture(e.TEXTURE4),e.bindTexture(e.TEXTURE_3D,null),e.activeTexture(e.TEXTURE3),e.bindTexture(e.TEXTURE_3D,null)),e.activeTexture(e.TEXTURE2),e.bindTexture(e.TEXTURE_3D,null),e.activeTexture(e.TEXTURE1),e.bindTexture(e.TEXTURE_3D,null),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_3D,null),this.voxelSize}dispose(){const t=this.gl;t!==void 0&&(this.program&&t.deleteProgram(this.program),this.vao&&t.deleteVertexArray(this.vao),this.volumeTexture&&t.deleteTexture(this.volumeTexture),this.occupancy&&t.deleteTexture(this.occupancy),this.detailTexture&&t.deleteTexture(this.detailTexture),this.dropBricks(),this.atlas&&t.deleteTexture(this.atlas),this.program=this.vao=this.volumeTexture=this.occupancy=this.detailTexture=this.atlas=void 0,this.gl=void 0)}}export{xt as S,pt as a,dt as b,G as d,O as i,I as m,mt as p,Tt as s};
