function z(a,e){const t=new Float64Array(16);for(let o=0;o<4;++o)for(let r=0;r<4;++r){let i=0;for(let n=0;n<4;++n)i+=a[4*o+n]*e[4*n+r];t[4*o+r]=i}return t}function N(a){const e=Array.from({length:4},(t,o)=>[...a.slice(4*o,4*o+4),...[0,1,2,3].map(r=>r===o?1:0)]);for(let t=0;t<4;++t){let o=t;for(let i=t+1;i<4;++i)Math.abs(e[i][t])>Math.abs(e[o][t])&&(o=i);if(Math.abs(e[o][t])<1e-300)throw new Error("singular transform");[e[t],e[o]]=[e[o],e[t]];const r=e[t][t];for(let i=0;i<8;++i)e[t][i]/=r;for(let i=0;i<4;++i){if(i===t)continue;const n=e[i][t];if(n!==0)for(let l=0;l<8;++l)e[i][l]-=n*e[t][l]}}return Float64Array.from(e.flatMap(t=>t.slice(4)))}const O={meter:1e3,m:1e3,millimeter:1,mm:1,micrometer:.001,um:.001,µm:.001,micron:.001,nanometer:1e-6,nm:1e-6},w=a=>typeof a=="string"?a:a?.name;function g(a,e){const o=Array.from({length:e+1},(r,i)=>Array.from({length:e+1},(n,l)=>i===l?1:0));switch(a.type){case"identity":return o;case"scale":return a.scale.forEach((r,i)=>o[i][i]=r),o;case"translation":return a.translation.forEach((r,i)=>o[i][e]=r),o;case"affine":{const r=Array.isArray(a.affine[0])?a.affine:W(a.affine,e+1);for(let i=0;i<e;++i)for(let n=0;n<=e;++n)o[i][n]=r[i][n];return o}case"sequence":return(a.transformations??[]).reduce((r,i)=>S(g(i,e),r),o);default:throw new Error(`unsupported coordinate transform "${a.type}"`)}}function W(a,e){const t=[];for(let o=0;o<a.length;o+=e)t.push(a.slice(o,o+e));return t}function S(a,e){return a.map(t=>e[0].map((o,r)=>t.reduce((i,n,l)=>i+n*e[l][r],0)))}function H(a,e,t){const o=e?.attributes??e??{},i=(o.ome??o)?.multiscales?.[0];if(i===void 0)throw new Error(`${a}: not an OME-Zarr image (no multiscales)`);const n=i.coordinateSystems??[],l=i.datasets??[];if(l.length===0)throw new Error(`${a}: the image has no datasets`);const h=w(l[0].coordinateTransformations?.[0]?.output),c=n.find(d=>d.name===h)??n[0],u=c?.axes??i.axes??[],f=u.length;if(f===0)throw new Error(`${a}: the image names no axes`);if(u.filter(d=>["x","y","z"].includes(d.name)).length!==3||f!==3)throw new Error(`${a}: only 3-D images (axes z, y, x) are shown; this one has ${u.map(d=>d.name).join(", ")}`);const m=i.coordinateTransformations??[],p=m.filter(d=>w(d.input)!==void 0||w(d.output)!==void 0),s=m.filter(d=>!p.includes(d));let T=u,v=c?.name??"physical",E=s.reduce((d,x)=>S(g(x,f),d),g({type:"identity"},f));const D=d=>p.find(x=>w(x.input)===v&&w(x.output)===d&&n.some(b=>b.name===d)),A=(t!==void 0?D(t):void 0)??p.find(d=>w(d.input)===v&&D(w(d.output))!==void 0),R=n.find(d=>d.name===w(A?.output));A!==void 0&&R!==void 0&&R.name!==v&&(E=S(g(A,f),E),T=R.axes,v=R.name);const I=Array.from({length:4},(d,x)=>Array.from({length:f+1},(b,_)=>x===3&&_===f?1:0));T.forEach((d,x)=>{const b={x:0,y:1,z:2}[d.name],_=O[d.unit??"millimeter"]??1;I[b][x]=_});const k=Array.from({length:f+1},(d,x)=>Array.from({length:4},(b,_)=>x===f&&_===3?1:0));u.forEach((d,x)=>{k[x][{x:0,y:1,z:2}[d.name]]=1});const F=l.map(d=>{const x=(d.coordinateTransformations??[]).reduce((P,B)=>S(g(B,f),P),g({type:"identity"},f)),b=S(I,S(E,S(x,k))),_=Float64Array.from(b.flat()),X=[0,1,2].map(P=>Math.hypot(_[P],_[4+P],_[8+P]));return{url:a.endsWith("/")?a:`${a}/`,path:d.path,voxelToRas:_,voxelSize:(X[0]+X[1]+X[2])/3,axes:u.map(P=>P.name)}}),M=i.metadata?.description;return{levels:F,space:v,name:String(i.name??a),description:typeof M=="string"?M:void 0}}function q(a){const e=a.flatMap(o=>o.levels),t=[];for(const o of e)t.some(r=>Math.abs(r.voxelSize-o.voxelSize)<=.02*r.voxelSize)||t.push(o);return t.sort((o,r)=>o.voxelSize-r.voxelSize)}function K(a,e){const t=e.voxel_offset??[0,0,0],o=e.resolution.map(i=>i*1e-6),r=new Float64Array(16);for(let i=0;i<3;++i)r[5*i]=o[i],r[4*i+3]=(t[i]+.5)*o[i];return r[15]=1,{url:a,path:e.key,voxelToRas:r,voxelSize:(o[0]+o[1]+o[2])/3,axes:["z","y","x"]}}const U=8,C=`#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`,G=a=>`#version 300 es
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
uniform bool uHasDetail;
uniform sampler3D uDetail;
uniform mat4 uWorldToDetail;
uniform float uDetailStep;
uniform vec3 uDetailVoxel;
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

float raw(vec3 p) {
  vec3 dc;
  if (inDetail(p, dc)) return texture(uDetail, dc).r;
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
    vec3 dc;
    t += inDetail(p, dc) ? uDetailStep : uStep;
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
    vec3 dc;
    vec3 h = inDetail(p, dc) ? uDetailVoxel : uVoxel;
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
}`;function j(a,e){const[t,o,r]=e;let i=0,n=0;for(let l=0;l<r;++l)for(let h=0;h<o;++h){const c=(l*o+h)*t;if(l===0||l===r-1||h===0||h===o-1){for(let u=0;u<t;++u)i+=a[c+u];n+=t}else i+=a[c]+a[c+t-1],n+=2}return n===0?255:i/n}function $(a,e){const t=new Float64Array(256);for(let c=0;c<a.length;++c)t[a[c]]++;const[o,r]=e?[21,256]:[0,235];let i=0;for(let c=o;c<r;++c)i+=t[c];if(i===0)return[0,1];const n=c=>{let u=0;for(let f=o;f<r;++f)if(u+=t[f],u>=c*i)return f;return r-1},l=n(.01),h=Math.max(n(.995),l+1);return[l/255,h/255]}function V(a){const e=new Float32Array(16);for(let t=0;t<4;++t)for(let o=0;o<4;++o)e[4*o+t]=a[4*t+o];return e}function L(a){const e=new Float64Array(16);e[15]=1;for(let t=0;t<3;++t){const o=["x","y","z"].indexOf(a.names[t]);if(o===-1)return;const i=a.units[t]==="m"?.001:1;e[4*t+o]=i/a.scales[t]}return e}class Y{options={threshold:.08,cut:!0};program;programFor;vao;gl;volumeTexture;occupancy;uploaded;pending;detail;detailTexture;detailPending;voxelToRas;occScale=[1,1,1];darkBackground=!0;window=[0,1];voxelSize=1;problem;onProblem;setVolume(e,t,o,r){this.voxelToRas=o,this.voxelSize=r,this.darkBackground=j(e,t)<128,this.window=$(e,this.darkBackground),this.pending={data:e,size:t,voxelToDisplay:o}}setDetail(e,t,o){this.detailPending=e===void 0?null:{data:e,size:t,voxelToDisplay:o}}get hasDetail(){return this.detailPending!==null&&(this.detailPending!==void 0||this.detail!==void 0)}uploadDetail(e,t){if(this.detailTexture&&e.deleteTexture(this.detailTexture),this.detailTexture=void 0,this.detail=t??void 0,t!==null){e.pixelStorei(e.UNPACK_ALIGNMENT,1),this.detailTexture=e.createTexture(),e.bindTexture(e.TEXTURE_3D,this.detailTexture),e.texImage3D(e.TEXTURE_3D,0,e.R8,t.size[0],t.size[1],t.size[2],0,e.RED,e.UNSIGNED_BYTE,t.data);for(const o of[e.TEXTURE_MIN_FILTER,e.TEXTURE_MAG_FILTER])e.texParameteri(e.TEXTURE_3D,o,e.LINEAR);for(const o of[e.TEXTURE_WRAP_S,e.TEXTURE_WRAP_T,e.TEXTURE_WRAP_R])e.texParameteri(e.TEXTURE_3D,o,e.CLAMP_TO_EDGE);e.bindTexture(e.TEXTURE_3D,null)}}get hasVolume(){return this.pending!==void 0||this.uploaded!==void 0}isReady(){return!0}setProblem(e){e!==this.problem&&(this.problem=e,this.onProblem?.())}compile(e,t){const o=JSON.stringify(t);if(this.program!==void 0&&this.programFor===o)return this.program;const r=(n,l)=>{const h=e.createShader(n);if(e.shaderSource(h,l),e.compileShader(h),!e.getShaderParameter(h,e.COMPILE_STATUS))throw new Error(e.getShaderInfoLog(h)??"shader did not compile");return h},i=e.createProgram();if(e.attachShader(i,r(e.VERTEX_SHADER,C)),e.attachShader(i,r(e.FRAGMENT_SHADER,G(t))),e.linkProgram(i),!e.getProgramParameter(i,e.LINK_STATUS))throw new Error(e.getProgramInfoLog(i)??"program did not link");return this.program&&e.deleteProgram(this.program),this.program=i,this.programFor=o,this.vao??=e.createVertexArray(),i}upload(e,t){const{data:o,size:r}=t;this.volumeTexture&&e.deleteTexture(this.volumeTexture),this.occupancy&&e.deleteTexture(this.occupancy),e.pixelStorei(e.UNPACK_ALIGNMENT,1),this.volumeTexture=e.createTexture(),e.bindTexture(e.TEXTURE_3D,this.volumeTexture),e.texImage3D(e.TEXTURE_3D,0,e.R8,r[0],r[1],r[2],0,e.RED,e.UNSIGNED_BYTE,o);for(const c of[e.TEXTURE_MIN_FILTER,e.TEXTURE_MAG_FILTER])e.texParameteri(e.TEXTURE_3D,c,e.LINEAR);for(const c of[e.TEXTURE_WRAP_S,e.TEXTURE_WRAP_T,e.TEXTURE_WRAP_R])e.texParameteri(e.TEXTURE_3D,c,e.CLAMP_TO_EDGE);const i=this.darkBackground,n=r.map(c=>Math.ceil(c/U)),l=new Uint8Array(n[0]*n[1]*n[2]);for(let c=0;c<r[2];++c){const u=c/U|0;for(let f=0;f<r[1];++f){const y=f/U|0;let m=(c*r[1]+f)*r[0];const p=(u*n[1]+y)*n[0];for(let s=0;s<r[0];++s,++m){const T=i?o[m]:255-o[m],v=p+(s/U|0);T>l[v]&&(l[v]=T)}}}const h=new Uint8Array(l.length);for(let c=0;c<n[2];++c)for(let u=0;u<n[1];++u)for(let f=0;f<n[0];++f){let y=0;for(let m=-1;m<=1;++m)for(let p=-1;p<=1;++p)for(let s=-1;s<=1;++s){const T=f+s,v=u+p,E=c+m;if(T<0||v<0||E<0||T>=n[0]||v>=n[1]||E>=n[2])continue;const D=l[(E*n[1]+v)*n[0]+T];D>y&&(y=D)}h[(c*n[1]+u)*n[0]+f]=y}this.occupancy=e.createTexture(),e.bindTexture(e.TEXTURE_3D,this.occupancy),e.texImage3D(e.TEXTURE_3D,0,e.R8,n[0],n[1],n[2],0,e.RED,e.UNSIGNED_BYTE,h);for(const c of[e.TEXTURE_MIN_FILTER,e.TEXTURE_MAG_FILTER])e.texParameteri(e.TEXTURE_3D,c,e.NEAREST);for(const c of[e.TEXTURE_WRAP_S,e.TEXTURE_WRAP_T,e.TEXTURE_WRAP_R])e.texParameteri(e.TEXTURE_3D,c,e.CLAMP_TO_EDGE);e.bindTexture(e.TEXTURE_3D,null),this.occScale=r.map((c,u)=>c/(n[u]*U)),this.uploaded=t}geometry(e,t,o){const r=z(t,this.voxelToRas),i=[1/0,1/0,1/0],n=[-1/0,-1/0,-1/0];for(let m=0;m<8;++m){const p=[0,1,2].map(s=>m>>s&1?o[s]-.5:-.5);for(let s=0;s<3;++s){const T=r[4*s]*p[0]+r[4*s+1]*p[1]+r[4*s+2]*p[2]+r[4*s+3];i[s]=Math.min(i[s],T),n[s]=Math.max(n[s],T)}}const l=[0,1,2].map(m=>Math.hypot(r[4*m],r[4*m+1],r[4*m+2])),h=e.invViewProjection,c=m=>{const p=h[11]*m+h[15];return[0,1,2].map(s=>(h[8+s]*m+h[12+s])/p)},u=c(-1),f=c(1),y=[0,1,2].map(m=>f[m]-u[m]>0?-1:1);return{voxelToDisplay:r,lo:i,hi:n,voxel:l,side:y}}sectionClip(e){const t=this.uploaded??this.pending;if(t===void 0||this.voxelToRas===void 0)return;const o=L(e.dimensions);if(o===void 0)return;if(!this.options.cut)return{lower:[1,1,1],upper:[0,0,0]};const{lo:r,hi:i,voxel:n,side:l}=this.geometry(e,o,t.size),h=Math.min(...n)*.01,c=e.position;return{lower:[0,1,2].map(u=>(l[u]>0?c[u]:r[u])-h),upper:[0,1,2].map(u=>(l[u]>0?i[u]:c[u])+h)}}draw(e){const{gl:t}=e;this.gl!==t&&(this.gl=t,this.program=void 0,this.vao=void 0,this.uploaded&&(this.pending??=this.uploaded),this.detail&&(this.detailPending??=this.detail)),this.pending!==void 0&&(this.upload(t,this.pending),this.pending=void 0),this.detailPending!==void 0&&(this.uploadDetail(t,this.detailPending),this.detailPending=void 0);const o=this.uploaded;if(o===void 0||this.voxelToRas===void 0)return;const r=L(e.dimensions);if(r===void 0){this.setProblem(`The 3-D view shows ${e.dimensions.names.join(", ")}; the volume needs x, y and z.`);return}this.setProblem(void 0);const i=this.compile(t,e.outputs);if(i===void 0)return;const{size:n}=o,{voxelToDisplay:l,lo:h,hi:c,voxel:u,side:f}=this.geometry(e,r,n),y=Float64Array.from([1/n[0],0,0,.5/n[0],0,1/n[1],0,.5/n[1],0,0,1/n[2],.5/n[2],0,0,0,1]),m=z(y,N(l)),p=Math.min(...u)*(e.moving?.9:.45);t.useProgram(i);const s=v=>t.getUniformLocation(i,v);t.uniformMatrix4fv(s("uInvViewProj"),!1,e.invViewProjection),t.uniformMatrix4fv(s("uViewProj"),!1,e.viewProjection),t.uniformMatrix4fv(s("uWorldToTex"),!1,V(m)),t.uniform3fv(s("uOccScale"),this.occScale),t.uniform3fv(s("uBoxLo"),h),t.uniform3fv(s("uBoxHi"),c),t.uniform1f(s("uStep"),p),t.uniform1f(s("uBlockStep"),Math.min(...u)*U*.5),t.uniform1f(s("uThreshold"),this.options.threshold),t.uniform1i(s("uCut"),this.options.cut?1:0),t.uniform3fv(s("uCutPoint"),e.position),t.uniform3fv(s("uCutSide"),f),t.uniform3fv(s("uVoxel"),u),t.uniform1i(s("uDarkBackground"),this.darkBackground?1:0),t.uniform2fv(s("uWindow"),this.window),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_3D,this.volumeTexture),t.uniform1i(s("uVolume"),0),t.activeTexture(t.TEXTURE1),t.bindTexture(t.TEXTURE_3D,this.occupancy),t.uniform1i(s("uOccupancy"),1);const T=this.detail;if(t.uniform1i(s("uHasDetail"),T!==void 0&&this.detailTexture!==void 0?1:0),t.activeTexture(t.TEXTURE2),t.bindTexture(t.TEXTURE_3D,this.detailTexture??this.volumeTexture),t.uniform1i(s("uDetail"),2),T!==void 0){const v=T.size,E=z(r,T.voxelToDisplay),D=Float64Array.from([1/v[0],0,0,.5/v[0],0,1/v[1],0,.5/v[1],0,0,1/v[2],.5/v[2],0,0,0,1]);t.uniformMatrix4fv(s("uWorldToDetail"),!1,V(z(D,N(E))));const A=[0,1,2].map(R=>Math.hypot(E[4*R],E[4*R+1],E[4*R+2]));t.uniform1f(s("uDetailStep"),Math.min(...A)*(e.moving?.9:.45)),t.uniform3fv(s("uDetailVoxel"),A)}t.bindVertexArray(this.vao),t.drawArrays(t.TRIANGLES,0,3),t.activeTexture(t.TEXTURE2),t.bindTexture(t.TEXTURE_3D,null),t.activeTexture(t.TEXTURE1),t.bindTexture(t.TEXTURE_3D,null),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_3D,null),this.voxelSize}dispose(){const e=this.gl;e!==void 0&&(this.program&&e.deleteProgram(this.program),this.vao&&e.deleteVertexArray(this.vao),this.volumeTexture&&e.deleteTexture(this.volumeTexture),this.occupancy&&e.deleteTexture(this.occupancy),this.detailTexture&&e.deleteTexture(this.detailTexture),this.program=this.vao=this.volumeTexture=this.occupancy=this.detailTexture=void 0,this.gl=void 0)}}export{Y as S,q as a,j as b,L as d,N as i,z as m,H as p,K as s};
