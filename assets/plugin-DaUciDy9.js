import{a as U}from"./manifest-BEZh128j.js";import{s as D}from"./sources-BkQe8t6M.js";import{o as q}from"./sources-BkQe8t6M.js";import"./sources-BJAQVHmw.js";function S(u,e){const t=new Float64Array(16);for(let o=0;o<4;++o)for(let i=0;i<4;++i){let n=0;for(let s=0;s<4;++s)n+=u[4*o+s]*e[4*s+i];t[4*o+i]=n}return t}function L(u){const e=Array.from({length:4},(t,o)=>[...u.slice(4*o,4*o+4),...[0,1,2,3].map(i=>i===o?1:0)]);for(let t=0;t<4;++t){let o=t;for(let n=t+1;n<4;++n)Math.abs(e[n][t])>Math.abs(e[o][t])&&(o=n);if(Math.abs(e[o][t])<1e-300)throw new Error("singular transform");[e[t],e[o]]=[e[o],e[t]];const i=e[t][t];for(let n=0;n<8;++n)e[t][n]/=i;for(let n=0;n<4;++n){if(n===t)continue;const s=e[n][t];if(s!==0)for(let l=0;l<8;++l)e[n][l]-=s*e[t][l]}}return Float64Array.from(e.flatMap(t=>t.slice(4)))}const w=8,A=`#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`,z=u=>`#version 300 es
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
layout(location = ${u.color}) out vec4 out_color;
layout(location = ${u.z}) out highp vec4 out_z;
layout(location = ${u.pick}) out highp vec4 out_pickId;

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
}`;function M(u,e){const[t,o,i]=e;let n=0,s=0;for(let l=0;l<i;++l)for(let a=0;a<o;++a){const r=(l*o+a)*t;if(l===0||l===i-1||a===0||a===o-1){for(let h=0;h<t;++h)n+=u[r+h];s+=t}else n+=u[r]+u[r+t-1],s+=2}return s===0?255:n/s}function V(u,e){const t=new Float64Array(256);for(let r=0;r<u.length;++r)t[u[r]]++;const[o,i]=e?[21,256]:[0,235];let n=0;for(let r=o;r<i;++r)n+=t[r];if(n===0)return[0,1];const s=r=>{let h=0;for(let p=o;p<i;++p)if(h+=t[p],h>=r*n)return p;return i-1},l=s(.01),a=Math.max(s(.995),l+1);return[l/255,a/255]}function I(u){const e=new Float32Array(16);for(let t=0;t<4;++t)for(let o=0;o<4;++o)e[4*o+t]=u[4*t+o];return e}function R(u){const e=new Float64Array(16);e[15]=1;for(let t=0;t<3;++t){const o=["x","y","z"].indexOf(u.names[t]);if(o===-1)return;const n=u.units[t]==="m"?.001:1;e[4*t+o]=n/u.scales[t]}return e}class C{options={threshold:.08,cut:!0};program;programFor;vao;gl;volumeTexture;occupancy;uploaded;pending;voxelToRas;occScale=[1,1,1];darkBackground=!0;window=[0,1];voxelSize=1;problem;onProblem;setVolume(e,t,o,i){this.voxelToRas=o,this.voxelSize=i,this.darkBackground=M(e,t)<128,this.window=V(e,this.darkBackground),this.pending={data:e,size:t,voxelToDisplay:o}}get hasVolume(){return this.pending!==void 0||this.uploaded!==void 0}isReady(){return!0}setProblem(e){e!==this.problem&&(this.problem=e,this.onProblem?.())}compile(e,t){const o=JSON.stringify(t);if(this.program!==void 0&&this.programFor===o)return this.program;const i=(s,l)=>{const a=e.createShader(s);if(e.shaderSource(a,l),e.compileShader(a),!e.getShaderParameter(a,e.COMPILE_STATUS))throw new Error(e.getShaderInfoLog(a)??"shader did not compile");return a},n=e.createProgram();if(e.attachShader(n,i(e.VERTEX_SHADER,A)),e.attachShader(n,i(e.FRAGMENT_SHADER,z(t))),e.linkProgram(n),!e.getProgramParameter(n,e.LINK_STATUS))throw new Error(e.getProgramInfoLog(n)??"program did not link");return this.program&&e.deleteProgram(this.program),this.program=n,this.programFor=o,this.vao??=e.createVertexArray(),n}upload(e,t){const{data:o,size:i}=t;this.volumeTexture&&e.deleteTexture(this.volumeTexture),this.occupancy&&e.deleteTexture(this.occupancy),e.pixelStorei(e.UNPACK_ALIGNMENT,1),this.volumeTexture=e.createTexture(),e.bindTexture(e.TEXTURE_3D,this.volumeTexture),e.texImage3D(e.TEXTURE_3D,0,e.R8,i[0],i[1],i[2],0,e.RED,e.UNSIGNED_BYTE,o);for(const r of[e.TEXTURE_MIN_FILTER,e.TEXTURE_MAG_FILTER])e.texParameteri(e.TEXTURE_3D,r,e.LINEAR);for(const r of[e.TEXTURE_WRAP_S,e.TEXTURE_WRAP_T,e.TEXTURE_WRAP_R])e.texParameteri(e.TEXTURE_3D,r,e.CLAMP_TO_EDGE);const n=this.darkBackground,s=i.map(r=>Math.ceil(r/w)),l=new Uint8Array(s[0]*s[1]*s[2]);for(let r=0;r<i[2];++r){const h=r/w|0;for(let p=0;p<i[1];++p){const m=p/w|0;let d=(r*i[1]+p)*i[0];const f=(h*s[1]+m)*s[0];for(let c=0;c<i[0];++c,++d){const x=n?o[d]:255-o[d],g=f+(c/w|0);x>l[g]&&(l[g]=x)}}}const a=new Uint8Array(l.length);for(let r=0;r<s[2];++r)for(let h=0;h<s[1];++h)for(let p=0;p<s[0];++p){let m=0;for(let d=-1;d<=1;++d)for(let f=-1;f<=1;++f)for(let c=-1;c<=1;++c){const x=p+c,g=h+f,E=r+d;if(x<0||g<0||E<0||x>=s[0]||g>=s[1]||E>=s[2])continue;const _=l[(E*s[1]+g)*s[0]+x];_>m&&(m=_)}a[(r*s[1]+h)*s[0]+p]=m}this.occupancy=e.createTexture(),e.bindTexture(e.TEXTURE_3D,this.occupancy),e.texImage3D(e.TEXTURE_3D,0,e.R8,s[0],s[1],s[2],0,e.RED,e.UNSIGNED_BYTE,a);for(const r of[e.TEXTURE_MIN_FILTER,e.TEXTURE_MAG_FILTER])e.texParameteri(e.TEXTURE_3D,r,e.NEAREST);for(const r of[e.TEXTURE_WRAP_S,e.TEXTURE_WRAP_T,e.TEXTURE_WRAP_R])e.texParameteri(e.TEXTURE_3D,r,e.CLAMP_TO_EDGE);e.bindTexture(e.TEXTURE_3D,null),this.occScale=i.map((r,h)=>r/(s[h]*w)),this.uploaded=t}geometry(e,t,o){const i=S(t,this.voxelToRas),n=[1/0,1/0,1/0],s=[-1/0,-1/0,-1/0];for(let d=0;d<8;++d){const f=[0,1,2].map(c=>d>>c&1?o[c]-.5:-.5);for(let c=0;c<3;++c){const x=i[4*c]*f[0]+i[4*c+1]*f[1]+i[4*c+2]*f[2]+i[4*c+3];n[c]=Math.min(n[c],x),s[c]=Math.max(s[c],x)}}const l=[0,1,2].map(d=>Math.hypot(i[4*d],i[4*d+1],i[4*d+2])),a=e.invViewProjection,r=d=>{const f=a[11]*d+a[15];return[0,1,2].map(c=>(a[8+c]*d+a[12+c])/f)},h=r(-1),p=r(1),m=[0,1,2].map(d=>p[d]-h[d]>0?-1:1);return{voxelToDisplay:i,lo:n,hi:s,voxel:l,side:m}}sectionClip(e){const t=this.uploaded??this.pending;if(t===void 0||this.voxelToRas===void 0)return;const o=R(e.dimensions);if(o===void 0)return;if(!this.options.cut)return{lower:[1,1,1],upper:[0,0,0]};const{lo:i,hi:n,voxel:s,side:l}=this.geometry(e,o,t.size),a=Math.min(...s)*.01,r=e.position;return{lower:[0,1,2].map(h=>(l[h]>0?r[h]:i[h])-a),upper:[0,1,2].map(h=>(l[h]>0?n[h]:r[h])+a)}}draw(e){const{gl:t}=e;this.gl!==t&&(this.gl=t,this.program=void 0,this.vao=void 0,this.uploaded&&(this.pending??=this.uploaded)),this.pending!==void 0&&(this.upload(t,this.pending),this.pending=void 0);const o=this.uploaded;if(o===void 0||this.voxelToRas===void 0)return;const i=R(e.dimensions);if(i===void 0){this.setProblem(`The 3-D view shows ${e.dimensions.names.join(", ")}; the volume needs x, y and z.`);return}this.setProblem(void 0);const n=this.compile(t,e.outputs);if(n===void 0)return;const{size:s}=o,{voxelToDisplay:l,lo:a,hi:r,voxel:h,side:p}=this.geometry(e,i,s),m=Float64Array.from([1/s[0],0,0,.5/s[0],0,1/s[1],0,.5/s[1],0,0,1/s[2],.5/s[2],0,0,0,1]),d=S(m,L(l)),f=Math.min(...h)*(e.moving?.9:.45);t.useProgram(n);const c=x=>t.getUniformLocation(n,x);t.uniformMatrix4fv(c("uInvViewProj"),!1,e.invViewProjection),t.uniformMatrix4fv(c("uViewProj"),!1,e.viewProjection),t.uniformMatrix4fv(c("uWorldToTex"),!1,I(d)),t.uniform3fv(c("uOccScale"),this.occScale),t.uniform3fv(c("uBoxLo"),a),t.uniform3fv(c("uBoxHi"),r),t.uniform1f(c("uStep"),f),t.uniform1f(c("uBlockStep"),Math.min(...h)*w*.5),t.uniform1f(c("uThreshold"),this.options.threshold),t.uniform1i(c("uCut"),this.options.cut?1:0),t.uniform3fv(c("uCutPoint"),e.position),t.uniform3fv(c("uCutSide"),p),t.uniform3fv(c("uVoxel"),h),t.uniform1i(c("uDarkBackground"),this.darkBackground?1:0),t.uniform2fv(c("uWindow"),this.window),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_3D,this.volumeTexture),t.uniform1i(c("uVolume"),0),t.activeTexture(t.TEXTURE1),t.bindTexture(t.TEXTURE_3D,this.occupancy),t.uniform1i(c("uOccupancy"),1),t.bindVertexArray(this.vao),t.drawArrays(t.TRIANGLES,0,3),t.activeTexture(t.TEXTURE1),t.bindTexture(t.TEXTURE_3D,null),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_3D,null),this.voxelSize}dispose(){const e=this.gl;e!==void 0&&(this.program&&e.deleteProgram(this.program),this.vao&&e.deleteVertexArray(this.vao),this.volumeTexture&&e.deleteTexture(this.volumeTexture),this.occupancy&&e.deleteTexture(this.occupancy),this.program=this.vao=this.volumeTexture=this.occupancy=void 0,this.gl=void 0)}}class B{worker=new Worker(new URL(""+new URL("volume_worker-B3k33K_K.js",import.meta.url).href,import.meta.url),{type:"module",name:"volume view"});nextId=1;pending=new Map;constructor(){this.worker.onmessage=e=>{const t=e.data,o=this.pending.get(t.id);o!==void 0&&(t.type==="progress"?o.progress?.(t.done,t.total):t.type==="plane"&&!t.final?o.partial?.(t):(this.pending.delete(t.id),t.type==="error"?o.reject(new Error(t.message)):o.resolve(t)))}}request(e,t={}){const o=this.nextId++;return new Promise((i,n)=>{this.pending.set(o,{resolve:i,reject:n,progress:t.progress,partial:t.partial}),t.signal?.addEventListener("abort",()=>{this.pending.delete(o)&&(this.worker.postMessage({type:"cancel",id:o}),n(new DOMException("Aborted","AbortError")))}),this.worker.postMessage({...e,id:o})})}open(e,t){return this.request({type:"open",stores:e,space:t})}volume(e,t,o,i){return this.request({type:"volume",level:e,region:i},{progress:t,signal:o})}plane(e,t={}){return this.request({type:"plane",...e},t)}dispose(){this.worker.terminate();for(const e of this.pending.values())e.reject(new Error("closed"));this.pending.clear()}}const P=384,y=256;function k(u){const e=u??{};return{on:e.on===!0,layer:typeof e.layer=="string"?e.layer:void 0,solid:typeof e.solid=="number"?e.solid:0,threshold:typeof e.threshold=="number"?e.threshold:.2,cut:e.cut!==!1}}function v(u,e={},...t){const o=document.createElement(u);for(const[i,n]of Object.entries(e))n===void 0||n===!1||(i.startsWith("on")&&typeof n=="function"?o.addEventListener(i.slice(2),n):i==="class"?o.className=String(n):o.setAttribute(i,n===!0?"":String(n)));for(const i of t)i!=null&&i!==!1&&o.append(i);return o}const b=u=>u>=1?`${+u.toFixed(2)} mm`:`${Math.round(u*1e3)} µm`;class N{constructor(e){this.ctx=e,this.saved=k(e.state.get()),this.drawer.onProblem=()=>this.setStatus(this.drawer.problem??""),this.toggle=e.ui.viewToggle({label:"Volume",title:"Draw an image as a solid, cut open at the position (the Volume tab has its settings)",value:this.saved.on,onChange:t=>this.set({on:t})}),this.offs.push(e.state.onChanged(()=>{const t=k(e.state.get());JSON.stringify(t)!==JSON.stringify(this.saved)&&(this.saved=t,this.toggle.set(t.on),this.update())}),e.viewer.onLayersChanged(()=>this.update()),e.viewer.onStateChanged(()=>{this.saved.on&&(clearTimeout(this.follow),this.follow=setTimeout(()=>{const t=this.saved.solid===0&&this.autoFor!==this.autoVoxel();(this.region!==void 0||t)&&this.update()},400))}),()=>clearTimeout(this.follow)),this.update()}saved;drawer=new C;client;handle;handleLayer;levels=[];store;loaded;loading;status="";toggle;panelUpdate;offs=[];follow;set(e){this.saved={...this.saved,...e},this.ctx.state.set(this.saved),e.on!==void 0&&this.toggle.set(e.on),this.update()}setStatus(e){this.status=e,this.panelUpdate?.()}candidates(){return this.ctx.viewer.layers().filter(e=>e.type==="image"&&D(e.sources[0])!==void 0)}target(){const e=this.candidates();return e.find(t=>t.name===this.saved.layer)??e[0]}chooseLevel(){const e=(this.saved.solid>0?this.saved.solid:this.autoVoxel())*.95;return this.levels.find(t=>t.voxelSize>=e)??this.levels[this.levels.length-1]}autoVoxel(){const e=this.ctx.viewer.getState(),t=Object.values(e.dimensions??{}).filter(([,i])=>i==="m").map(([i])=>i);return e.projectionScale===void 0||t.length===0?1:.75*(e.projectionScale*Math.min(...t)*1e3)/y}autoFor;positionIn(e){const t=this.ctx.viewer.getState(),o=t.dimensions;if(t.position===void 0||o===void 0)return;const i=Object.keys(o),n=R({names:i,scales:i.map(a=>o[a][0]),units:i.map(a=>o[a][1])});if(n===void 0)return;const s=L(S(n,e.voxelToRas)),l=t.position;return[0,1,2].map(a=>s[4*a]*l[0]+s[4*a+1]*l[1]+s[4*a+2]*l[2]+s[4*a+3])}region;regionFor(e){if(Math.max(...e.size)<=P)return;const t=this.positionIn(e)??e.size.map(s=>s/2),o=this.region;if(o!==void 0&&this.regionLevel===e.path&&[0,1,2].every(s=>Math.abs(t[s]-(o.lo[s]+o.hi[s])/2)<=y/4))return o;const i=[0,1,2].map(s=>Math.max(0,Math.min(e.size[s]-y,Math.round(t[s]-y/2)))),n=[0,1,2].map(s=>Math.min(e.size[s],i[s]+y));return{lo:i,hi:n}}regionLevel;updating=!1;update(){if(!this.updating){this.updating=!0;try{this.updateNow()}finally{this.updating=!1}}}updateNow(){const{saved:e}=this;this.drawer.options={threshold:e.threshold,cut:e.cut};const t=e.on?this.target():void 0;if(this.sectionBackground(e.on&&t!==void 0),!e.on||t===void 0){if(this.handle?.dispose(),this.handle=void 0,this.handleLayer=void 0,e.on){const i="No image here that volume rendering reads (OME-Zarr or precomputed).";this.status!==i&&this.ctx.ui.toast(i),this.setStatus(i)}else this.setStatus("");this.panelUpdate?.();return}this.ctx.viewer.getState().layout?.toString().match(/3d|4panel/)||this.ctx.viewer.patchState(i=>{i.layout="xy-3d"});const o=D(t.sources[0]);if(o!==this.store)this.store=o,this.levels=[],this.loaded=void 0,this.region=void 0,this.open(o);else if(this.levels.length>0){this.autoFor=this.autoVoxel();const i=this.chooseLevel();if(i!==void 0){const n=this.regionFor(i),s=`${o}|${i.path}|${n?.lo.join(",")??""}`;s!==this.loaded&&(this.region=n,this.regionLevel=i.path,this.load(i,s,n))}}this.handleLayer!==t.name&&(this.handle?.dispose(),this.handleLayer=t.name,this.handle=this.ctx.viewer.draw3d(t.name,{draw:i=>this.drawer.draw(i),isReady:()=>this.drawer.isReady(),sectionClip:i=>this.drawer.sectionClip(i)})),this.handle?.redraw(),this.panelUpdate?.()}hidBackground=!1;sectionBackground(e){const t=this.ctx.viewer.getState();e&&t.hideCrossSectionBackground3D!==!0?(this.hidBackground=!0,this.ctx.viewer.patchState(o=>{o.hideCrossSectionBackground3D=!0})):!e&&this.hidBackground&&(this.hidBackground=!1,this.ctx.viewer.patchState(o=>{delete o.hideCrossSectionBackground3D}))}async open(e){this.client??=new B,this.setStatus("Opening the image…");try{const t=await this.client.open([e],void 0);if(this.store!==e)return;if(this.levels=t.levels,this.levels.length===0)throw new Error("it has no image levels");this.update()}catch(t){this.store===e&&this.setStatus(`Could not open the image: ${t.message}`)}}async load(e,t,o){const i=this.client;if(i===void 0)return;this.loading?.abort();const n=this.loading=new AbortController;this.loaded=t;const s=this.levels.indexOf(e),l=b(e.voxelSize),a=performance.now();this.setStatus(`Loading the solid (${l})…`);try{const{data:r,size:h}=await i.volume(s,(d,f)=>this.setStatus(`Loading the solid (${l}): ${d} of ${f} chunks`),n.signal,o);if(n.signal.aborted)return;const p=new Float64Array(e.voxelToRas);if(o!==void 0)for(let d=0;d<3;++d)p[4*d+3]+=[0,1,2].reduce((f,c)=>f+e.voxelToRas[4*d+c]*o.lo[c],0);this.drawer.setVolume(r,h,p,e.voxelSize),this.handle?.redraw();const m=o===void 0?"":", a box around the position";this.setStatus(`Solid at ${l} (${h.join(" × ")} voxels${m}), in ${((performance.now()-a)/1e3).toFixed(1)} s`)}catch(r){if(n.signal.aborted)return;this.loaded=void 0,this.setStatus(`Could not load the solid: ${r.message}`)}}render(e){const t=()=>{const{saved:o}=this,i=this.candidates(),n=this.target(),s=v("input",{type:"checkbox","aria-label":"Volume rendering"});s.checked=o.on,s.addEventListener("change",()=>this.set({on:s.checked}));const l=v("select",{class:"text-input","aria-label":"Image"});for(const d of i)l.append(v("option",{value:d.name},d.name));n&&(l.value=n.name),l.disabled=i.length<2,l.addEventListener("change",()=>this.set({layer:l.value}));const a=v("select",{class:"text-input","aria-label":"Detail"}),r=this.chooseLevel();a.append(v("option",{value:"0"},`Automatic${o.solid===0&&r?` (${b(r.voxelSize)})`:""}`));for(const d of this.levels){const f=Math.max(...d.size)>P;a.append(v("option",{value:String(d.voxelSize)},`${b(d.voxelSize)} · ${f?`a ${y}³ box`:d.size.join(" × ")}`))}a.value=o.solid===0||r===void 0?"0":String(r.voxelSize),a.disabled=this.levels.length===0,a.addEventListener("change",()=>this.set({solid:Number(a.value)}));const h=v("input",{type:"range",min:"0.01",max:"0.9",step:"0.01",value:String(o.threshold),"aria-label":"Tissue threshold"}),p=v("span",{class:"type"},o.threshold.toFixed(2));h.addEventListener("input",()=>{p.textContent=Number(h.value).toFixed(2),this.drawer.options={...this.drawer.options,threshold:Number(h.value)},this.handle?.redraw()}),h.addEventListener("change",()=>this.set({threshold:Number(h.value)}));const m=v("input",{type:"checkbox"});m.checked=o.cut,m.addEventListener("change",()=>this.set({cut:m.checked})),e.replaceChildren(v("div",{class:"vv-panel"},v("label",{class:"vv-row"},v("span",{class:"vv-label"},"Volume rendering"),s),v("p",{class:"note"},"An image as a solid in the 3-D view, cut open at the position. Also “Volume” beside “Sections” there."),v("label",{class:"field"},v("span",{},"Image"),i.length?l:v("span",{class:"note"},"No OME-Zarr or precomputed image here.")),v("label",{class:"field"},v("span",{},"Detail"),a),v("label",{class:"field"},v("span",{},"Tissue threshold"),v("div",{class:"vv-row"},h,p)),v("label",{class:"field check"},m,v("span",{},"Cut away the octant facing the camera")),this.status?v("p",{class:"note"},this.status):null))};return this.panelUpdate=t,t(),()=>{this.panelUpdate===t&&(this.panelUpdate=void 0)}}dispose(){this.offs.forEach(e=>e()),this.loading?.abort(),this.handle?.dispose(),this.toggle.dispose(),this.drawer.dispose(),this.client?.dispose()}}const O=`
.vv-panel { display: grid; gap: 10px; }
.vv-row { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.vv-row input[type="range"] { flex: 1; }
.vv-label { font-weight: 600; }
`;let T;const j={activate(u){const e=v("style",{},O);document.head.append(e),T=new N(u);const t=T;u.subscriptions.push(()=>e.remove()),u.subscriptions.push(()=>{t.dispose(),T===t&&(T=void 0)}),u.ui.panel(U,o=>t.render(o)),u.commands.register("volumeView.toggle",()=>{const o=k(u.state.get());u.state.set({...o,on:!o.on})})}};export{q as omeZarrUrl,j as plugin,k as readSaved,D as storeOf};
