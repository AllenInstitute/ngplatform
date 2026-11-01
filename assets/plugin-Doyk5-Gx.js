import{a as D}from"./manifest-BEZh128j.js";function S(a,e){const t=new Float64Array(16);for(let o=0;o<4;++o)for(let i=0;i<4;++i){let s=0;for(let r=0;r<4;++r)s+=a[4*o+r]*e[4*r+i];t[4*o+i]=s}return t}function P(a){const e=Array.from({length:4},(t,o)=>[...a.slice(4*o,4*o+4),...[0,1,2,3].map(i=>i===o?1:0)]);for(let t=0;t<4;++t){let o=t;for(let s=t+1;s<4;++s)Math.abs(e[s][t])>Math.abs(e[o][t])&&(o=s);if(Math.abs(e[o][t])<1e-300)throw new Error("singular transform");[e[t],e[o]]=[e[o],e[t]];const i=e[t][t];for(let s=0;s<8;++s)e[t][s]/=i;for(let s=0;s<4;++s){if(s===t)continue;const r=e[s][t];if(r!==0)for(let d=0;d<8;++d)e[s][d]-=r*e[t][d]}}return Float64Array.from(e.flatMap(t=>t.slice(4)))}const w=8,U=`#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`,z=a=>`#version 300 es
precision highp float;
precision highp sampler3D;
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

float raw(vec3 p) {
  vec3 tc = texOf(p);
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) return uDarkBackground ? 0.0 : 1.0;
  return texture(uVolume, tc).r;
}

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
    if (value(p) < threshold) {
      hit = true;
      break;
    }
    face = false;
    before = t;
    t += uStep;
  }
  if (!hit) discard;
  vec3 p = o + d * t;
  vec3 colour;
  float behind = 0.0;
  if (face) {
    colour = vec3(shown(raw(p)));
    behind = 2e-5;
  } else {
    float a = before;
    float b = t;
    for (int k = 0; k < 5; ++k) {
      float m = 0.5 * (a + b);
      vec3 q = o + d * m;
      if (!removed(q) && value(q) < threshold) b = m; else a = m;
    }
    t = b;
    p = o + d * t;
    vec3 h = uVoxel;
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
}`;function L(a,e){const[t,o,i]=e;let s=0,r=0;for(let d=0;d<i;++d)for(let u=0;u<o;++u){const n=(d*o+u)*t;if(d===0||d===i-1||u===0||u===o-1){for(let l=0;l<t;++l)s+=a[n+l];r+=t}else s+=a[n]+a[n+t-1],r+=2}return r===0?255:s/r}function A(a,e){const t=new Float64Array(256);for(let n=0;n<a.length;++n)t[a[n]]++;const[o,i]=e?[21,256]:[0,235];let s=0;for(let n=o;n<i;++n)s+=t[n];if(s===0)return[0,1];const r=n=>{let l=0;for(let p=o;p<i;++p)if(l+=t[p],l>=n*s)return p;return i-1},d=r(.01),u=Math.max(r(.995),d+1);return[d/255,u/255]}function M(a){const e=new Float32Array(16);for(let t=0;t<4;++t)for(let o=0;o<4;++o)e[4*o+t]=a[4*t+o];return e}function k(a){const e=new Float64Array(16);e[15]=1;for(let t=0;t<3;++t){const o=["x","y","z"].indexOf(a.names[t]);if(o===-1)return;const s=a.units[t]==="m"?.001:1;e[4*t+o]=s/a.scales[t]}return e}class V{options={threshold:.08,cut:!0};program;programFor;vao;gl;volumeTexture;occupancy;uploaded;pending;voxelToRas;occScale=[1,1,1];darkBackground=!0;window=[0,1];voxelSize=1;problem;onProblem;setVolume(e,t,o,i){this.voxelToRas=o,this.voxelSize=i,this.darkBackground=L(e,t)<128,this.window=A(e,this.darkBackground),this.pending={data:e,size:t,voxelToDisplay:o}}get hasVolume(){return this.pending!==void 0||this.uploaded!==void 0}isReady(){return!0}setProblem(e){e!==this.problem&&(this.problem=e,this.onProblem?.())}compile(e,t){const o=JSON.stringify(t);if(this.program!==void 0&&this.programFor===o)return this.program;const i=(r,d)=>{const u=e.createShader(r);if(e.shaderSource(u,d),e.compileShader(u),!e.getShaderParameter(u,e.COMPILE_STATUS))throw new Error(e.getShaderInfoLog(u)??"shader did not compile");return u},s=e.createProgram();if(e.attachShader(s,i(e.VERTEX_SHADER,U)),e.attachShader(s,i(e.FRAGMENT_SHADER,z(t))),e.linkProgram(s),!e.getProgramParameter(s,e.LINK_STATUS))throw new Error(e.getProgramInfoLog(s)??"program did not link");return this.program&&e.deleteProgram(this.program),this.program=s,this.programFor=o,this.vao??=e.createVertexArray(),s}upload(e,t){const{data:o,size:i}=t;this.volumeTexture&&e.deleteTexture(this.volumeTexture),this.occupancy&&e.deleteTexture(this.occupancy),e.pixelStorei(e.UNPACK_ALIGNMENT,1),this.volumeTexture=e.createTexture(),e.bindTexture(e.TEXTURE_3D,this.volumeTexture),e.texImage3D(e.TEXTURE_3D,0,e.R8,i[0],i[1],i[2],0,e.RED,e.UNSIGNED_BYTE,o);for(const n of[e.TEXTURE_MIN_FILTER,e.TEXTURE_MAG_FILTER])e.texParameteri(e.TEXTURE_3D,n,e.LINEAR);for(const n of[e.TEXTURE_WRAP_S,e.TEXTURE_WRAP_T,e.TEXTURE_WRAP_R])e.texParameteri(e.TEXTURE_3D,n,e.CLAMP_TO_EDGE);const s=this.darkBackground,r=i.map(n=>Math.ceil(n/w)),d=new Uint8Array(r[0]*r[1]*r[2]);for(let n=0;n<i[2];++n){const l=n/w|0;for(let p=0;p<i[1];++p){const m=p/w|0;let h=(n*i[1]+p)*i[0];const f=(l*r[1]+m)*r[0];for(let c=0;c<i[0];++c,++h){const g=s?o[h]:255-o[h],x=f+(c/w|0);g>d[x]&&(d[x]=g)}}}const u=new Uint8Array(d.length);for(let n=0;n<r[2];++n)for(let l=0;l<r[1];++l)for(let p=0;p<r[0];++p){let m=0;for(let h=-1;h<=1;++h)for(let f=-1;f<=1;++f)for(let c=-1;c<=1;++c){const g=p+c,x=l+f,T=n+h;if(g<0||x<0||T<0||g>=r[0]||x>=r[1]||T>=r[2])continue;const b=d[(T*r[1]+x)*r[0]+g];b>m&&(m=b)}u[(n*r[1]+l)*r[0]+p]=m}this.occupancy=e.createTexture(),e.bindTexture(e.TEXTURE_3D,this.occupancy),e.texImage3D(e.TEXTURE_3D,0,e.R8,r[0],r[1],r[2],0,e.RED,e.UNSIGNED_BYTE,u);for(const n of[e.TEXTURE_MIN_FILTER,e.TEXTURE_MAG_FILTER])e.texParameteri(e.TEXTURE_3D,n,e.NEAREST);for(const n of[e.TEXTURE_WRAP_S,e.TEXTURE_WRAP_T,e.TEXTURE_WRAP_R])e.texParameteri(e.TEXTURE_3D,n,e.CLAMP_TO_EDGE);e.bindTexture(e.TEXTURE_3D,null),this.occScale=i.map((n,l)=>n/(r[l]*w)),this.uploaded=t}geometry(e,t,o){const i=S(t,this.voxelToRas),s=[1/0,1/0,1/0],r=[-1/0,-1/0,-1/0];for(let h=0;h<8;++h){const f=[0,1,2].map(c=>h>>c&1?o[c]-.5:-.5);for(let c=0;c<3;++c){const g=i[4*c]*f[0]+i[4*c+1]*f[1]+i[4*c+2]*f[2]+i[4*c+3];s[c]=Math.min(s[c],g),r[c]=Math.max(r[c],g)}}const d=[0,1,2].map(h=>Math.hypot(i[4*h],i[4*h+1],i[4*h+2])),u=e.invViewProjection,n=h=>{const f=u[11]*h+u[15];return[0,1,2].map(c=>(u[8+c]*h+u[12+c])/f)},l=n(-1),p=n(1),m=[0,1,2].map(h=>p[h]-l[h]>0?-1:1);return{voxelToDisplay:i,lo:s,hi:r,voxel:d,side:m}}sectionClip(e){const t=this.uploaded??this.pending;if(t===void 0||this.voxelToRas===void 0)return;const o=k(e.dimensions);if(o===void 0)return;if(!this.options.cut)return{lower:[1,1,1],upper:[0,0,0]};const{lo:i,hi:s,voxel:r,side:d}=this.geometry(e,o,t.size),u=Math.min(...r)*.01,n=e.position;return{lower:[0,1,2].map(l=>(d[l]>0?n[l]:i[l])-u),upper:[0,1,2].map(l=>(d[l]>0?s[l]:n[l])+u)}}draw(e){const{gl:t}=e;this.gl!==t&&(this.gl=t,this.program=void 0,this.vao=void 0,this.uploaded&&(this.pending??=this.uploaded)),this.pending!==void 0&&(this.upload(t,this.pending),this.pending=void 0);const o=this.uploaded;if(o===void 0||this.voxelToRas===void 0)return;const i=k(e.dimensions);if(i===void 0){this.setProblem(`The 3-D view shows ${e.dimensions.names.join(", ")}; the volume needs x, y and z.`);return}this.setProblem(void 0);const s=this.compile(t,e.outputs);if(s===void 0)return;const{size:r}=o,{voxelToDisplay:d,lo:u,hi:n,voxel:l,side:p}=this.geometry(e,i,r),m=Float64Array.from([1/r[0],0,0,.5/r[0],0,1/r[1],0,.5/r[1],0,0,1/r[2],.5/r[2],0,0,0,1]),h=S(m,P(d)),f=Math.min(...l)*(e.moving?.9:.45);t.useProgram(s);const c=g=>t.getUniformLocation(s,g);t.uniformMatrix4fv(c("uInvViewProj"),!1,e.invViewProjection),t.uniformMatrix4fv(c("uViewProj"),!1,e.viewProjection),t.uniformMatrix4fv(c("uWorldToTex"),!1,M(h)),t.uniform3fv(c("uOccScale"),this.occScale),t.uniform3fv(c("uBoxLo"),u),t.uniform3fv(c("uBoxHi"),n),t.uniform1f(c("uStep"),f),t.uniform1f(c("uBlockStep"),Math.min(...l)*w*.5),t.uniform1f(c("uThreshold"),this.options.threshold),t.uniform1i(c("uCut"),this.options.cut?1:0),t.uniform3fv(c("uCutPoint"),e.position),t.uniform3fv(c("uCutSide"),p),t.uniform3fv(c("uVoxel"),l),t.uniform1i(c("uDarkBackground"),this.darkBackground?1:0),t.uniform2fv(c("uWindow"),this.window),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_3D,this.volumeTexture),t.uniform1i(c("uVolume"),0),t.activeTexture(t.TEXTURE1),t.bindTexture(t.TEXTURE_3D,this.occupancy),t.uniform1i(c("uOccupancy"),1),t.bindVertexArray(this.vao),t.drawArrays(t.TRIANGLES,0,3),t.activeTexture(t.TEXTURE1),t.bindTexture(t.TEXTURE_3D,null),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_3D,null),this.voxelSize}dispose(){const e=this.gl;e!==void 0&&(this.program&&e.deleteProgram(this.program),this.vao&&e.deleteVertexArray(this.vao),this.volumeTexture&&e.deleteTexture(this.volumeTexture),this.occupancy&&e.deleteTexture(this.occupancy),this.program=this.vao=this.volumeTexture=this.occupancy=void 0,this.gl=void 0)}}class I{worker=new Worker(new URL(""+new URL("volume_worker-TMo0uNQx.js",import.meta.url).href,import.meta.url),{type:"module",name:"volume view"});nextId=1;pending=new Map;constructor(){this.worker.onmessage=e=>{const t=e.data,o=this.pending.get(t.id);o!==void 0&&(t.type==="progress"?o.progress?.(t.done,t.total):t.type==="plane"&&!t.final?o.partial?.(t):(this.pending.delete(t.id),t.type==="error"?o.reject(new Error(t.message)):o.resolve(t)))}}request(e,t={}){const o=this.nextId++;return new Promise((i,s)=>{this.pending.set(o,{resolve:i,reject:s,progress:t.progress,partial:t.partial}),t.signal?.addEventListener("abort",()=>{this.pending.delete(o)&&(this.worker.postMessage({type:"cancel",id:o}),s(new DOMException("Aborted","AbortError")))}),this.worker.postMessage({...e,id:o})})}open(e,t){return this.request({type:"open",stores:e,space:t})}volume(e,t,o){return this.request({type:"volume",level:e},{progress:t,signal:o})}plane(e,t={}){return this.request({type:"plane",...e},t)}dispose(){this.worker.terminate();for(const e of this.pending.values())e.reject(new Error("closed"));this.pending.clear()}}function E(a){const e=a??{};return{on:e.on===!0,layer:typeof e.layer=="string"?e.layer:void 0,solid:typeof e.solid=="number"?e.solid:1,threshold:typeof e.threshold=="number"?e.threshold:.2,cut:e.cut!==!1}}function R(a){if(a===void 0)return;let e=a.trim();const t=/^(zarr2?|zarr3):\/\//i.exec(e),o=/\|zarr[23]?:?[^|]*$/i.exec(e);if(!(t===null&&o===null&&!/\.ome\.zarr\/?$/i.test(e))&&(t&&(e=e.slice(t[0].length)),o&&(e=e.slice(0,o.index)),e=e.replace(/^gs:\/\/([^/]+)\//,"https://storage.googleapis.com/$1/").replace(/^s3:\/\/([^/]+)\//,"https://$1.s3.amazonaws.com/"),!(!/^https?:\/\//.test(e)&&!e.startsWith("/"))))return e.endsWith("/")?e:`${e}/`}function v(a,e={},...t){const o=document.createElement(a);for(const[i,s]of Object.entries(e))s===void 0||s===!1||(i.startsWith("on")&&typeof s=="function"?o.addEventListener(i.slice(2),s):i==="class"?o.className=String(s):o.setAttribute(i,s===!0?"":String(s)));for(const i of t)i!=null&&i!==!1&&o.append(i);return o}const _=a=>a>=1?`${+a.toFixed(2)} mm`:`${Math.round(a*1e3)} µm`;class C{constructor(e){this.ctx=e,this.saved=E(e.state.get()),this.drawer.onProblem=()=>this.setStatus(this.drawer.problem??""),this.toggle=e.ui.viewToggle({label:"Volume",title:"Draw an image as a solid, cut open at the position (the Volume tab has its settings)",value:this.saved.on,onChange:t=>this.set({on:t})}),this.offs.push(e.state.onChanged(()=>{const t=E(e.state.get());JSON.stringify(t)!==JSON.stringify(this.saved)&&(this.saved=t,this.toggle.set(t.on),this.update())}),e.viewer.onLayersChanged(()=>this.update())),this.update()}saved;drawer=new V;client;handle;handleLayer;levels=[];store;loaded;loading;status="";toggle;panelUpdate;offs=[];set(e){this.saved={...this.saved,...e},this.ctx.state.set(this.saved),e.on!==void 0&&this.toggle.set(e.on),this.update()}setStatus(e){this.status=e,this.panelUpdate?.()}candidates(){return this.ctx.viewer.layers().filter(e=>e.type==="image"&&R(e.sources[0])!==void 0)}target(){const e=this.candidates();return e.find(t=>t.name===this.saved.layer)??e[0]}chooseLevel(){const e=this.saved.solid*.95,t=o=>Math.max(...o.size)<=384;return this.levels.find(o=>o.voxelSize>=e&&t(o))??this.levels.find(t)??this.levels[this.levels.length-1]}updating=!1;update(){if(!this.updating){this.updating=!0;try{this.updateNow()}finally{this.updating=!1}}}updateNow(){const{saved:e}=this;this.drawer.options={threshold:e.threshold,cut:e.cut};const t=e.on?this.target():void 0;if(this.sectionBackground(e.on&&t!==void 0),!e.on||t===void 0){this.handle?.dispose(),this.handle=void 0,this.handleLayer=void 0,e.on?this.setStatus("No OME-Zarr image in this scene to draw. Add one (zarr://…) as a dataset."):this.setStatus(""),this.panelUpdate?.();return}this.ctx.viewer.getState().layout?.toString().match(/3d|4panel/)||this.ctx.viewer.patchState(i=>{i.layout="xy-3d"});const o=R(t.sources[0]);if(o!==this.store)this.store=o,this.levels=[],this.loaded=void 0,this.open(o);else if(this.levels.length>0){const i=this.chooseLevel(),s=i&&`${o}|${i.path}`;i!==void 0&&s!==this.loaded&&this.load(i,s)}this.handleLayer!==t.name&&(this.handle?.dispose(),this.handleLayer=t.name,this.handle=this.ctx.viewer.draw3d(t.name,{draw:i=>this.drawer.draw(i),isReady:()=>this.drawer.isReady(),sectionClip:i=>this.drawer.sectionClip(i)})),this.handle?.redraw(),this.panelUpdate?.()}hidBackground=!1;sectionBackground(e){const t=this.ctx.viewer.getState();e&&t.hideCrossSectionBackground3D!==!0?(this.hidBackground=!0,this.ctx.viewer.patchState(o=>{o.hideCrossSectionBackground3D=!0})):!e&&this.hidBackground&&(this.hidBackground=!1,this.ctx.viewer.patchState(o=>{delete o.hideCrossSectionBackground3D}))}async open(e){this.client??=new I,this.setStatus("Opening the image…");try{const t=await this.client.open([e],void 0);if(this.store!==e)return;if(this.levels=t.levels,this.levels.length===0)throw new Error("it has no image levels");this.update()}catch(t){this.store===e&&this.setStatus(`Could not open the image: ${t.message}`)}}async load(e,t){const o=this.client;if(o===void 0)return;this.loading?.abort();const i=this.loading=new AbortController;this.loaded=t;const s=this.levels.indexOf(e),r=_(e.voxelSize),d=performance.now();this.setStatus(`Loading the solid (${r})…`);try{const{data:u,size:n}=await o.volume(s,(l,p)=>this.setStatus(`Loading the solid (${r}): ${l} of ${p} chunks`),i.signal);if(i.signal.aborted)return;this.drawer.setVolume(u,n,e.voxelToRas,e.voxelSize),this.handle?.redraw(),this.setStatus(`Solid at ${r} (${n.join(" × ")} voxels), in ${((performance.now()-d)/1e3).toFixed(1)} s`)}catch(u){if(i.signal.aborted)return;this.loaded=void 0,this.setStatus(`Could not load the solid: ${u.message}`)}}render(e){const t=()=>{const{saved:o}=this,i=this.candidates(),s=this.target(),r=v("input",{type:"checkbox",class:"switch",role:"switch","aria-label":"Volume rendering"});r.checked=o.on,r.addEventListener("change",()=>this.set({on:r.checked}));const d=v("select",{class:"text-input","aria-label":"Image"});for(const h of i)d.append(v("option",{value:h.name},h.name));s&&(d.value=s.name),d.disabled=i.length<2,d.addEventListener("change",()=>this.set({layer:d.value}));const u=v("select",{class:"text-input","aria-label":"Detail"}),n=this.chooseLevel();for(const h of this.levels){const f=Math.max(...h.size)>384;u.append(v("option",{value:String(h.voxelSize),disabled:f},`${_(h.voxelSize)} · ${h.size.join(" × ")}${f?" (too large)":""}`))}n&&(u.value=String(n.voxelSize)),u.disabled=this.levels.length===0,u.addEventListener("change",()=>this.set({solid:Number(u.value)}));const l=v("input",{type:"range",min:"0.01",max:"0.9",step:"0.01",value:String(o.threshold),"aria-label":"Tissue threshold"}),p=v("span",{class:"type"},o.threshold.toFixed(2));l.addEventListener("input",()=>{p.textContent=Number(l.value).toFixed(2),this.drawer.options={...this.drawer.options,threshold:Number(l.value)},this.handle?.redraw()}),l.addEventListener("change",()=>this.set({threshold:Number(l.value)}));const m=v("input",{type:"checkbox"});m.checked=o.cut,m.addEventListener("change",()=>this.set({cut:m.checked})),e.replaceChildren(v("div",{class:"vv-panel"},v("label",{class:"vv-row"},v("span",{class:"vv-label"},"Volume rendering"),r),v("p",{class:"note"},"Draws an image as a solid in the 3-D view, cut open at the position. Also switched with “Volume” beside “Sections” there."),v("label",{class:"field"},v("span",{},"Image"),i.length?d:v("span",{class:"note"},"No OME-Zarr image in this scene.")),v("label",{class:"field"},v("span",{},"Detail"),u),v("label",{class:"field"},v("span",{},"Tissue threshold"),v("div",{class:"vv-row"},l,p)),v("label",{class:"field check"},m,v("span",{},"Cut away the octant facing the camera")),this.status?v("p",{class:"note"},this.status):null))};return this.panelUpdate=t,t(),()=>{this.panelUpdate===t&&(this.panelUpdate=void 0)}}dispose(){this.offs.forEach(e=>e()),this.loading?.abort(),this.handle?.dispose(),this.toggle.dispose(),this.drawer.dispose(),this.client?.dispose()}}const N=`
.vv-panel { display: grid; gap: 10px; }
.vv-row { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.vv-row input[type="range"] { flex: 1; }
.vv-label { font-weight: 600; }
`;let y;const X={activate(a){const e=v("style",{},N);document.head.append(e),y=new C(a);const t=y;a.subscriptions.push(()=>e.remove()),a.subscriptions.push(()=>{t.dispose(),y===t&&(y=void 0)}),a.ui.panel(D,o=>t.render(o)),a.commands.register("volumeView.toggle",()=>{const o=E(a.state.get());a.state.set({...o,on:!o.on})})}};export{R as omeZarrUrl,X as plugin,E as readSaved};
