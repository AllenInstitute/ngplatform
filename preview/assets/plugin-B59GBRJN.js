import{a as F}from"./manifest-B1g39yLh.js";function D(h,t){const e=new Float64Array(16);for(let i=0;i<4;++i)for(let o=0;o<4;++o){let s=0;for(let n=0;n<4;++n)s+=h[4*i+n]*t[4*n+o];e[4*i+o]=s}return e}function _(h){const t=Array.from({length:4},(e,i)=>[...h.slice(4*i,4*i+4),...[0,1,2,3].map(o=>o===i?1:0)]);for(let e=0;e<4;++e){let i=e;for(let s=e+1;s<4;++s)Math.abs(t[s][e])>Math.abs(t[i][e])&&(i=s);if(Math.abs(t[i][e])<1e-300)throw new Error("singular transform");[t[e],t[i]]=[t[i],t[e]];const o=t[e][e];for(let s=0;s<8;++s)t[e][s]/=o;for(let s=0;s<4;++s){if(s===e)continue;const n=t[s][e];if(n!==0)for(let r=0;r<8;++r)t[s][r]-=n*t[e][r]}}return Float64Array.from(t.flatMap(e=>e.slice(4)))}function U(h,t){const e=[];for(let i=0;i<3;++i)e.push(h[4*i]*t[0]+h[4*i+1]*t[1]+h[4*i+2]*t[2]+h[4*i+3]);return e}function N(h,t){const e=[0,1,2].map(s=>t[h.axes.indexOf("xyz"[s])]),i=[1/0,1/0,1/0],o=[-1/0,-1/0,-1/0];for(let s=0;s<8;++s){const n=[0,1,2].map(l=>s>>l&1?e[l]-.5:-.5),r=U(h.voxelToRas,n);for(let l=0;l<3;++l)i[l]=Math.min(i[l],r[l]),o[l]=Math.max(o[l],r[l])}return{lo:i,hi:o}}const R=8,k=`#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`,B=`#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uVolume;
uniform sampler3D uOccupancy;
uniform sampler2D uPlane0;
uniform sampler2D uPlane1;
uniform sampler2D uPlane2;
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
uniform bvec3 uPlaneReady;
uniform vec4 uPlaneRect[3];
uniform float uVoxel;
in vec2 vNdc;
out vec4 outColor;

vec2 slab(vec3 o, vec3 inv, vec3 lo, vec3 hi, out vec3 tExit) {
  vec3 a = (lo - o) * inv;
  vec3 b = (hi - o) * inv;
  vec3 tmin = min(a, b);
  tExit = max(a, b);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tExit.x, tExit.y), tExit.z));
}

vec3 texOf(vec3 p) { return (uWorldToTex * vec4(p, 1.0)).xyz; }

float value(vec3 p) {
  vec3 tc = texOf(p);
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) return 1.0;
  return texture(uVolume, tc).r;
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

float section(int axis, vec3 p, out bool ok) {
  vec2 uv = axis == 0 ? p.yz : axis == 1 ? p.xz : p.xy;
  vec4 r = uPlaneRect[axis];
  vec2 tc = (uv - r.xz) / (r.yw - r.xz);
  ok = all(greaterThanEqual(tc, vec2(0.0))) && all(lessThanEqual(tc, vec2(1.0)));
  if (axis == 0) { ok = ok && uPlaneReady.x; return texture(uPlane0, tc).r; }
  if (axis == 1) { ok = ok && uPlaneReady.y; return texture(uPlane1, tc).r; }
  ok = ok && uPlaneReady.z;
  return texture(uPlane2, tc).r;
}

void main() {
  vec4 n = uInvViewProj * vec4(vNdc, -1.0, 1.0);
  vec4 f = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 o = n.xyz / n.w;
  vec3 d = normalize(f.xyz / f.w - o);
  vec3 inv = 1.0 / (d + vec3(equal(d, vec3(0.0))) * 1e-9);
  vec3 unused;
  vec2 box = slab(o, inv, uBoxLo, uBoxHi, unused);
  float t = max(box.x, 0.0);
  if (t >= box.y) discard;
  // The removed octant, as an interval along the ray.
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
  float before = t;
  for (int i = 0; i < 4096; ++i) {
    if (t > box.y) break;
    if (oct.x < oct.y && t >= oct.x && t < oct.y) {
      t = oct.y + 1e-4;
      face = true;
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
  if (face) {
    // On a cut face: the section of the face the ray left the octant by.
    int axis = octExit.x <= octExit.y && octExit.x <= octExit.z ? 0 : octExit.y <= octExit.z ? 1 : 2;
    bool ok;
    float v = section(axis, p, ok);
    if (!ok) v = value(p);
    colour = vec3(v) * vec3(1.0, 0.97, 0.93);
  } else {
    // Refine the surface between the last empty sample and this one.
    float a = before;
    float b = t;
    for (int k = 0; k < 5; ++k) {
      float m = 0.5 * (a + b);
      vec3 q = o + d * m;
      if (!removed(q) && value(q) < threshold) b = m; else a = m;
    }
    t = b;
    p = o + d * t;
    float h = uVoxel;
    vec3 g = vec3(
      value(p + vec3(h, 0.0, 0.0)) - value(p - vec3(h, 0.0, 0.0)),
      value(p + vec3(0.0, h, 0.0)) - value(p - vec3(0.0, h, 0.0)),
      value(p + vec3(0.0, 0.0, h)) - value(p - vec3(0.0, 0.0, h)));
    vec3 normal = length(g) > 1e-6 ? normalize(g) : -d;
    if (dot(normal, d) > 0.0) normal = -normal;
    float tissue = value(p - normal * 2.0 * h);
    vec3 base = mix(vec3(0.42, 0.33, 0.31), vec3(0.86, 0.80, 0.74), smoothstep(0.35, 0.9, tissue));
    vec3 light = normalize(-d + vec3(0.0, 0.0, 0.35));
    float diffuse = max(dot(normal, light), 0.0);
    float spec = pow(max(dot(reflect(-light, normal), -d), 0.0), 24.0);
    colour = base * (0.28 + 0.72 * diffuse) + 0.12 * spec;
  }
  vec4 clip = uViewProj * vec4(p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  outColor = vec4(colour, 1.0);
}`,z=`#version 300 es
in vec3 aPos;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }`,V=`#version 300 es
precision highp float;
uniform vec3 uColour;
out vec4 outColor;
void main() { outColor = vec4(uColour, 1.0); }`;function M(h,t,e){const i=h.createProgram();for(const[o,s]of[[h.VERTEX_SHADER,t],[h.FRAGMENT_SHADER,e]]){const n=h.createShader(o);if(h.shaderSource(n,s),h.compileShader(n),!h.getShaderParameter(n,h.COMPILE_STATUS))throw new Error(`shader: ${h.getShaderInfoLog(n)}`);h.attachShader(i,n)}if(h.linkProgram(i),!h.getProgramParameter(i,h.LINK_STATUS))throw new Error(`program: ${h.getProgramInfoLog(i)}`);return i}function A(h){const t=new Float32Array(16);for(let e=0;e<4;++e)for(let i=0;i<4;++i)t[4*i+e]=h[4*e+i];return t}function O(h,t){const{target:e,distance:i,yaw:o,pitch:s}=h,n=[e[0]+i*Math.cos(s)*Math.cos(o),e[1]+i*Math.cos(s)*Math.sin(o),e[2]+i*Math.sin(s)],r=e.map((E,T)=>E-n[T]),l=Math.hypot(r[0],r[1],r[2]),u=r.map(E=>E/l),v=[0,0,1];let a=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];const c=Math.hypot(a[0],a[1],a[2])||1;a=a.map(E=>E/c);const p=[a[1]*u[2]-a[2]*u[1],a[2]*u[0]-a[0]*u[2],a[0]*u[1]-a[1]*u[0]],d=(E,T)=>E[0]*T[0]+E[1]*T[1]+E[2]*T[2],x=Float64Array.from([...a,-d(a,n),...p,-d(p,n),...u.map(E=>-E),d(u,n),0,0,0,1]),f=Math.max(.5,i*.05),g=i*4+400,b=1/Math.tan(30*Math.PI/180/2),y=Float64Array.from([b/t,0,0,0,0,b,0,0,0,0,(g+f)/(f-g),2*g*f/(f-g),0,0,-1,0]);return D(y,x)}class X{constructor(t){this.canvas=t;const e=t.getContext("webgl2",{antialias:!1,depth:!0,alpha:!1,powerPreference:"default"});if(e===null)throw new Error("This browser has no WebGL2.");this.gl=e,this.brain=M(e,k,B),this.lines=M(e,z,V),this.empty=e.createVertexArray()}gl;brain;lines;empty;volume;occupancy;occScale=[1,1,1];worldToTex;box;voxel=1;planes=[void 0,void 0,void 0];tracts=new Map;target;uniforms=new Map;get ready(){return this.volume!==void 0}u(t,e){const i=`${t===this.brain?"b":"l"}:${e}`;return this.uniforms.has(i)||this.uniforms.set(i,this.gl.getUniformLocation(t,e)),this.uniforms.get(i)}setVolume(t,e,i,o){const{gl:s}=this;this.volume&&s.deleteTexture(this.volume),this.occupancy&&s.deleteTexture(this.occupancy),s.pixelStorei(s.UNPACK_ALIGNMENT,1),this.volume=s.createTexture(),s.bindTexture(s.TEXTURE_3D,this.volume),s.texImage3D(s.TEXTURE_3D,0,s.R8,e[0],e[1],e[2],0,s.RED,s.UNSIGNED_BYTE,t);for(const c of[s.TEXTURE_MIN_FILTER,s.TEXTURE_MAG_FILTER])s.texParameteri(s.TEXTURE_3D,c,s.LINEAR);for(const c of[s.TEXTURE_WRAP_S,s.TEXTURE_WRAP_T,s.TEXTURE_WRAP_R])s.texParameteri(s.TEXTURE_3D,c,s.CLAMP_TO_EDGE);const n=e.map(c=>Math.ceil(c/R)),r=new Uint8Array(n[0]*n[1]*n[2]);for(let c=0;c<e[2];++c){const p=c/R|0;for(let d=0;d<e[1];++d){const x=d/R|0;let f=(c*e[1]+d)*e[0];const g=(p*n[1]+x)*n[0];for(let b=0;b<e[0];++b,++f){const y=255-t[f],E=g+(b/R|0);y>r[E]&&(r[E]=y)}}}const l=new Uint8Array(r.length);for(let c=0;c<n[2];++c)for(let p=0;p<n[1];++p)for(let d=0;d<n[0];++d){let x=0;for(let f=-1;f<=1;++f)for(let g=-1;g<=1;++g)for(let b=-1;b<=1;++b){const y=d+b,E=p+g,T=c+f;if(y<0||E<0||T<0||y>=n[0]||E>=n[1]||T>=n[2])continue;const S=r[(T*n[1]+E)*n[0]+y];S>x&&(x=S)}l[(c*n[1]+p)*n[0]+d]=x}this.occupancy=s.createTexture(),s.bindTexture(s.TEXTURE_3D,this.occupancy),s.texImage3D(s.TEXTURE_3D,0,s.R8,n[0],n[1],n[2],0,s.RED,s.UNSIGNED_BYTE,l);for(const c of[s.TEXTURE_MIN_FILTER,s.TEXTURE_MAG_FILTER])s.texParameteri(s.TEXTURE_3D,c,s.NEAREST);for(const c of[s.TEXTURE_WRAP_S,s.TEXTURE_WRAP_T,s.TEXTURE_WRAP_R])s.texParameteri(s.TEXTURE_3D,c,s.CLAMP_TO_EDGE);this.occScale=e.map((c,p)=>c/(n[p]*R));const u=Float64Array.from([1/e[0],0,0,.5/e[0],0,1/e[1],0,.5/e[1],0,0,1/e[2],.5/e[2],0,0,0,1]);this.worldToTex=D(u,_(i));const v=[1/0,1/0,1/0],a=[-1/0,-1/0,-1/0];for(let c=0;c<8;++c){const p=[0,1,2].map(d=>c>>d&1?e[d]-.5:-.5);for(let d=0;d<3;++d){const x=i[4*d]*p[0]+i[4*d+1]*p[1]+i[4*d+2]*p[2]+i[4*d+3];v[d]=Math.min(v[d],x),a[d]=Math.max(a[d],x)}}this.box={lo:v,hi:a},this.voxel=o}bounds(){return this.box}setPlane(t,e,i,o,s,n){const{gl:r}=this;let l=this.planes[t];if(l===void 0){const u=r.createTexture();r.bindTexture(r.TEXTURE_2D,u);for(const v of[r.TEXTURE_MIN_FILTER,r.TEXTURE_MAG_FILTER])r.texParameteri(r.TEXTURE_2D,v,r.LINEAR);for(const v of[r.TEXTURE_WRAP_S,r.TEXTURE_WRAP_T])r.texParameteri(r.TEXTURE_2D,v,r.CLAMP_TO_EDGE);l={texture:u,rect:s,value:n},this.planes[t]=l}r.pixelStorei(r.UNPACK_ALIGNMENT,1),r.bindTexture(r.TEXTURE_2D,l.texture),r.texImage2D(r.TEXTURE_2D,0,r.R8,i,o,0,r.RED,r.UNSIGNED_BYTE,e),l.rect=s,l.value=n}clearPlanes(){for(const t of this.planes)t&&this.gl.deleteTexture(t.texture);this.planes=[void 0,void 0,void 0]}setTracts(t,e,i,o){this.removeTracts(t);const{gl:s}=this,n=i.length-1,r=new Uint32Array(e.length/3+n);let l=0;for(let p=0;p<n;++p){for(let d=i[p];d<i[p+1];++d)r[l++]=d;r[l++]=4294967295}const u=s.createVertexArray();s.bindVertexArray(u);const v=s.createBuffer();s.bindBuffer(s.ARRAY_BUFFER,v),s.bufferData(s.ARRAY_BUFFER,e,s.STATIC_DRAW);const a=s.getAttribLocation(this.lines,"aPos");s.enableVertexAttribArray(a),s.vertexAttribPointer(a,3,s.FLOAT,!1,0,0);const c=s.createBuffer();s.bindBuffer(s.ELEMENT_ARRAY_BUFFER,c),s.bufferData(s.ELEMENT_ARRAY_BUFFER,r,s.STATIC_DRAW),s.bindVertexArray(null),this.tracts.set(t,{vao:u,buffers:[v,c],count:l,colour:o})}setTractColour(t,e){const i=this.tracts.get(t);i&&(i.colour=e)}removeTracts(t){const e=this.tracts.get(t);if(e!==void 0){this.gl.deleteVertexArray(e.vao);for(const i of e.buffers)this.gl.deleteBuffer(i);this.tracts.delete(t)}}tractIds(){return[...this.tracts.keys()]}frame(t,e){const{gl:i}=this;if(this.target&&this.target.w===t&&this.target.h===e)return this.target;this.target&&(i.deleteFramebuffer(this.target.fb),i.deleteTexture(this.target.colour),i.deleteRenderbuffer(this.target.depth));const o=i.createFramebuffer(),s=i.createTexture();i.bindTexture(i.TEXTURE_2D,s),i.texImage2D(i.TEXTURE_2D,0,i.RGBA8,t,e,0,i.RGBA,i.UNSIGNED_BYTE,null),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.LINEAR),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.LINEAR);const n=i.createRenderbuffer();return i.bindRenderbuffer(i.RENDERBUFFER,n),i.renderbufferStorage(i.RENDERBUFFER,i.DEPTH_COMPONENT24,t,e),i.bindFramebuffer(i.FRAMEBUFFER,o),i.framebufferTexture2D(i.FRAMEBUFFER,i.COLOR_ATTACHMENT0,i.TEXTURE_2D,s,0),i.framebufferRenderbuffer(i.FRAMEBUFFER,i.DEPTH_ATTACHMENT,i.RENDERBUFFER,n),this.target={fb:o,colour:s,depth:n,w:t,h:e},this.target}render(t,e,i=1){const{gl:o,canvas:s}=this,n=Math.max(1,Math.round(s.width*i)),r=Math.max(1,Math.round(s.height*i)),l=this.frame(n,r);o.bindFramebuffer(o.FRAMEBUFFER,l.fb),o.viewport(0,0,n,r),o.clearColor(.04,.04,.05,1),o.clearDepth(1),o.clear(o.COLOR_BUFFER_BIT|o.DEPTH_BUFFER_BIT);const u=O(t,n/r),v=A(u);if(o.enable(o.DEPTH_TEST),o.depthFunc(o.LEQUAL),this.volume&&this.occupancy&&this.worldToTex&&this.box){const a=this.brain;o.useProgram(a),o.activeTexture(o.TEXTURE0),o.bindTexture(o.TEXTURE_3D,this.volume),o.uniform1i(this.u(a,"uVolume"),0),o.activeTexture(o.TEXTURE1),o.bindTexture(o.TEXTURE_3D,this.occupancy),o.uniform1i(this.u(a,"uOccupancy"),1);const c=[!1,!1,!1],p=new Float32Array(12);for(let x=0;x<3;++x){const f=this.planes[x];o.activeTexture(o.TEXTURE2+x),o.bindTexture(o.TEXTURE_2D,f?.texture??null),o.uniform1i(this.u(a,`uPlane${x}`),2+x);const g=f!==void 0&&e.cut!==void 0&&Math.abs(f.value-e.cut[x])<1e-6;c[x]=e.sections&&g,f&&p.set(f.rect,4*x)}o.uniform3i(this.u(a,"uPlaneReady"),+c[0],+c[1],+c[2]),o.uniform4fv(this.u(a,"uPlaneRect"),p),o.uniformMatrix4fv(this.u(a,"uInvViewProj"),!1,A(_(u))),o.uniformMatrix4fv(this.u(a,"uViewProj"),!1,v),o.uniformMatrix4fv(this.u(a,"uWorldToTex"),!1,A(this.worldToTex)),o.uniform3fv(this.u(a,"uOccScale"),this.occScale),o.uniform3fv(this.u(a,"uBoxLo"),this.box.lo),o.uniform3fv(this.u(a,"uBoxHi"),this.box.hi),o.uniform1f(this.u(a,"uVoxel"),this.voxel),o.uniform1f(this.u(a,"uStep"),this.voxel*.6),o.uniform1f(this.u(a,"uBlockStep"),this.voxel*R*.9),o.uniform1f(this.u(a,"uThreshold"),e.threshold);const d=e.cut;if(o.uniform1i(this.u(a,"uCut"),d===void 0?0:1),d!==void 0){o.uniform3fv(this.u(a,"uCutPoint"),d);const x=[t.target[0]+t.distance*Math.cos(t.pitch)*Math.cos(t.yaw),t.target[1]+t.distance*Math.cos(t.pitch)*Math.sin(t.yaw),t.target[2]+t.distance*Math.sin(t.pitch)];o.uniform3fv(this.u(a,"uCutSide"),x.map((f,g)=>f>=d[g]?1:-1))}o.bindVertexArray(this.empty),o.drawArrays(o.TRIANGLES,0,3)}if(e.tracts&&this.tracts.size>0){const a=this.lines;o.useProgram(a),o.uniformMatrix4fv(this.u(a,"uViewProj"),!1,v);for(const c of this.tracts.values())o.uniform3fv(this.u(a,"uColour"),c.colour),o.bindVertexArray(c.vao),o.drawElements(o.LINE_STRIP,c.count,o.UNSIGNED_INT,0)}o.bindVertexArray(null),o.bindFramebuffer(o.READ_FRAMEBUFFER,l.fb),o.bindFramebuffer(o.DRAW_FRAMEBUFFER,null),o.blitFramebuffer(0,0,n,r,0,0,s.width,s.height,o.COLOR_BUFFER_BIT,n===s.width?o.NEAREST:o.LINEAR),o.bindFramebuffer(o.FRAMEBUFFER,null)}dispose(){const{gl:t}=this;for(const e of this.tractIds())this.removeTracts(e);this.clearPlanes(),this.volume&&t.deleteTexture(this.volume),this.occupancy&&t.deleteTexture(this.occupancy),this.target&&(t.deleteFramebuffer(this.target.fb),t.deleteTexture(this.target.colour),t.deleteRenderbuffer(this.target.depth)),t.deleteProgram(this.brain),t.deleteProgram(this.lines),t.getExtension("WEBGL_lose_context")?.loseContext()}}class ${worker=new Worker(new URL(""+new URL("volume_worker-DQAsFd6S.js",import.meta.url).href,import.meta.url),{type:"module",name:"volume view"});nextId=1;pending=new Map;constructor(){this.worker.onmessage=t=>{const e=t.data,i=this.pending.get(e.id);i!==void 0&&(e.type==="progress"?i.progress?.(e.done,e.total):e.type==="plane"&&!e.final?i.partial?.(e):(this.pending.delete(e.id),e.type==="error"?i.reject(new Error(e.message)):i.resolve(e)))}}request(t,e={}){const i=this.nextId++;return new Promise((o,s)=>{this.pending.set(i,{resolve:o,reject:s,progress:e.progress,partial:e.partial}),e.signal?.addEventListener("abort",()=>{this.pending.delete(i)&&(this.worker.postMessage({type:"cancel",id:i}),s(new DOMException("Aborted","AbortError")))}),this.worker.postMessage({...t,id:i})})}open(t,e){return this.request({type:"open",stores:t,space:e})}volume(t,e,i){return this.request({type:"volume",level:t},{progress:e,signal:i})}plane(t,e={}){return this.request({type:"plane",...t},e)}dispose(){this.worker.terminate();for(const t of this.pending.values())t.reject(new Error("closed"));this.pending.clear()}}const P="https://ftp.bigbrainproject.org/bigbrain-ftp/BigBrainRelease.2015/OME_Zarr/",w=[{id:"bigbrain-mni",title:"BigBrain, in MNI ICBM152 2009b (linear)",stores:[`${P}1000um/`,`${P}400um/`,`${P}200um/`,`${P}100um/`],space:"MNI152NLin2009bAsym",credit:"BigBrain (Amunts et al., Science 2013), CC BY-NC-SA 4.0, bigbrainproject.org. OME-Zarr conversion and linear MNI placement by A. Keenlyside (2026). Structure after Open the Mind (C. Sam, BigBrain Hackathon 2026)."}];function L(h){const t=h??{},e=w.find(i=>i.id===t.preset);return{on:t.on===!0,preset:t.preset,stores:Array.isArray(t.stores)&&t.stores.length>0?t.stores.map(String):e?.stores??[],space:t.space??e?.space,solid:typeof t.solid=="number"?t.solid:.4,finest:typeof t.finest=="number"?t.finest:.2,threshold:typeof t.threshold=="number"?t.threshold:.08,cut:t.cut!==!1,sections:t.sections!==!1,tracts:t.tracts!==!1,layout:t.layout}}function I(h){return typeof h=="string"?{"xy-3d":"xy","xz-3d":"xz","yz-3d":"yz","3d":"xy","4panel":"xy","4panel-alt":"xy"}[h]??h:h===void 0?"xy":h}function C(h){const t=h.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);return t?[parseInt(t[1],16)/255,parseInt(t[2],16)/255,parseInt(t[3],16)/255]:[1,1,1]}function m(h,t={},...e){const i=document.createElement(h);for(const[o,s]of Object.entries(t))s===void 0||s===!1||(o.startsWith("on")&&typeof s=="function"?i.addEventListener(o.slice(2),s):o==="class"?i.className=String(s):i.setAttribute(o,s===!0?"":String(s)));for(const o of e)o!=null&&o!==!1&&i.append(o);return i}const q=`
.vv-host { position: absolute; inset: 0; background: #0a0a0d; overflow: hidden; }
.vv-host canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
.vv-host canvas:active { cursor: grabbing; }
.vv-bar { position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; }
.vv-bar button { height: 24px; padding: 0 8px; border-radius: 4px; border: 1px solid #3a3a44; background: rgba(20,20,26,0.85); color: #ddd; font: 12px/1 var(--ui, sans-serif); cursor: pointer; }
.vv-bar button[aria-pressed="true"] { border-color: #8a6a35; color: #f0c070; }
.vv-status { position: absolute; left: 8px; bottom: 6px; right: 8px; font: 11px/1.4 var(--mono, monospace); color: #9a9aa6; pointer-events: none; text-shadow: 0 0 3px #000; }
.vv-title { position: absolute; left: 8px; top: 8px; font: 600 12px/1 var(--ui, sans-serif); color: #cfcfd8; pointer-events: none; text-shadow: 0 0 3px #000; }
.vv-panel { display: grid; gap: 10px; }
.vv-panel .row { display: flex; align-items: center; gap: 8px; }
.vv-panel select, .vv-panel textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--line); border-radius: 4px; background: var(--ink-0); color: var(--text); font: 12px/1.3 var(--ui); padding: 4px; }
.vv-panel textarea { font: 11px/1.4 var(--mono); min-height: 64px; resize: vertical; }
.vv-panel label.check { display: flex; gap: 8px; align-items: center; font-size: 12px; }
.vv-credit { font-size: 11px; color: var(--faint); margin: 0; }
`;class j{constructor(t){this.ctx=t,this.saved=L(t.state.get()),this.offs.push(t.state.onChanged(()=>{this.writing||(this.saved=L(t.state.get()),this.apply())}),t.viewer.onStateChanged(()=>this.followPosition())),t.services.get("trackFiltering.groups").then(e=>{this.tracts=e,this.offs.push(e.onChanged(()=>this.updateTracts())),this.updateTracts()}),this.apply()}saved;writing=!1;client;renderer;levels=[];solid;camera;cut;unmount;host;canvas;statusLine;titleLine;status="";opened="";openToken=0;dirty=!1;interacting=0;sharpTimer;planeTimer;planeController;tracts;tractKeys=new Map;tractController;panelHost;toggles=[];planesKey="";offs=[];dispose(){this.offs.forEach(t=>t()),this.hide()}save(t){this.saved={...this.saved,...t},this.writing=!0;try{this.ctx.state.set(this.saved)}finally{this.writing=!1}this.apply()}toggle(){if(this.saved.on)this.save({on:!1});else{const t=this.saved.stores.length>0?{}:{preset:w[0].id,stores:w[0].stores,space:w[0].space};this.save({on:!0,...t})}}resetCamera(){this.camera=void 0,this.ensureCamera(),this.request()}apply(){this.saved.on?this.show():this.hide();const t=JSON.stringify([this.saved.stores,this.saved.space]);this.saved.on&&t!==this.opened&&this.saved.stores.length>0?(this.opened=t,this.openVolume()):this.saved.on&&this.solid!==void 0&&this.solid!==this.chooseSolid()&&this.loadSolid();const e=JSON.stringify([this.saved.cut,this.saved.sections,this.saved.finest,this.saved.solid,this.saved.stores]);e!==this.planesKey&&(this.planesKey=e,this.requestPlanes()),this.updateTracts(),this.renderPanel();for(const i of this.toggles)i();this.request()}show(){if(this.unmount!==void 0)return;const t=this.ctx.viewer.getState().layout,e=I(t);if(JSON.stringify(e)!==JSON.stringify(t)){this.saved={...this.saved,layout:t},this.writing=!0;try{this.ctx.state.set(this.saved)}finally{this.writing=!1}this.ctx.viewer.patchState(i=>{i.layout=e})}this.unmount=this.ctx.ui.view(i=>this.mount(i))}hide(){if(this.unmount===void 0)return;const t=this.unmount;if(this.unmount=void 0,t(),this.saved.layout!==void 0){const e=this.saved.layout,i=this.ctx.viewer.getState().layout;JSON.stringify(i)===JSON.stringify(I(e))&&this.ctx.viewer.patchState(o=>{o.layout=e})}}mount(t){const e=m("div",{class:"vv-host"}),i=m("canvas",{"aria-label":"Volume view"});this.titleLine=m("div",{class:"vv-title"}),this.statusLine=m("div",{class:"vv-status"});const o=(l,u,v)=>{const a=m("button",{type:"button",title:v,"aria-pressed":String(this.saved[u]),onclick:()=>this.save({[u]:!this.saved[u]})},l);return this.toggles.push(()=>a.setAttribute("aria-pressed",String(this.saved[u]))),a},s=m("div",{class:"vv-bar"},o("Cut","cut","Cut away the octant facing you at the current position"),o("Sections","sections","Show full-resolution sections on the cut faces"),o("Tracts","tracts","Show the visible track groups"),m("button",{type:"button",title:"Reset the camera",onclick:()=>this.resetCamera()},"Reset"),m("button",{type:"button",title:"Back to Neuroglancer's 3-D panel",onclick:()=>this.save({on:!1})},"×"));e.append(i,this.titleLine,s,this.statusLine),t.append(e),this.host=e,this.canvas=i;try{this.renderer=new X(i)}catch(l){this.setStatus(`Cannot draw: ${l.message}`)}if(this.tractKeys.clear(),this.solidData!==void 0&&this.renderer!==void 0){const{data:l,size:u,level:v}=this.solidData;this.renderer.setVolume(l,u,v.voxelToRas,v.voxelSize)}const n=new ResizeObserver(()=>this.resize());n.observe(e);const r=this.bindInput(i);return this.resize(),this.updateTracts(),this.requestPlanes(!0),()=>{n.disconnect(),r(),this.planeController?.abort(),this.tractController?.abort(),this.renderer?.dispose(),this.renderer=void 0,this.toggles=[],this.canvas=void 0,this.host=void 0,e.remove()}}resize(){const t=this.canvas;if(t===void 0)return;const e=Math.min(window.devicePixelRatio||1,1.5);t.width=Math.max(1,Math.round(t.clientWidth*e)),t.height=Math.max(1,Math.round(t.clientHeight*e)),this.request()}bindInput(t){let e;const i=l=>{t.setPointerCapture(l.pointerId),e={x:l.clientX,y:l.clientY,pan:l.shiftKey||l.button!==0},this.interacting++},o=l=>{if(e===void 0||this.camera===void 0)return;const u=l.clientX-e.x,v=l.clientY-e.y;e.x=l.clientX,e.y=l.clientY;const a=this.camera;if(e.pan){const c=[-Math.sin(a.yaw),Math.cos(a.yaw),0],p=[-Math.sin(a.pitch)*Math.cos(a.yaw),-Math.sin(a.pitch)*Math.sin(a.yaw),Math.cos(a.pitch)],d=a.distance*.0012*600/Math.max(200,t.clientHeight);a.target=a.target.map((x,f)=>x-c[f]*u*d+p[f]*v*d)}else a.yaw-=u*.008,a.pitch=Math.max(-1.55,Math.min(1.55,a.pitch+v*.008));this.request()},s=l=>{e!==void 0&&(e=void 0,t.releasePointerCapture(l.pointerId),this.interacting=Math.max(0,this.interacting-1),this.request())},n=l=>{this.camera!==void 0&&(l.preventDefault(),this.camera.distance=Math.max(10,Math.min(2e3,this.camera.distance*Math.exp(l.deltaY*.0012))),this.interacting++,this.request(),setTimeout(()=>{this.interacting=Math.max(0,this.interacting-1),this.request()},120))},r=l=>l.preventDefault();return t.addEventListener("pointerdown",i),t.addEventListener("pointermove",o),t.addEventListener("pointerup",s),t.addEventListener("pointercancel",s),t.addEventListener("wheel",n,{passive:!1}),t.addEventListener("contextmenu",r),()=>{t.removeEventListener("pointerdown",i),t.removeEventListener("pointermove",o),t.removeEventListener("pointerup",s),t.removeEventListener("pointercancel",s),t.removeEventListener("wheel",n),t.removeEventListener("contextmenu",r)}}request(){this.dirty||(this.dirty=!0,requestAnimationFrame(()=>{this.dirty=!1,this.draw(this.interacting>0?.5:1),this.interacting>0&&(this.sharpTimer!==void 0&&clearTimeout(this.sharpTimer),this.sharpTimer=setTimeout(()=>this.request(),160))}))}draw(t){const e=this.renderer;if(e===void 0||this.canvas===void 0)return;this.ensureCamera();const i=this.camera;if(i===void 0){e.render({target:[0,0,0],distance:400,yaw:.8,pitch:.4},this.options(),t);return}performance.now(),e.render(i,this.options(),t),this.titleLine&&(this.titleLine.textContent=this.title),this.statusLine&&(this.statusLine.textContent=this.status)}options(){return{cut:this.saved.cut?this.cut:void 0,sections:this.saved.sections,tracts:this.saved.tracts,threshold:this.saved.threshold}}ensureCamera(){if(this.camera!==void 0)return;const t=this.renderer?.bounds();if(t===void 0)return;const e=t.lo.map((o,s)=>(o+t.hi[s])/2),i=Math.max(...t.hi.map((o,s)=>o-t.lo[s]));this.camera={target:e,distance:i*2.4,yaw:.75,pitch:.42}}title="";setStatus(t){this.status=t,this.statusLine&&(this.statusLine.textContent=t),this.renderPanelStatus()}solidData;async openVolume(){const t=++this.openToken;this.client?.dispose(),this.client=new $,this.levels=[],this.solid=void 0,this.solidData=void 0,this.renderer?.clearPlanes(),this.setStatus("Opening the volume…");try{const e=await this.client.open(this.saved.stores,this.saved.space);if(t!==this.openToken)return;if(this.levels=e.levels,this.title=e.name,this.levels.length===0)throw new Error("the stores hold no image levels");this.setStatus(`${this.levels.length} levels, ${this.levels.map(i=>`${Math.round(i.voxelSize*1e3)} µm`).join(", ")}`),this.renderPanel(),await this.loadSolid()}catch(e){t===this.openToken&&this.setStatus(`Could not open the volume: ${e.message}`)}}chooseSolid(){const t=this.saved.solid*.95;return this.levels.find(e=>e.voxelSize>=t)??this.levels[this.levels.length-1]}async loadSolid(){const t=this.chooseSolid(),e=this.client;if(t===void 0||e===void 0)return;this.solid=t;const i=this.levels.indexOf(t),o=performance.now(),s=`${Math.round(t.voxelSize*1e3)} µm`;this.setStatus(`Loading the solid (${s})…`);const{data:n,size:r}=await e.volume(i,(l,u)=>this.setStatus(`Loading the solid (${s}): ${l} of ${u} chunks`));this.solid!==t||this.client!==e||(this.solidData={data:n,size:r,level:t},this.renderer?.setVolume(n,r,t.voxelToRas,t.voxelSize),this.setStatus(`Solid ${s} in ${((performance.now()-o)/1e3).toFixed(1)} s`),this.followPosition(!0),this.requestPlanes(!0),this.request())}position(){const t=this.ctx.viewer.getState(),e=t.position;if(!Array.isArray(e)||e.length<3)return;const i=t.dimensions??{},o=Object.keys(i),s=[0,0,0];for(const[n,r]of["x","y","z"].entries()){const l=o.indexOf(r),u=l>=0?l:n,[v,a]=i[r]??[.001,"m"];s[n]=(e[u]??0)*(a==="m"?v*1e3:1)}return s}followPosition(t=!1){const e=this.position();e!==void 0&&(!t&&this.cut!==void 0&&e.every((i,o)=>Math.abs(i-this.cut[o])<.001)||(this.cut=e,this.requestPlanes(),this.request()))}requestPlanes(t=!1){this.planeTimer!==void 0&&clearTimeout(this.planeTimer),this.planeTimer=setTimeout(()=>void this.loadPlanes(),t?0:220)}async loadPlanes(){this.planeTimer=void 0;const t=this.renderer,e=this.client,i=this.cut,o=this.solid;if(this.planeController?.abort(),t===void 0||e===void 0||i===void 0||o===void 0||!this.saved.cut||!this.saved.sections)return;const s=new AbortController;this.planeController=s;const n=N(o,o.shape),r=this.levels.filter(u=>u.voxelSize<=o.voxelSize*1.05&&u.voxelSize>=this.saved.finest*.95).reverse(),l=performance.now();try{for(const[u,v]of r.entries()){const a=this.levels.indexOf(v),c=`${Math.round(v.voxelSize*1e3)} µm`,p=[0,0,0],d=[0,0,0],x=()=>this.setStatus(`Sections at ${c}: ${p.reduce((f,g)=>f+g,0)} of ${d.reduce((f,g)=>f+g,0)} chunks`);await Promise.all([0,1,2].map(async f=>{const[g,b]=[0,1,2].filter(T=>T!==f),y=[n.lo[g],n.hi[g],n.lo[b],n.hi[b]],E=await e.plane({level:a,axis:f,value:i[f],rect:y,texel:v.voxelSize},{signal:s.signal,progress:(T,S)=>{p[f]=T,d[f]=S,x()},partial:u===0?T=>(t.setPlane(f,T.data,T.width,T.height,y,i[f]),this.request()):void 0});s.signal.aborted||this.renderer!==t||(t.setPlane(f,E.data,E.width,E.height,y,i[f]),this.request())}))}this.setStatus(`Sections at ${Math.round((r[r.length-1]?.voxelSize??0)*1e3)} µm in ${((performance.now()-l)/1e3).toFixed(1)} s`)}catch(u){s.signal.aborted||this.setStatus(`Sections: ${u.message}`)}}updateTracts(){const t=this.renderer,e=this.tracts;if(t===void 0||e===void 0)return;const i=e.list().filter(s=>s.visible&&s.exact&&s.count>0),o=new Set(i.map(s=>s.id));for(const s of t.tractIds())o.has(s)||(t.removeTracts(s),this.tractKeys.delete(s));for(const s of i){const n=`${s.version}`;t.setTractColour(s.id,C(s.colour)),this.tractKeys.get(s.id)!==n&&(this.tractKeys.set(s.id,n),e.curves(s.id,15e5).then(r=>{this.renderer!==t||this.tractKeys.get(s.id)!==n||(t.setTracts(s.id,r.positions,r.offsets,C(s.colour)),this.request())},r=>{this.tractKeys.get(s.id)===n&&this.tractKeys.delete(s.id),this.ctx.log.error(`${s.name}: tracts not drawn: ${r.message}`)}))}this.request()}panelStatus;render(t){return this.panelHost=t,this.renderPanel(),()=>{this.panelHost=void 0,this.panelStatus=void 0}}levelSelects(t){const e=this.saved,i=r=>`${r<1?r.toFixed(2):r.toFixed(1)} mm`;if(this.levels.length===0)return[t("Solid",e.solid,[[1,"about 1 mm (lightest)"],[.4,"about 0.4 mm"]],r=>this.save({solid:r})),t("Sections down to",e.finest,[[.4,"about 0.4 mm"],[.2,"about 0.2 mm"],[.1,"about 0.1 mm"]],r=>this.save({finest:r}))];const o=this.chooseSolid(),s=this.levels.filter(r=>r.size[0]*r.size[1]*r.size[2]<=64e6),n=this.levels.find(r=>r.voxelSize>=e.finest*.95)??this.levels[this.levels.length-1];return[t("Solid",o?.voxelSize??e.solid,s.map(r=>[r.voxelSize,`${i(r.voxelSize)}${r===s[s.length-1]?" (lightest)":""}`]),r=>this.save({solid:r})),t("Sections down to",n.voxelSize,this.levels.filter(r=>o===void 0||r.voxelSize<=o.voxelSize*1.05).map((r,l)=>[r.voxelSize,`${i(r.voxelSize)}${l===0?" (finest; the most to download)":""}`]),r=>this.save({finest:r}))]}renderPanelStatus(){this.panelStatus&&(this.panelStatus.textContent=this.status)}renderPanel(){const t=this.panelHost;if(t===void 0)return;const e=this.saved,i=m("input",{type:"checkbox",class:"switch",role:"switch","aria-label":"Volume view on"});i.checked=e.on,i.addEventListener("change",()=>this.toggle());const o=m("select",{"aria-label":"Volume"});for(const c of w)o.append(m("option",{value:c.id},c.title));o.append(m("option",{value:""},"Other OME-Zarr stores…")),o.value=e.preset??(e.stores.length>0?"":w[0].id);const s=m("textarea",{"aria-label":"OME-Zarr stores, one per line",spellcheck:"false",hidden:o.value!==""});s.value=e.stores.join(`
`);const n=m("input",{class:"text-input","aria-label":"Coordinate system",placeholder:"coordinate system (e.g. MNI152NLin2009bAsym)",value:e.space??"",hidden:o.value!==""});o.addEventListener("change",()=>{const c=w.find(p=>p.id===o.value);c?this.save({preset:c.id,stores:c.stores,space:c.space}):(s.hidden=!1,n.hidden=!1)});const r=()=>this.save({preset:void 0,stores:s.value.split(/\s+/).filter(Boolean),space:n.value.trim()||void 0});s.addEventListener("change",r),n.addEventListener("change",r);const l=(c,p,d,x)=>{const f=m("select",{"aria-label":c});for(const[g,b]of d)f.append(m("option",{value:String(g)},b));return f.value=String(p),f.addEventListener("change",()=>x(Number(f.value))),m("label",{class:"field"},m("span",{},c),f)},u=m("input",{type:"range",min:"0.02",max:"0.4",step:"0.01",value:String(e.threshold),"aria-label":"Tissue threshold"});u.addEventListener("input",()=>{this.saved={...this.saved,threshold:Number(u.value)},this.request()}),u.addEventListener("change",()=>this.save({threshold:Number(u.value)}));const v=(c,p)=>{const d=m("input",{type:"checkbox"});return d.checked=e[p],d.addEventListener("change",()=>this.save({[p]:d.checked})),m("label",{class:"check"},d,c)};this.panelStatus=m("p",{class:"note"},this.status);const a=w.find(c=>c.id===e.preset)?.credit;t.replaceChildren(m("div",{class:"vv-panel"},m("div",{class:"row"},m("h3",{class:"section-title",style:"margin:0;flex:1"},"Volume view"),m("label",{class:"switch-label",title:"In place of Neuroglancer's 3-D panel"},i)),m("p",{class:"note first"},"A solid brain in place of the 3-D panel, cut open at the current position (move it in the 2-D views), with sections on the cut and the visible track groups. Drag to turn, shift-drag to move, scroll to zoom."),m("label",{class:"field"},m("span",{},"Volume"),o),s,n,...this.levelSelects(l),m("label",{class:"field"},m("span",{},"Surface"),u),v("Cut away the octant facing the camera","cut"),v("Sections on the cut faces","sections"),v("Track groups","tracts"),this.panelStatus,a?m("p",{class:"vv-credit"},a):null))}}const H={activate(h){const t=m("style",{},q);document.head.append(t),h.subscriptions.push(()=>t.remove());const e=new j(h);h.subscriptions.push(()=>e.dispose()),h.ui.panel(F,i=>e.render(i)),h.commands.register("volumeView.toggle",()=>e.toggle()),h.commands.register("volumeView.resetCamera",()=>e.resetCamera())}};export{w as PRESETS,H as plugin,L as readSaved,I as twoDimensional};
