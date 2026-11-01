import{a as F}from"./manifest-B1g39yLh.js";function D(h,t){const e=new Float64Array(16);for(let i=0;i<4;++i)for(let o=0;o<4;++o){let s=0;for(let n=0;n<4;++n)s+=h[4*i+n]*t[4*n+o];e[4*i+o]=s}return e}function P(h){const t=Array.from({length:4},(e,i)=>[...h.slice(4*i,4*i+4),...[0,1,2,3].map(o=>o===i?1:0)]);for(let e=0;e<4;++e){let i=e;for(let s=e+1;s<4;++s)Math.abs(t[s][e])>Math.abs(t[i][e])&&(i=s);if(Math.abs(t[i][e])<1e-300)throw new Error("singular transform");[t[e],t[i]]=[t[i],t[e]];const o=t[e][e];for(let s=0;s<8;++s)t[e][s]/=o;for(let s=0;s<4;++s){if(s===e)continue;const n=t[s][e];if(n!==0)for(let r=0;r<8;++r)t[s][r]-=n*t[e][r]}}return Float64Array.from(t.flatMap(e=>e.slice(4)))}function N(h,t){const e=[];for(let i=0;i<3;++i)e.push(h[4*i]*t[0]+h[4*i+1]*t[1]+h[4*i+2]*t[2]+h[4*i+3]);return e}function U(h,t){const e=[0,1,2].map(s=>t[h.axes.indexOf("xyz"[s])]),i=[1/0,1/0,1/0],o=[-1/0,-1/0,-1/0];for(let s=0;s<8;++s){const n=[0,1,2].map(a=>s>>a&1?e[a]-.5:-.5),r=N(h.voxelToRas,n);for(let a=0;a<3;++a)i[a]=Math.min(i[a],r[a]),o[a]=Math.max(o[a],r[a])}return{lo:i,hi:o}}const R=8,B=`#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`,z=`#version 300 es
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
uniform bool uDarkBackground;
uniform vec2 uWindow;
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

// The stored value, as shown.
float raw(vec3 p) {
  vec3 tc = texOf(p);
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) return uDarkBackground ? 0.0 : 1.0;
  return texture(uVolume, tc).r;
}

// A value as shown on the cut faces: the tissue's range stretched to black..white.
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
    if (!ok) v = raw(p);
    colour = vec3(shown(v)) * vec3(1.0, 0.97, 0.93);
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
    float tissue = raw(p - normal * 2.0 * h);
    vec3 base = mix(vec3(0.42, 0.33, 0.31), vec3(0.86, 0.80, 0.74), smoothstep(0.35, 0.9, tissue));
    vec3 light = normalize(-d + vec3(0.0, 0.0, 0.35));
    float diffuse = max(dot(normal, light), 0.0);
    float spec = pow(max(dot(reflect(-light, normal), -d), 0.0), 24.0);
    colour = base * (0.28 + 0.72 * diffuse) + 0.12 * spec;
  }
  vec4 clip = uViewProj * vec4(p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  outColor = vec4(colour, 1.0);
}`,O=`#version 300 es
in vec3 aPos;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }`,V=`#version 300 es
precision highp float;
uniform vec3 uColour;
out vec4 outColor;
void main() { outColor = vec4(uColour, 1.0); }`;function I(h,t,e){const i=h.createProgram();for(const[o,s]of[[h.VERTEX_SHADER,t],[h.FRAGMENT_SHADER,e]]){const n=h.createShader(o);if(h.shaderSource(n,s),h.compileShader(n),!h.getShaderParameter(n,h.COMPILE_STATUS))throw new Error(`shader: ${h.getShaderInfoLog(n)}`);h.attachShader(i,n)}if(h.linkProgram(i),!h.getProgramParameter(i,h.LINK_STATUS))throw new Error(`program: ${h.getProgramInfoLog(i)}`);return i}function X(h,t){const[e,i,o]=t;let s=0,n=0;for(let r=0;r<o;++r)for(let a=0;a<i;++a){const c=(r*i+a)*e;if(r===0||r===o-1||a===0||a===i-1){for(let f=0;f<e;++f)s+=h[c+f];n+=e}else s+=h[c]+h[c+e-1],n+=2}return n===0?255:s/n}function $(h,t){const e=new Float64Array(256);for(let c=0;c<h.length;++c)e[h[c]]++;const[i,o]=t?[21,256]:[0,235];let s=0;for(let c=i;c<o;++c)s+=e[c];if(s===0)return[0,1];const n=c=>{let f=0;for(let l=i;l<o;++l)if(f+=e[l],f>=c*s)return l;return o-1},r=n(.01),a=Math.max(n(.995),r+1);return[r/255,a/255]}function A(h){const t=new Float32Array(16);for(let e=0;e<4;++e)for(let i=0;i<4;++i)t[4*i+e]=h[4*e+i];return t}function q(h,t){const{target:e,distance:i,yaw:o,pitch:s}=h,n=[e[0]+i*Math.cos(s)*Math.cos(o),e[1]+i*Math.cos(s)*Math.sin(o),e[2]+i*Math.sin(s)],r=e.map((E,b)=>E-n[b]),a=Math.hypot(r[0],r[1],r[2]),c=r.map(E=>E/a),f=[0,0,1];let l=[c[1]*f[2]-c[2]*f[1],c[2]*f[0]-c[0]*f[2],c[0]*f[1]-c[1]*f[0]];const m=Math.hypot(l[0],l[1],l[2])||1;l=l.map(E=>E/m);const u=[l[1]*c[2]-l[2]*c[1],l[2]*c[0]-l[0]*c[2],l[0]*c[1]-l[1]*c[0]],p=(E,b)=>E[0]*b[0]+E[1]*b[1]+E[2]*b[2],v=Float64Array.from([...l,-p(l,n),...u,-p(u,n),...c.map(E=>-E),p(c,n),0,0,0,1]),d=Math.max(.5,i*.05),g=i*4+400,T=1/Math.tan(30*Math.PI/180/2),y=Float64Array.from([T/t,0,0,0,0,T,0,0,0,0,(g+d)/(d-g),2*g*d/(d-g),0,0,-1,0]);return D(y,v)}class W{constructor(t){this.canvas=t;const e=t.getContext("webgl2",{antialias:!1,depth:!0,alpha:!1,powerPreference:"default"});if(e===null)throw new Error("This browser has no WebGL2.");this.gl=e,this.brain=I(e,B,z),this.lines=I(e,O,V),this.empty=e.createVertexArray()}gl;brain;lines;empty;volume;occupancy;occScale=[1,1,1];worldToTex;box;voxel=1;darkBackground=!1;window=[0,1];planes=[void 0,void 0,void 0];tracts=new Map;target;uniforms=new Map;get ready(){return this.volume!==void 0}u(t,e){const i=`${t===this.brain?"b":"l"}:${e}`;return this.uniforms.has(i)||this.uniforms.set(i,this.gl.getUniformLocation(t,e)),this.uniforms.get(i)}setVolume(t,e,i,o){const{gl:s}=this;this.volume&&s.deleteTexture(this.volume),this.occupancy&&s.deleteTexture(this.occupancy),s.pixelStorei(s.UNPACK_ALIGNMENT,1),this.volume=s.createTexture(),s.bindTexture(s.TEXTURE_3D,this.volume),s.texImage3D(s.TEXTURE_3D,0,s.R8,e[0],e[1],e[2],0,s.RED,s.UNSIGNED_BYTE,t);for(const u of[s.TEXTURE_MIN_FILTER,s.TEXTURE_MAG_FILTER])s.texParameteri(s.TEXTURE_3D,u,s.LINEAR);for(const u of[s.TEXTURE_WRAP_S,s.TEXTURE_WRAP_T,s.TEXTURE_WRAP_R])s.texParameteri(s.TEXTURE_3D,u,s.CLAMP_TO_EDGE);this.darkBackground=X(t,e)<128;const n=this.darkBackground;this.window=$(t,n);const r=e.map(u=>Math.ceil(u/R)),a=new Uint8Array(r[0]*r[1]*r[2]);for(let u=0;u<e[2];++u){const p=u/R|0;for(let v=0;v<e[1];++v){const d=v/R|0;let g=(u*e[1]+v)*e[0];const T=(p*r[1]+d)*r[0];for(let y=0;y<e[0];++y,++g){const E=n?t[g]:255-t[g],b=T+(y/R|0);E>a[b]&&(a[b]=E)}}}const c=new Uint8Array(a.length);for(let u=0;u<r[2];++u)for(let p=0;p<r[1];++p)for(let v=0;v<r[0];++v){let d=0;for(let g=-1;g<=1;++g)for(let T=-1;T<=1;++T)for(let y=-1;y<=1;++y){const E=v+y,b=p+T,S=u+g;if(E<0||b<0||S<0||E>=r[0]||b>=r[1]||S>=r[2])continue;const _=a[(S*r[1]+b)*r[0]+E];_>d&&(d=_)}c[(u*r[1]+p)*r[0]+v]=d}this.occupancy=s.createTexture(),s.bindTexture(s.TEXTURE_3D,this.occupancy),s.texImage3D(s.TEXTURE_3D,0,s.R8,r[0],r[1],r[2],0,s.RED,s.UNSIGNED_BYTE,c);for(const u of[s.TEXTURE_MIN_FILTER,s.TEXTURE_MAG_FILTER])s.texParameteri(s.TEXTURE_3D,u,s.NEAREST);for(const u of[s.TEXTURE_WRAP_S,s.TEXTURE_WRAP_T,s.TEXTURE_WRAP_R])s.texParameteri(s.TEXTURE_3D,u,s.CLAMP_TO_EDGE);this.occScale=e.map((u,p)=>u/(r[p]*R));const f=Float64Array.from([1/e[0],0,0,.5/e[0],0,1/e[1],0,.5/e[1],0,0,1/e[2],.5/e[2],0,0,0,1]);this.worldToTex=D(f,P(i));const l=[1/0,1/0,1/0],m=[-1/0,-1/0,-1/0];for(let u=0;u<8;++u){const p=[0,1,2].map(v=>u>>v&1?e[v]-.5:-.5);for(let v=0;v<3;++v){const d=i[4*v]*p[0]+i[4*v+1]*p[1]+i[4*v+2]*p[2]+i[4*v+3];l[v]=Math.min(l[v],d),m[v]=Math.max(m[v],d)}}this.box={lo:l,hi:m},this.voxel=o}bounds(){return this.box}setPlane(t,e,i,o,s,n){const{gl:r}=this;let a=this.planes[t];if(a===void 0){const c=r.createTexture();r.bindTexture(r.TEXTURE_2D,c);for(const f of[r.TEXTURE_MIN_FILTER,r.TEXTURE_MAG_FILTER])r.texParameteri(r.TEXTURE_2D,f,r.LINEAR);for(const f of[r.TEXTURE_WRAP_S,r.TEXTURE_WRAP_T])r.texParameteri(r.TEXTURE_2D,f,r.CLAMP_TO_EDGE);a={texture:c,rect:s,value:n},this.planes[t]=a}r.pixelStorei(r.UNPACK_ALIGNMENT,1),r.bindTexture(r.TEXTURE_2D,a.texture),r.texImage2D(r.TEXTURE_2D,0,r.R8,i,o,0,r.RED,r.UNSIGNED_BYTE,e),a.rect=s,a.value=n}clearPlanes(){for(const t of this.planes)t&&this.gl.deleteTexture(t.texture);this.planes=[void 0,void 0,void 0]}setTracts(t,e,i,o){this.removeTracts(t);const{gl:s}=this,n=i.length-1,r=new Uint32Array(e.length/3+n);let a=0;for(let u=0;u<n;++u){for(let p=i[u];p<i[u+1];++p)r[a++]=p;r[a++]=4294967295}const c=s.createVertexArray();s.bindVertexArray(c);const f=s.createBuffer();s.bindBuffer(s.ARRAY_BUFFER,f),s.bufferData(s.ARRAY_BUFFER,e,s.STATIC_DRAW);const l=s.getAttribLocation(this.lines,"aPos");s.enableVertexAttribArray(l),s.vertexAttribPointer(l,3,s.FLOAT,!1,0,0);const m=s.createBuffer();s.bindBuffer(s.ELEMENT_ARRAY_BUFFER,m),s.bufferData(s.ELEMENT_ARRAY_BUFFER,r,s.STATIC_DRAW),s.bindVertexArray(null),this.tracts.set(t,{vao:c,buffers:[f,m],count:a,colour:o})}setTractColour(t,e){const i=this.tracts.get(t);i&&(i.colour=e)}removeTracts(t){const e=this.tracts.get(t);if(e!==void 0){this.gl.deleteVertexArray(e.vao);for(const i of e.buffers)this.gl.deleteBuffer(i);this.tracts.delete(t)}}tractIds(){return[...this.tracts.keys()]}frame(t,e){const{gl:i}=this;if(this.target&&this.target.w===t&&this.target.h===e)return this.target;this.target&&(i.deleteFramebuffer(this.target.fb),i.deleteTexture(this.target.colour),i.deleteRenderbuffer(this.target.depth));const o=i.createFramebuffer(),s=i.createTexture();i.bindTexture(i.TEXTURE_2D,s),i.texImage2D(i.TEXTURE_2D,0,i.RGBA8,t,e,0,i.RGBA,i.UNSIGNED_BYTE,null),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.LINEAR),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.LINEAR);const n=i.createRenderbuffer();return i.bindRenderbuffer(i.RENDERBUFFER,n),i.renderbufferStorage(i.RENDERBUFFER,i.DEPTH_COMPONENT24,t,e),i.bindFramebuffer(i.FRAMEBUFFER,o),i.framebufferTexture2D(i.FRAMEBUFFER,i.COLOR_ATTACHMENT0,i.TEXTURE_2D,s,0),i.framebufferRenderbuffer(i.FRAMEBUFFER,i.DEPTH_ATTACHMENT,i.RENDERBUFFER,n),this.target={fb:o,colour:s,depth:n,w:t,h:e},this.target}render(t,e,i=1){const{gl:o,canvas:s}=this,n=Math.max(1,Math.round(s.width*i)),r=Math.max(1,Math.round(s.height*i)),a=this.frame(n,r);o.bindFramebuffer(o.FRAMEBUFFER,a.fb),o.viewport(0,0,n,r),o.clearColor(0,0,0,1),o.clearDepth(1),o.clear(o.COLOR_BUFFER_BIT|o.DEPTH_BUFFER_BIT);const c=q(t,n/r),f=A(c);if(o.enable(o.DEPTH_TEST),o.depthFunc(o.LEQUAL),this.volume&&this.occupancy&&this.worldToTex&&this.box){const l=this.brain;o.useProgram(l),o.activeTexture(o.TEXTURE0),o.bindTexture(o.TEXTURE_3D,this.volume),o.uniform1i(this.u(l,"uVolume"),0),o.activeTexture(o.TEXTURE1),o.bindTexture(o.TEXTURE_3D,this.occupancy),o.uniform1i(this.u(l,"uOccupancy"),1);const m=[!1,!1,!1],u=new Float32Array(12);for(let v=0;v<3;++v){const d=this.planes[v];o.activeTexture(o.TEXTURE2+v),o.bindTexture(o.TEXTURE_2D,d?.texture??null),o.uniform1i(this.u(l,`uPlane${v}`),2+v);const g=d!==void 0&&e.cut!==void 0&&Math.abs(d.value-e.cut[v])<1e-6;m[v]=e.sections&&g,d&&u.set(d.rect,4*v)}o.uniform3i(this.u(l,"uPlaneReady"),+m[0],+m[1],+m[2]),o.uniform4fv(this.u(l,"uPlaneRect"),u),o.uniformMatrix4fv(this.u(l,"uInvViewProj"),!1,A(P(c))),o.uniformMatrix4fv(this.u(l,"uViewProj"),!1,f),o.uniformMatrix4fv(this.u(l,"uWorldToTex"),!1,A(this.worldToTex)),o.uniform3fv(this.u(l,"uOccScale"),this.occScale),o.uniform3fv(this.u(l,"uBoxLo"),this.box.lo),o.uniform3fv(this.u(l,"uBoxHi"),this.box.hi),o.uniform1f(this.u(l,"uVoxel"),this.voxel),o.uniform1f(this.u(l,"uStep"),this.voxel*.6),o.uniform1f(this.u(l,"uBlockStep"),this.voxel*R*.9),o.uniform1f(this.u(l,"uThreshold"),e.threshold),o.uniform1i(this.u(l,"uDarkBackground"),this.darkBackground?1:0),o.uniform2fv(this.u(l,"uWindow"),this.window);const p=e.cut;if(o.uniform1i(this.u(l,"uCut"),p===void 0?0:1),p!==void 0){o.uniform3fv(this.u(l,"uCutPoint"),p);const v=[t.target[0]+t.distance*Math.cos(t.pitch)*Math.cos(t.yaw),t.target[1]+t.distance*Math.cos(t.pitch)*Math.sin(t.yaw),t.target[2]+t.distance*Math.sin(t.pitch)];o.uniform3fv(this.u(l,"uCutSide"),v.map((d,g)=>d>=p[g]?1:-1))}o.bindVertexArray(this.empty),o.drawArrays(o.TRIANGLES,0,3)}if(e.tracts&&this.tracts.size>0){const l=this.lines;o.useProgram(l),o.uniformMatrix4fv(this.u(l,"uViewProj"),!1,f);for(const m of this.tracts.values())o.uniform3fv(this.u(l,"uColour"),m.colour),o.bindVertexArray(m.vao),o.drawElements(o.LINE_STRIP,m.count,o.UNSIGNED_INT,0)}o.bindVertexArray(null),o.bindFramebuffer(o.READ_FRAMEBUFFER,a.fb),o.bindFramebuffer(o.DRAW_FRAMEBUFFER,null),o.blitFramebuffer(0,0,n,r,0,0,s.width,s.height,o.COLOR_BUFFER_BIT,n===s.width?o.NEAREST:o.LINEAR),o.bindFramebuffer(o.FRAMEBUFFER,null)}dispose(){const{gl:t}=this;for(const e of this.tractIds())this.removeTracts(e);this.clearPlanes(),this.volume&&t.deleteTexture(this.volume),this.occupancy&&t.deleteTexture(this.occupancy),this.target&&(t.deleteFramebuffer(this.target.fb),t.deleteTexture(this.target.colour),t.deleteRenderbuffer(this.target.depth)),t.deleteProgram(this.brain),t.deleteProgram(this.lines),t.getExtension("WEBGL_lose_context")?.loseContext()}}class j{worker=new Worker(new URL(""+new URL("volume_worker-DQAsFd6S.js",import.meta.url).href,import.meta.url),{type:"module",name:"volume view"});nextId=1;pending=new Map;constructor(){this.worker.onmessage=t=>{const e=t.data,i=this.pending.get(e.id);i!==void 0&&(e.type==="progress"?i.progress?.(e.done,e.total):e.type==="plane"&&!e.final?i.partial?.(e):(this.pending.delete(e.id),e.type==="error"?i.reject(new Error(e.message)):i.resolve(e)))}}request(t,e={}){const i=this.nextId++;return new Promise((o,s)=>{this.pending.set(i,{resolve:o,reject:s,progress:e.progress,partial:e.partial}),e.signal?.addEventListener("abort",()=>{this.pending.delete(i)&&(this.worker.postMessage({type:"cancel",id:i}),s(new DOMException("Aborted","AbortError")))}),this.worker.postMessage({...t,id:i})})}open(t,e){return this.request({type:"open",stores:t,space:e})}volume(t,e,i){return this.request({type:"volume",level:t},{progress:e,signal:i})}plane(t,e={}){return this.request({type:"plane",...t},e)}dispose(){this.worker.terminate();for(const t of this.pending.values())t.reject(new Error("closed"));this.pending.clear()}}const M="https://ftp.bigbrainproject.org/bigbrain-ftp/BigBrainRelease.2015/OME_Zarr/",G="https://andrew-keenlyside.github.io/ngplatform/data/MNI152NLin2009aAsym_T1w_brain.ome.zarr/",w=[{id:"bigbrain-mni",title:"BigBrain, in MNI ICBM152 2009b (linear)",stores:[`${M}1000um/`,`${M}400um/`,`${M}200um/`,`${M}100um/`],space:"MNI152NLin2009bAsym",credit:"BigBrain (Amunts et al., Science 2013), CC BY-NC-SA 4.0, bigbrainproject.org. OME-Zarr conversion and linear MNI placement by A. Keenlyside (2026). Structure after Open the Mind (C. Sam, BigBrain Hackathon 2026)."},{id:"mni152-2009a",title:"MNI ICBM152 2009a template (T1w, brain), 1 mm",stores:[G],threshold:.35,credit:"ICBM 152 Nonlinear Asymmetric 2009a (Fonov et al., NeuroImage 2011). Copyright (C) 1993-2004 Louis Collins, McConnell Brain Imaging Centre, Montreal Neurological Institute, McGill University. From TemplateFlow; masked to the brain and converted to OME-Zarr for this view."}];function k(h){const t=h??{},e=w.find(i=>i.id===t.preset);return{on:t.on===!0,preset:t.preset,stores:Array.isArray(t.stores)&&t.stores.length>0?t.stores.map(String):e?.stores??[],space:t.space??e?.space,solid:typeof t.solid=="number"?t.solid:.4,finest:typeof t.finest=="number"?t.finest:.2,threshold:typeof t.threshold=="number"?t.threshold:e?.threshold??.08,cut:t.cut!==!1,sections:t.sections!==!1,tracts:t.tracts!==!1,layout:t.layout}}function L(h){return typeof h=="string"?{"xy-3d":"xy","xz-3d":"xz","yz-3d":"yz","3d":"xy","4panel":"xy","4panel-alt":"xy"}[h]??h:h===void 0?"xy":h}function C(h){const t=h.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);return t?[parseInt(t[1],16)/255,parseInt(t[2],16)/255,parseInt(t[3],16)/255]:[1,1,1]}function x(h,t={},...e){const i=document.createElement(h);for(const[o,s]of Object.entries(t))s===void 0||s===!1||(o.startsWith("on")&&typeof s=="function"?i.addEventListener(o.slice(2),s):o==="class"?i.className=String(s):i.setAttribute(o,s===!0?"":String(s)));for(const o of e)o!=null&&o!==!1&&i.append(o);return i}const H=`
.vv-host { position: absolute; inset: 0; background: #000; overflow: hidden; }
.vv-host canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
.vv-host canvas:active { cursor: grabbing; }
.vv-head { position: absolute; top: 6px; left: 8px; right: 6px; display: flex; align-items: flex-start; gap: 8px; pointer-events: none; }
.vv-bar { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; flex-shrink: 0; max-width: 100%; pointer-events: auto; }
.vv-bar button { height: 24px; padding: 0 8px; border-radius: 0; border: 1px solid #3d3d3d; background: rgba(12,12,12,0.85); color: #ddd; font: 12px/1 var(--ui, sans-serif); cursor: pointer; }
.vv-bar button[aria-pressed="true"] { border-color: #8a8a8a; color: #fff; background: rgba(60,60,60,0.85); }
.vv-status { position: absolute; left: 8px; bottom: 6px; right: 8px; font: 11px/1.4 var(--mono, monospace); color: #9a9a9a; pointer-events: none; text-shadow: 0 0 3px #000; }
.vv-title { flex: 1; min-width: 0; padding-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 12px/1 var(--ui, sans-serif); color: #d0d0d0; text-shadow: 0 0 3px #000; }
.vv-panel { display: grid; gap: 10px; }
.vv-panel .row { display: flex; align-items: center; gap: 8px; }
.vv-panel select, .vv-panel textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--line); border-radius: 0; background: var(--ink-0); color: var(--text); font: 12px/1.3 var(--ui); padding: 4px; }
.vv-panel textarea { font: 11px/1.4 var(--mono); min-height: 64px; resize: vertical; }
.vv-panel label.check { display: flex; gap: 8px; align-items: center; font-size: 12px; }
.vv-credit { font-size: 11px; color: var(--faint); margin: 0; }
`;class K{constructor(t){this.ctx=t,this.saved=k(t.state.get()),this.offs.push(t.state.onChanged(()=>{this.writing||(this.saved=k(t.state.get()),this.apply())}),t.viewer.onStateChanged(()=>this.followPosition())),t.services.get("trackFiltering.groups").then(e=>{this.tracts=e,this.offs.push(e.onChanged(()=>this.updateTracts())),this.updateTracts()}),this.apply()}saved;writing=!1;client;renderer;levels=[];solid;camera;cut;unmount;host;canvas;statusLine;titleLine;status="";opened="";openToken=0;dirty=!1;interacting=0;sharpTimer;planeTimer;planeController;tracts;tractKeys=new Map;tractController;panelHost;toggles=[];planesKey="";offs=[];dispose(){this.offs.forEach(t=>t()),this.hide()}save(t){this.saved={...this.saved,...t},this.writing=!0;try{this.ctx.state.set(this.saved)}finally{this.writing=!1}this.apply()}toggle(){if(this.saved.on)this.save({on:!1});else{const t=this.saved.stores.length>0?{}:{preset:w[0].id,stores:w[0].stores,space:w[0].space};this.save({on:!0,...t})}}resetCamera(){this.camera=void 0,this.ensureCamera(),this.request()}apply(){this.saved.on?this.show():this.hide();const t=JSON.stringify([this.saved.stores,this.saved.space]);this.saved.on&&t!==this.opened&&this.saved.stores.length>0?(this.opened=t,this.openVolume()):this.saved.on&&this.solid!==void 0&&this.solid!==this.chooseSolid()&&this.loadSolid();const e=JSON.stringify([this.saved.cut,this.saved.sections,this.saved.finest,this.saved.solid,this.saved.stores]);e!==this.planesKey&&(this.planesKey=e,this.requestPlanes()),this.updateTracts(),this.renderPanel();for(const i of this.toggles)i();this.request()}show(){if(this.unmount!==void 0)return;const t=this.ctx.viewer.getState().layout,e=L(t);if(JSON.stringify(e)!==JSON.stringify(t)){this.saved={...this.saved,layout:t},this.writing=!0;try{this.ctx.state.set(this.saved)}finally{this.writing=!1}this.ctx.viewer.patchState(i=>{i.layout=e})}this.unmount=this.ctx.ui.view(i=>this.mount(i))}hide(){if(this.unmount===void 0)return;const t=this.unmount;if(this.unmount=void 0,t(),this.saved.layout!==void 0){const e=this.saved.layout,i=this.ctx.viewer.getState().layout;JSON.stringify(i)===JSON.stringify(L(e))&&this.ctx.viewer.patchState(o=>{o.layout=e})}}mount(t){const e=x("div",{class:"vv-host"}),i=x("canvas",{"aria-label":"Volume view"});this.titleLine=x("div",{class:"vv-title"}),this.statusLine=x("div",{class:"vv-status"});const o=(a,c,f)=>{const l=x("button",{type:"button",title:f,"aria-pressed":String(this.saved[c]),onclick:()=>this.save({[c]:!this.saved[c]})},a);return this.toggles.push(()=>l.setAttribute("aria-pressed",String(this.saved[c]))),l},s=x("div",{class:"vv-bar"},o("Cut","cut","Cut away the octant facing you at the current position"),o("Sections","sections","Show full-resolution sections on the cut faces"),o("Tracts","tracts","Show the visible track groups"),x("button",{type:"button",title:"Reset the camera",onclick:()=>this.resetCamera()},"Reset"),x("button",{type:"button",title:"Back to Neuroglancer's 3-D panel",onclick:()=>this.save({on:!1})},"×"));e.append(i,x("div",{class:"vv-head"},this.titleLine,s),this.statusLine),t.append(e),this.host=e,this.canvas=i;try{this.renderer=new W(i)}catch(a){this.setStatus(`Cannot draw: ${a.message}`)}if(this.tractKeys.clear(),this.solidData!==void 0&&this.renderer!==void 0){const{data:a,size:c,level:f}=this.solidData;this.renderer.setVolume(a,c,f.voxelToRas,f.voxelSize)}const n=new ResizeObserver(()=>this.resize());n.observe(e);const r=this.bindInput(i);return this.resize(),this.updateTracts(),this.requestPlanes(!0),()=>{n.disconnect(),r(),this.planeController?.abort(),this.tractController?.abort(),this.renderer?.dispose(),this.renderer=void 0,this.toggles=[],this.canvas=void 0,this.host=void 0,e.remove()}}resize(){const t=this.canvas;if(t===void 0)return;const e=Math.min(window.devicePixelRatio||1,1.5);t.width=Math.max(1,Math.round(t.clientWidth*e)),t.height=Math.max(1,Math.round(t.clientHeight*e)),this.request()}bindInput(t){let e;const i=a=>{t.setPointerCapture(a.pointerId),e={x:a.clientX,y:a.clientY,pan:a.shiftKey||a.button!==0},this.interacting++},o=a=>{if(e===void 0||this.camera===void 0)return;const c=a.clientX-e.x,f=a.clientY-e.y;e.x=a.clientX,e.y=a.clientY;const l=this.camera;if(e.pan){const m=[-Math.sin(l.yaw),Math.cos(l.yaw),0],u=[-Math.sin(l.pitch)*Math.cos(l.yaw),-Math.sin(l.pitch)*Math.sin(l.yaw),Math.cos(l.pitch)],p=l.distance*.0012*600/Math.max(200,t.clientHeight);l.target=l.target.map((v,d)=>v-m[d]*c*p+u[d]*f*p)}else l.yaw-=c*.008,l.pitch=Math.max(-1.55,Math.min(1.55,l.pitch+f*.008));this.request()},s=a=>{e!==void 0&&(e=void 0,t.releasePointerCapture(a.pointerId),this.interacting=Math.max(0,this.interacting-1),this.request())},n=a=>{this.camera!==void 0&&(a.preventDefault(),this.camera.distance=Math.max(10,Math.min(2e3,this.camera.distance*Math.exp(a.deltaY*.0012))),this.interacting++,this.request(),setTimeout(()=>{this.interacting=Math.max(0,this.interacting-1),this.request()},120))},r=a=>a.preventDefault();return t.addEventListener("pointerdown",i),t.addEventListener("pointermove",o),t.addEventListener("pointerup",s),t.addEventListener("pointercancel",s),t.addEventListener("wheel",n,{passive:!1}),t.addEventListener("contextmenu",r),()=>{t.removeEventListener("pointerdown",i),t.removeEventListener("pointermove",o),t.removeEventListener("pointerup",s),t.removeEventListener("pointercancel",s),t.removeEventListener("wheel",n),t.removeEventListener("contextmenu",r)}}request(){this.dirty||(this.dirty=!0,requestAnimationFrame(()=>{this.dirty=!1,this.draw(this.interacting>0?.5:1),this.interacting>0&&(this.sharpTimer!==void 0&&clearTimeout(this.sharpTimer),this.sharpTimer=setTimeout(()=>this.request(),160))}))}draw(t){const e=this.renderer;if(e===void 0||this.canvas===void 0)return;this.ensureCamera();const i=this.camera;if(i===void 0){e.render({target:[0,0,0],distance:400,yaw:.8,pitch:.4},this.options(),t);return}performance.now(),e.render(i,this.options(),t),this.titleLine&&(this.titleLine.textContent=this.title,this.titleLine.title=this.title),this.statusLine&&(this.statusLine.textContent=this.status)}options(){return{cut:this.saved.cut?this.cut:void 0,sections:this.saved.sections,tracts:this.saved.tracts,threshold:this.saved.threshold}}ensureCamera(){if(this.camera!==void 0)return;const t=this.renderer?.bounds();if(t===void 0)return;const e=t.lo.map((o,s)=>(o+t.hi[s])/2),i=Math.max(...t.hi.map((o,s)=>o-t.lo[s]));this.camera={target:e,distance:i*2,yaw:.75,pitch:.42}}title="";setStatus(t){this.status=t,this.statusLine&&(this.statusLine.textContent=t),this.renderPanelStatus()}solidData;async openVolume(){const t=++this.openToken;this.client?.dispose(),this.client=new j,this.levels=[],this.solid=void 0,this.solidData=void 0,this.renderer?.clearPlanes(),this.setStatus("Opening the volume…");try{const e=await this.client.open(this.saved.stores,this.saved.space);if(t!==this.openToken)return;if(this.levels=e.levels,this.title=e.name,this.levels.length===0)throw new Error("the stores hold no image levels");this.setStatus(`${this.levels.length} levels, ${this.levels.map(i=>`${Math.round(i.voxelSize*1e3)} µm`).join(", ")}`),this.renderPanel(),await this.loadSolid()}catch(e){t===this.openToken&&this.setStatus(`Could not open the volume: ${e.message}`)}}chooseSolid(){const t=this.saved.solid*.95;return this.levels.find(e=>e.voxelSize>=t)??this.levels[this.levels.length-1]}async loadSolid(){const t=this.chooseSolid(),e=this.client;if(t===void 0||e===void 0)return;this.solid=t;const i=this.levels.indexOf(t),o=performance.now(),s=`${Math.round(t.voxelSize*1e3)} µm`;this.setStatus(`Loading the solid (${s})…`);const{data:n,size:r}=await e.volume(i,(a,c)=>this.setStatus(`Loading the solid (${s}): ${a} of ${c} chunks`));this.solid!==t||this.client!==e||(this.solidData={data:n,size:r,level:t},this.renderer?.setVolume(n,r,t.voxelToRas,t.voxelSize),this.setStatus(`Solid ${s} in ${((performance.now()-o)/1e3).toFixed(1)} s`),this.followPosition(!0),this.requestPlanes(!0),this.request())}position(){const t=this.ctx.viewer.getState(),e=t.position;if(!Array.isArray(e)||e.length<3)return;const i=t.dimensions??{},o=Object.keys(i),s=[0,0,0];for(const[n,r]of["x","y","z"].entries()){const a=o.indexOf(r),c=a>=0?a:n,[f,l]=i[r]??[.001,"m"];s[n]=(e[c]??0)*(l==="m"?f*1e3:1)}return s}followPosition(t=!1){const e=this.position();e!==void 0&&(!t&&this.cut!==void 0&&e.every((i,o)=>Math.abs(i-this.cut[o])<.001)||(this.cut=e,this.requestPlanes(),this.request()))}requestPlanes(t=!1){this.planeTimer!==void 0&&clearTimeout(this.planeTimer),this.planeTimer=setTimeout(()=>void this.loadPlanes(),t?0:220)}async loadPlanes(){this.planeTimer=void 0;const t=this.renderer,e=this.client,i=this.cut,o=this.solid;if(this.planeController?.abort(),t===void 0||e===void 0||i===void 0||o===void 0||!this.saved.cut||!this.saved.sections)return;const s=new AbortController;this.planeController=s;const n=U(o,o.shape),r=this.levels.filter(c=>c.voxelSize<=o.voxelSize*1.05&&c.voxelSize>=this.saved.finest*.95).reverse(),a=performance.now();try{for(const[c,f]of r.entries()){const l=this.levels.indexOf(f),m=`${Math.round(f.voxelSize*1e3)} µm`,u=[0,0,0],p=[0,0,0],v=()=>this.setStatus(`Sections at ${m}: ${u.reduce((d,g)=>d+g,0)} of ${p.reduce((d,g)=>d+g,0)} chunks`);await Promise.all([0,1,2].map(async d=>{const[g,T]=[0,1,2].filter(b=>b!==d),y=[n.lo[g],n.hi[g],n.lo[T],n.hi[T]],E=await e.plane({level:l,axis:d,value:i[d],rect:y,texel:f.voxelSize},{signal:s.signal,progress:(b,S)=>{u[d]=b,p[d]=S,v()},partial:c===0?b=>(t.setPlane(d,b.data,b.width,b.height,y,i[d]),this.request()):void 0});s.signal.aborted||this.renderer!==t||(t.setPlane(d,E.data,E.width,E.height,y,i[d]),this.request())}))}this.setStatus(`Sections at ${Math.round((r[r.length-1]?.voxelSize??0)*1e3)} µm in ${((performance.now()-a)/1e3).toFixed(1)} s`)}catch(c){s.signal.aborted||this.setStatus(`Sections: ${c.message}`)}}updateTracts(){const t=this.renderer,e=this.tracts;if(t===void 0||e===void 0)return;const i=e.list().filter(s=>s.visible&&s.exact&&s.count>0),o=new Set(i.map(s=>s.id));for(const s of t.tractIds())o.has(s)||(t.removeTracts(s),this.tractKeys.delete(s));for(const s of i){const n=`${s.version}`;t.setTractColour(s.id,C(s.colour)),this.tractKeys.get(s.id)!==n&&(this.tractKeys.set(s.id,n),e.curves(s.id,15e5).then(r=>{this.renderer!==t||this.tractKeys.get(s.id)!==n||(t.setTracts(s.id,r.positions,r.offsets,C(s.colour)),this.request())},r=>{this.tractKeys.get(s.id)===n&&this.tractKeys.delete(s.id),r.name!=="AbortError"&&this.ctx.log.error(`${s.name}: tracts not drawn: ${r.message}`)}))}this.request()}panelStatus;render(t){return this.panelHost=t,this.renderPanel(),()=>{this.panelHost=void 0,this.panelStatus=void 0}}levelSelects(t){const e=this.saved,i=r=>`${r<1?r.toFixed(2):r.toFixed(1)} mm`;if(this.levels.length===0)return[t("Solid",e.solid,[[1,"about 1 mm (lightest)"],[.4,"about 0.4 mm"]],r=>this.save({solid:r})),t("Sections down to",e.finest,[[.4,"about 0.4 mm"],[.2,"about 0.2 mm"],[.1,"about 0.1 mm"]],r=>this.save({finest:r}))];const o=this.chooseSolid(),s=this.levels.filter(r=>r.size[0]*r.size[1]*r.size[2]<=64e6),n=this.levels.find(r=>r.voxelSize>=e.finest*.95)??this.levels[this.levels.length-1];return[t("Solid",o?.voxelSize??e.solid,s.map(r=>[r.voxelSize,`${i(r.voxelSize)}${r===s[s.length-1]?" (lightest)":""}`]),r=>this.save({solid:r})),t("Sections down to",n.voxelSize,this.levels.filter(r=>o===void 0||r.voxelSize<=o.voxelSize*1.05).map((r,a)=>[r.voxelSize,`${i(r.voxelSize)}${a===0?" (finest; the most to download)":""}`]),r=>this.save({finest:r}))]}renderPanelStatus(){this.panelStatus&&(this.panelStatus.textContent=this.status)}renderPanel(){const t=this.panelHost;if(t===void 0)return;const e=this.saved,i=x("input",{type:"checkbox",class:"switch",role:"switch","aria-label":"Volume view on"});i.checked=e.on,i.addEventListener("change",()=>this.toggle());const o=x("select",{"aria-label":"Volume"});for(const m of w)o.append(x("option",{value:m.id},m.title));o.append(x("option",{value:""},"Other OME-Zarr stores…")),o.value=e.preset??(e.stores.length>0?"":w[0].id);const s=x("textarea",{"aria-label":"OME-Zarr stores, one per line",spellcheck:"false",hidden:o.value!==""});s.value=e.stores.join(`
`);const n=x("input",{class:"text-input","aria-label":"Coordinate system",placeholder:"coordinate system (e.g. MNI152NLin2009bAsym)",value:e.space??"",hidden:o.value!==""});o.addEventListener("change",()=>{const m=w.find(u=>u.id===o.value);m?this.save({preset:m.id,stores:m.stores,space:m.space,threshold:m.threshold??.08}):(s.hidden=!1,n.hidden=!1)});const r=()=>this.save({preset:void 0,stores:s.value.split(/\s+/).filter(Boolean),space:n.value.trim()||void 0});s.addEventListener("change",r),n.addEventListener("change",r);const a=(m,u,p,v)=>{const d=x("select",{"aria-label":m});for(const[g,T]of p)d.append(x("option",{value:String(g)},T));return d.value=String(u),d.addEventListener("change",()=>v(Number(d.value))),x("label",{class:"field"},x("span",{},m),d)},c=x("input",{type:"range",min:"0.02",max:"0.6",step:"0.01",value:String(e.threshold),"aria-label":"Tissue threshold"});c.addEventListener("input",()=>{this.saved={...this.saved,threshold:Number(c.value)},this.request()}),c.addEventListener("change",()=>this.save({threshold:Number(c.value)}));const f=(m,u)=>{const p=x("input",{type:"checkbox"});return p.checked=e[u],p.addEventListener("change",()=>this.save({[u]:p.checked})),x("label",{class:"check"},p,m)};this.panelStatus=x("p",{class:"note"},this.status);const l=w.find(m=>m.id===e.preset)?.credit;t.replaceChildren(x("div",{class:"vv-panel"},x("div",{class:"row"},x("h3",{class:"section-title",style:"margin:0;flex:1"},"Volume view"),x("label",{class:"switch-label",title:"In place of Neuroglancer's 3-D panel"},i)),x("p",{class:"note first"},"A solid brain in place of the 3-D panel, cut open at the current position (move it in the 2-D views), with sections on the cut and the visible track groups. Drag to turn, shift-drag to move, scroll to zoom."),x("label",{class:"field"},x("span",{},"Volume"),o),s,n,...this.levelSelects(a),x("label",{class:"field"},x("span",{},"Surface"),c),f("Cut away the octant facing the camera","cut"),f("Sections on the cut faces","sections"),f("Track groups","tracts"),this.panelStatus,l?x("p",{class:"vv-credit"},l):null))}}const J={activate(h){const t=x("style",{},H);document.head.append(t),h.subscriptions.push(()=>t.remove());const e=new K(h);h.subscriptions.push(()=>e.dispose()),h.ui.panel(F,i=>e.render(i)),h.commands.register("volumeView.toggle",()=>e.toggle()),h.commands.register("volumeView.resetCamera",()=>e.resetCamera())}};export{w as PRESETS,J as plugin,k as readSaved,L as twoDimensional};
