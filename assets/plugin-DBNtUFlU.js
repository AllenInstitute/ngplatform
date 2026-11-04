import{_ as Ke}from"./preload-helper-Ct5FWWRu.js";import{o as ye}from"./sources-B730UoAO.js";import{a as et}from"./manifest-CiEzbXwb.js";class tt{worker=new Worker(new URL(""+new URL("worker-BIdSpcdY.js",import.meta.url).href,import.meta.url),{type:"module",name:"orientations"});nextId=1;pending=new Map;constructor(){this.worker.onmessage=t=>{const o=t.data,e=this.pending.get(o.id);e!==void 0&&(this.pending.delete(o.id),o.type==="error"?e.reject(new Error(o.message)):e.resolve(o))},this.worker.onerror=t=>{this.broken=`the orientation reader stopped: ${t.message||"it could not start"}. Reload the page to try again`;for(const o of this.pending.values())o.reject(new Error(this.broken));this.pending.clear()}}broken;request(t,o){const e=this.nextId++;return this.broken!==void 0?Promise.reject(new Error(this.broken)):new Promise((n,s)=>{this.pending.set(e,{resolve:n,reject:s}),o?.addEventListener("abort",()=>{this.pending.delete(e)&&(this.worker.postMessage({type:"cancel",id:e}),s(new DOMException("Aborted","AbortError")))}),this.worker.postMessage({...t,id:e})})}open(t){return this.request({type:"open",url:t})}glyphs(t,o,e,n){return this.request({type:"glyphs",level:t,request:o,options:e},n)}values(t,o,e){return this.request({type:"values",level:t,request:o},e)}dispose(){this.worker.terminate();for(const t of this.pending.values())t.reject(new Error("closed"));this.pending.clear()}}const xe=[["descoteaux07-legacy","descoteaux07 (DIPY's default, legacy)"],["descoteaux07","descoteaux07 (DIPY, legacy=False)"],["tournier07","tournier07 (MRtrix3)"],["tournier07-legacy","tournier07 legacy (MRtrix 0.2)"]];function Oe(i){return(i+1)*(i+2)/2}function U(i){for(let t=0;t<=20;t+=2)if(Oe(t)===i)return t}function Pe(i){const t=[];for(let o=0;o<=i;o+=2)for(let e=-o;e<=o;++e)t.push({l:o,m:e||0});return t}function ot(i,t){const o=i+1,e=new Float64Array(o*o),n=Math.sqrt(Math.max(0,1-t*t));let s=1;for(let r=0;r<=i;++r){r>0&&(s*=-(2*r-1)*n),e[r*o+r]=s,r+1<=i&&(e[(r+1)*o+r]=t*(2*r+1)*s);for(let a=r+2;a<=i;++a)e[a*o+r]=((2*a-1)*t*e[(a-1)*o+r]-(a+r-1)*e[(a-2)*o+r])/(a-r)}return e}function nt(i,t){let o=1;for(let e=i-t+1;e<=i+t;++e)o/=e;return Math.sqrt((2*i+1)/(4*Math.PI)*o)}function Ie(i,t,o){const e=Oe(t),n=Math.floor(o.length/3),s=new Float32Array(n*e),r=t+1,a=new Float64Array(r*r);for(let h=0;h<=t;++h)for(let l=0;l<=h;++l)a[h*r+l]=nt(h,l);const c=Pe(t);for(let h=0;h<n;++h){const l=o[3*h],d=o[3*h+1],u=o[3*h+2],y=Math.hypot(l,d,u)||1,v=Math.max(-1,Math.min(1,u/y)),f=Math.atan2(d,l),p=ot(t,v);for(let m=0;m<e;++m){const{l:x,m:g}=c[m],w=Math.abs(g),$=a[x*r+w]*p[x*r+w];let M;if(g===0)M=$;else if(i==="descoteaux07-legacy")M=Math.SQRT2*$*(g<0?Math.cos(w*f):Math.sin(w*f));else if(i==="descoteaux07")M=Math.SQRT2*$*(g<0?(w%2===1?-1:1)*Math.cos(w*f):Math.sin(w*f));else{const z=g<0?Math.sin(w*f):Math.cos(w*f);M=i==="tournier07"?Math.SQRT2*$*z:$*z}s[h*e+m]=M}}return s}function st(i,t,o,e,n){const s=n.length;for(let r=0;r<s;++r){let a=0;const c=r*t;for(let h=0;h<t;++h)a+=i[c+h]*o[e+h];n[r]=a}return n}function it(i,t,o,e){const n=i[t];let s=n*n;const r=e==="tournier07-legacy"?2:1,a=Pe(U(o)??0);for(let c=1;c<o;++c){const h=i[t+c];s+=(a[c].m===0?1:r)*h*h}return s>0?Math.sqrt(Math.max(0,1-n*n/s)):0}function rt(i){const o=Ie(i,2,[[1,0,0],[0,1,0],[0,0,1],[Math.SQRT1_2,Math.SQRT1_2,0],[Math.SQRT1_2,0,Math.SQRT1_2],[0,Math.SQRT1_2,Math.SQRT1_2]].flat()),e=[];for(let n=1;n<=5;++n){const s=u=>o[u*6+n],r=s(0),a=s(1),c=s(2),h=s(3)-(r+a)/2,l=s(4)-(r+c)/2,d=s(5)-(a+c)/2;e.push(Float64Array.from([r,h,l,h,a,d,l,d,c]))}return e}const Re=new Map;function Le(i){const t=Re.get(i);if(t!==void 0)return t;const o=(1+Math.sqrt(5))/2,e=[[-1,o,0],[1,o,0],[-1,-o,0],[1,-o,0],[0,-1,o],[0,1,o],[0,-1,-o],[0,1,-o],[o,0,-1],[o,0,1],[-o,0,-1],[-o,0,1]].map(l=>{const d=Math.hypot(l[0],l[1],l[2]);return l.map(u=>u/d)});let n=[[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];for(let l=0;l<i;++l){const d=new Map,u=(v,f)=>{const p=v<f?`${v},${f}`:`${f},${v}`;let m=d.get(p);if(m===void 0){const x=[0,1,2].map(w=>e[v][w]+e[f][w]),g=Math.hypot(x[0],x[1],x[2]);m=e.push(x.map(w=>w/g))-1,d.set(p,m)}return m},y=[];for(const[v,f,p]of n){const m=u(v,f),x=u(f,p),g=u(p,v);y.push([v,m,g],[f,x,m],[p,g,x],[m,x,g])}n=y}for(const l of n){const[d,u,y]=l.map(m=>e[m]),v=[0,1,2].map(m=>u[m]-d[m]),f=[0,1,2].map(m=>y[m]-d[m]),p=[v[1]*f[2]-v[2]*f[1],v[2]*f[0]-v[0]*f[2],v[0]*f[1]-v[1]*f[0]];p[0]*d[0]+p[1]*d[1]+p[2]*d[2]<0&&([l[1],l[2]]=[l[2],l[1]])}const s=e.length,r=Array.from({length:s},()=>new Map);for(const[l,d,u]of n)r[l].set(d,u),r[d].set(u,l),r[u].set(l,d);const a=new Uint32Array(4*s),c=[];for(let l=0;l<s;++l){const d=[];let u=r[l].keys().next().value;for(;d.length<r[l].size;)d.push(u),u=r[l].get(u);c.push(d);const y=d.length;a[4*l]=d[0],a[4*l+1]=d[Math.round(y/4)],a[4*l+2]=d[Math.round(y/2)],a[4*l+3]=d[Math.round(3*y/4)%y]}const h={vertices:Float32Array.from(e.flat()),faces:Uint32Array.from(n.flat()),around:a,rings:c,count:s};return Re.set(i,h),h}const we=[["fsl","Dxx Dxy Dxz Dyy Dyz Dzz (FSL)"],["dipy","Dxx Dxy Dyy Dxz Dyz Dzz (DIPY)"],["mrtrix","Dxx Dyy Dzz Dxy Dxz Dyz (MRtrix)"]],Ne={fsl:[0,1,2,3,4,5],dipy:[0,1,3,2,4,5],mrtrix:[0,3,4,1,5,2]};function at(i,t,o,e=new Float64Array(9)){const[n,s,r,a,c,h]=Ne[o].map(l=>i[t+l]);return e[0]=n,e[1]=s,e[2]=r,e[3]=s,e[4]=a,e[5]=c,e[6]=r,e[7]=c,e[8]=h,e}function ct(i){const t=new Float64Array(3),o=new Float64Array(9);return lt([i[0],i[1],i[2],i[4],i[5],i[8]],t,o),{values:[t[0],t[1],t[2]],vectors:o}}function lt(i,t,o){const e=Math.max(Math.abs(i[0]),Math.abs(i[1]),Math.abs(i[2]),Math.abs(i[3]),Math.abs(i[4]),Math.abs(i[5]));if(!(e>0)||!Number.isFinite(e)){t[0]=t[1]=t[2]=e===0?0:NaN,o.fill(0),o[0]=o[4]=o[8]=1;return}const n=i[0]/e,s=i[1]/e,r=i[2]/e,a=i[3]/e,c=i[4]/e,h=i[5]/e,l=(n+a+h)/3,d=n-l,u=a-l,y=h-l,v=s*s+r*r+c*c,f=Math.sqrt((d*d+u*u+y*y+2*v)/6);if(f<1e-12){t[0]=t[1]=t[2]=l*e,o.fill(0),o[0]=o[4]=o[8]=1;return}const p=d*(u*y-c*c)-s*(s*y-c*r)+r*(s*c-u*r),m=Math.max(-1,Math.min(1,p/(2*f*f*f))),x=Math.acos(m)/3,g=l+2*f*Math.cos(x),w=l+2*f*Math.cos(x+2*Math.PI/3),$=3*l-g-w,M=g-$>=$-w,z=M?g:w,j=n-z,V=s,G=r,q=s,W=a-z,X=c,Y=r,H=c,Q=h-z,re=V*X-G*W,ae=G*q-j*X,ce=j*W-V*q,le=V*Q-G*H,he=G*Y-j*Q,de=j*H-V*Y,fe=W*Q-X*H,ue=X*Y-q*Q,pe=q*H-W*Y,J=re*re+ae*ae+ce*ce,Z=le*le+he*he+de*de,K=fe*fe+ue*ue+pe*pe;let k=1,T=0,S=0;if(J>=Z&&J>=K&&J>0){const A=1/Math.sqrt(J);k=re*A,T=ae*A,S=ce*A}else if(Z>=K&&Z>0){const A=1/Math.sqrt(Z);k=le*A,T=he*A,S=de*A}else if(K>0){const A=1/Math.sqrt(K);k=fe*A,T=ue*A,S=pe*A}let R=0,D=0,E=0;if(Math.abs(k)>Math.abs(T)){const A=1/Math.sqrt(k*k+S*S);R=-S*A,E=k*A}else{const A=1/Math.sqrt(T*T+S*S);D=S*A,E=-T*A}const _=T*E-S*D,F=S*R-k*E,C=k*D-T*R,Me=n*R+s*D+r*E,Ae=s*R+a*D+c*E,Se=r*R+c*D+h*E,ke=R*Me+D*Ae+E*Se,ve=_*Me+F*Ae+C*Se,Te=_*(n*_+s*F+r*C)+F*(s*_+a*F+c*C)+C*(r*_+c*F+h*C),Ge=k*(n*k+s*T+r*S)+T*(s*k+a*T+c*S)+S*(r*k+c*T+h*S),me=(ke-Te)/2,$e=Math.sqrt(me*me+ve*ve),Ee=(ke+Te)/2,ze=.5*Math.atan2(ve,me),O=Math.cos(ze),P=Math.sin(ze),qe=(Ee+$e)*e,We=(Ee-$e)*e,Xe=O*R+P*_,Ye=O*D+P*F,He=O*E+P*C,Qe=-P*R+O*_,Je=-P*D+O*F,Ze=-P*E+O*C,ee=M?0:6,te=M?3:0,oe=M?6:3;t[ee/3]=Ge*e,t[te/3]=qe,t[oe/3]=We,o[ee]=k,o[ee+1]=T,o[ee+2]=S,o[te]=Xe,o[te+1]=Ye,o[te+2]=He,o[oe]=Qe,o[oe+1]=Je,o[oe+2]=Ze}function ht(i){const[t,o,e]=[i[0],i[1],i[2]],n=t*t+o*o+e*e;return n>0?Math.min(1,Math.sqrt(.5*((t-o)**2+(o-e)**2+(e-t)**2)/n)):0}function dt(i){return(i[0]+i[1]+i[2])/3}function ft(i,t,o,e){return[i[0]*t+i[1]*o+i[2]*e,i[3]*t+i[4]*o+i[5]*e,i[6]*t+i[7]*o+i[8]*e]}function ut(i){const t=[];for(let o=0;o<3;++o){const e=[i[o],i[4+o],i[8+o]],n=Math.hypot(e[0],e[1],e[2])||1;t.push(e[0]/n,e[1]/n,e[2]/n)}return t}function pt(i,t){return i.map((o,e)=>t[Math.floor(e/3)]?-o:o)}const ne=new Map;function vt(i,t,o,e){const n=`${i}|${t}|${o}|${e.map(r=>r.toFixed(6)).join(",")}`;let s=ne.get(n);if(s===void 0){const{vertices:r,count:a}=Le(o),c=new Float32Array(3*a);for(let h=0;h<a;++h)c.set(ft(e,r[3*h],r[3*h+1],r[3*h+2]),3*h);s=Ie(i,t,c),ne.size>16&&ne.clear(),ne.set(n,s)}return s}const De=new Map;function mt(i){let t=De.get(i);if(t===void 0){const{vertices:o,count:e}=i;t=new Uint32Array(e);for(let n=0;n<e;++n){let s=0,r=1/0;for(let a=0;a<e;++a){const c=o[3*n]*o[3*a]+o[3*n+1]*o[3*a+1]+o[3*n+2]*o[3*a+2];c<r&&([s,r]=[a,c])}t[n]=s}De.set(i,t)}return t}function yt(i,t,o=.5,e=3){const n=mt(t),s=[];for(let c=0;c<t.count;++c){const h=i[c];h>0&&t.rings[c].every(l=>i[l]<=h)&&s.push({vertex:c,value:h})}s.sort((c,h)=>h.value-c.value);const r=[],a=new Set;for(const c of s){if(r.length>=e||c.value<o*(s[0]?.value??0))break;a.has(c.vertex)||a.has(n[c.vertex])||t.rings[c.vertex].some(h=>a.has(h)||a.has(n[h]))||(a.add(c.vertex),r.push(c))}return r}const gt=`#version 300 es
precision highp float;
uniform mat4 uMatrix;
uniform float uScale;
uniform float uLift;
uniform vec3 uViewDir;
uniform vec2 uViewport;
uniform float uWidth;
layout(location = 2) in vec3 aCentre;
layout(location = 3) in vec3 aColour;
layout(location = 4) in vec3 aHalf;
out vec3 vColour;
out vec3 vNormal;
void main() {
  // Two triangles: corners (end, side) from the vertex number.
  int k = gl_VertexID;
  float end = (k == 0 || k == 1 || k == 3) ? -1.0 : 1.0;
  float side = (k == 0 || k == 2 || k == 4) ? -1.0 : 1.0;
  vec4 a = uMatrix * vec4(aCentre - aHalf * uScale, 1.0);
  vec4 b = uMatrix * vec4(aCentre + aHalf * uScale, 1.0);
  vec2 d = (b.xy / b.w - a.xy / a.w) * uViewport;
  vec2 across = dot(d, d) > 1e-6 ? normalize(vec2(-d.y, d.x)) : vec2(1.0, 0.0);
  vec4 p = end < 0.0 ? a : b;
  p.xy += across * side * uWidth / uViewport * p.w;
  if (uLift > 0.0) {
    vec4 lifted = uMatrix * vec4(aCentre + end * aHalf * uScale - uViewDir * uLift, 1.0);
    p.z = lifted.z / lifted.w * p.w;
  }
  gl_Position = p;
  vColour = aColour;
  // No normal: lines are drawn flat, in their colour.
  vNormal = vec3(0.0);
}`,Be=`
uniform mat4 uMatrix;
uniform mat4 uInverse;
uniform vec2 uViewport;
out vec4 vPoint;
out vec4 vNear;
out vec4 vFar;
vec4 cover(vec3 centre, vec3 a0, vec3 a1, vec3 a2, out float halfPx) {
  vec4 c = uMatrix * vec4(centre, 1.0);
  vec2 ndc = c.xy / c.w;
  // How the screen position moves with the point, at the centre.
  vec3 rowX = vec3(uMatrix[0].x, uMatrix[1].x, uMatrix[2].x);
  vec3 rowY = vec3(uMatrix[0].y, uMatrix[1].y, uMatrix[2].y);
  vec3 rowW = vec3(uMatrix[0].w, uMatrix[1].w, uMatrix[2].w);
  vec3 jx = (rowX - ndc.x * rowW) / c.w;
  vec3 jy = (rowY - ndc.y * rowW) / c.w;
  // The ellipse it projects to: S = J M Mᵀ Jᵀ, M the semi-axes.
  vec3 mx = vec3(dot(jx, a0), dot(jx, a1), dot(jx, a2));
  vec3 my = vec3(dot(jy, a0), dot(jy, a1), dot(jy, a2));
  float sxx = dot(mx, mx);
  float sxy = dot(mx, my);
  float syy = dot(my, my);
  float h = 0.5 * (sxx - syy);
  float root = sqrt(h * h + sxy * sxy);
  float mid = 0.5 * (sxx + syy);
  vec2 e1 = h >= 0.0 ? vec2(h + root, sxy) : vec2(sxy, root - h);
  e1 = dot(e1, e1) > 1e-30 ? normalize(e1) : vec2(1.0, 0.0);
  vec2 e2 = vec2(-e1.y, e1.x);
  // Under perspective the near side looks bigger than the centre's scale says.
  float reach = max(length(a0), max(length(a1), length(a2)));
  float grow = 1.0 + 2.0 * length(rowW) * reach / max(abs(c.w), 1e-30);
  // And two pixels more, for the edge's smoothing.
  float pad = 4.0 / min(uViewport.x, uViewport.y);
  int k = gl_VertexID;
  float sx = (k == 0 || k == 1 || k == 3) ? -1.0 : 1.0;
  float sy = (k == 0 || k == 2 || k == 4) ? -1.0 : 1.0;
  float major = sqrt(mid + root) * grow;
  vec2 corner = ndc + sx * e1 * (major + pad) + sy * e2 * (sqrt(max(mid - root, 0.0)) * grow + pad);
  halfPx = major * 0.5 * length(e1 * uViewport);
  // The pixel's ray: a point at the centre's depth, and the near and far planes' points for its direction.
  vPoint = uInverse * vec4(corner, c.z / c.w, 1.0);
  vNear = uInverse * vec4(corner, -1.0, 1.0);
  vFar = uInverse * vec4(corner, 1.0, 1.0);
  return vec4(corner * c.w, c.z, c.w);
}`,xt=`#version 300 es
precision highp float;
${Be}
uniform float uScale;
layout(location = 2) in vec3 aCentre;
layout(location = 3) in vec3 aColour;
layout(location = 5) in vec3 aAxis0;
layout(location = 6) in vec3 aAxis1;
layout(location = 7) in vec3 aAxis2;
out vec3 vColour;
flat out vec3 vCentre;
flat out vec3 vInv0;
flat out vec3 vInv1;
flat out vec3 vInv2;
void main() {
  vec3 a0 = aAxis0 * uScale;
  vec3 a1 = aAxis1 * uScale;
  vec3 a2 = aAxis2 * uScale;
  // The semi-axes are orthogonal: the inverse's rows are them over their squared lengths.
  vInv0 = a0 / max(dot(a0, a0), 1e-30);
  vInv1 = a1 / max(dot(a1, a1), 1e-30);
  vInv2 = a2 / max(dot(a2, a2), 1e-30);
  float halfPx;
  gl_Position = cover(aCentre, a0, a1, a2, halfPx);
  vCentre = aCentre;
  vColour = aColour;
}`,wt=`#version 300 es
precision highp float;
${Be}
uniform float uScale;
layout(location = 2) in vec3 aCentre;
layout(location = 8) in float aBound;
flat out vec3 vCentre;
flat out float vBound;
flat out int vGlyph;
flat out float vPxPerUnit;
flat out int vSteps;
void main() {
  float r = aBound * uScale;
  float halfPx;
  gl_Position = cover(aCentre, vec3(r, 0.0, 0.0), vec3(0.0, r, 0.0), vec3(0.0, 0.0, r), halfPx);
  vCentre = aCentre;
  vBound = aBound;
  vGlyph = gl_InstanceID;
  vPxPerUnit = halfPx / max(aBound, 1e-6);
  // About one step every two pixels across the bounding sphere.
  vSteps = int(clamp(halfPx, 10.0, 48.0));
}`,bt=i=>{const t=(i+1)*(i+2)/2,o=Math.ceil(t/4),e=(a,c)=>c===0?"":` * ${a}${c}`,n=[];let s=0;for(let a=0;a<=i;++a){const c=[];for(let h=0;h<=i-a;++h,++s)c.push(`C[${s>>2}].${"xyzw"[s&3]}${e("x",i-a-h)}${e("y",h)}`);n.push(`  s += (${c.join(" + ")})${e("z",a)};`)}const r=a=>Array.from({length:i},(c,h)=>h===0?`  float ${a}1 = q.${a};`:`  float ${a}${h+1} = ${a}${h} * ${a}1;`).join(`
`);return`
#define TEXELS ${o}
uniform mat3 uToData;
vec4 C[TEXELS];
float odf(vec3 w) {
  vec3 q = uToData * w;
${i>0?[r("x"),r("y"),r("z")].join(`
`):""}
  float s = 0.0;
${n.join(`
`)}
  return s;
}
void loadCoefficients(highp sampler2D coefficients, int glyph, int perRow) {
  ivec2 at = ivec2((glyph % perRow) * TEXELS, glyph / perRow);
  for (int k = 0; k < TEXELS; ++k) C[k] = texelFetch(coefficients, at + ivec2(k, 0), 0);
}`},Mt=(i,t,o)=>`#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform mat4 uMatrix;
uniform vec3 uViewDir;
uniform float uLift;
uniform float uScale;
uniform sampler2D uCoefficients;
uniform int uPerRow;
${bt(o)}
flat in vec3 vCentre;
flat in float vBound;
flat in int vGlyph;
flat in float vPxPerUnit;
flat in int vSteps;
in vec4 vPoint;
in vec4 vNear;
in vec4 vFar;
layout(location = ${i.color}) out vec4 out_color;
${i.z!==void 0?`layout(location = ${i.z}) out highp vec4 out_z;`:""}
${i.pick!==void 0?`layout(location = ${i.pick}) out highp vec4 out_pickId;`:""}
// Outside the surface positive, inside negative.
float field(vec3 p) {
  float len = length(p);
  return len - max(0.0, odf(p / max(len, 1e-12)));
}
void main() {
  loadCoefficients(uCoefficients, vGlyph, uPerRow);
  // The ray from near the centre, in the glyph's units (its radius 1 is uScale mm).
  vec3 o = (vPoint.xyz / vPoint.w - vCentre) / uScale;
  vec3 d = normalize(vFar.xyz / vFar.w - vNear.xyz / vNear.w);
  float b = dot(o, d);
  float disc = b * b - (dot(o, o) - vBound * vBound);
  if (disc <= 0.0) discard;
  float s = sqrt(disc);
  float t0 = -b - s;
  float dt = 2.0 * s / float(vSteps);
  float ta = t0;
  float fa = field(o + t0 * d);
  float tb = t0;
  float fb = fa;
  float best = fa;
  float tBest = t0;
  bool hit = false;
  for (int i = 1; i <= 48; ++i) {
    if (i > vSteps) break;
    float t = t0 + dt * float(i);
    float f = field(o + t * d);
    if (f < 0.0) {
      hit = true;
      tb = t;
      fb = f;
      break;
    }
    if (f < best) {
      best = f;
      tBest = t;
    }
    ta = t;
    fa = f;
  }
  float t;
  float coverage = 1.0;
  if (hit) {
    for (int k = 0; k < 6; ++k) {
      float tm = 0.5 * (ta + tb);
      float fm = field(o + tm * d);
      if (fm < 0.0) {
        tb = tm;
        fb = fm;
      } else {
        ta = tm;
        fa = fm;
      }
    }
    t = ta + (tb - ta) * fa / max(fa - fb, 1e-20);
  } else {
    ${t?`// Missed: within a pixel of the surface (radially) is the edge, partly covered.
    coverage = clamp(1.0 - best * vPxPerUnit, 0.0, 1.0);
    if (coverage <= 0.0) discard;
    t = tBest;`:"discard;"}
  }
  vec3 p = o + t * d;
  float rho = length(p);
  vec3 w = p / max(rho, 1e-12);
  // The normal: the gradient of |p| - r(p / |p|), r's along the sphere by differences.
  vec3 u = normalize(cross(w, abs(w.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
  vec3 v = cross(w, u);
  float h = 0.01;
  float r0 = odf(w);
  vec3 slope = ((odf(normalize(w + h * u)) - r0) * u + (odf(normalize(w + h * v)) - r0) * v) / h;
  vec3 normal = w - slope / max(rho, 1e-3);
  vec4 clip = uMatrix * vec4(vCentre + p * uScale - uViewDir * uLift, 1.0);
  float z = clip.z / clip.w;
  if (z < -1.0 || z > 1.0) discard;
  float depth = 0.5 * z + 0.5;
  gl_FragDepth = depth;
  float diffuse = abs(dot(normalize(normal), uViewDir));
  vec3 colour = abs(w) * (0.3 + 0.7 * diffuse) + vec3(0.18) * pow(diffuse, 24.0);
  out_color = vec4(colour * coverage, coverage);
  ${i.z!==void 0?"out_z = vec4(1.0 - depth);":""}
  ${i.pick!==void 0?"out_pickId = vec4(0.0);":""}
}`,At=(i,t)=>`#version 300 es
precision highp float;
uniform mat4 uMatrix;
uniform vec3 uViewDir;
uniform float uLift;
in vec3 vColour;
flat in vec3 vCentre;
flat in vec3 vInv0;
flat in vec3 vInv1;
flat in vec3 vInv2;
in vec4 vPoint;
in vec4 vNear;
in vec4 vFar;
layout(location = ${i.color}) out vec4 out_color;
${i.z!==void 0?`layout(location = ${i.z}) out highp vec4 out_z;`:""}
${i.pick!==void 0?`layout(location = ${i.pick}) out highp vec4 out_pickId;`:""}
void main() {
  // The ray from near the centre, in the frame where the ellipsoid is the unit sphere.
  vec3 o = vPoint.xyz / vPoint.w - vCentre;
  vec3 d = normalize(vFar.xyz / vFar.w - vNear.xyz / vNear.w);
  vec3 lo = vec3(dot(vInv0, o), dot(vInv1, o), dot(vInv2, o));
  vec3 ld = vec3(dot(vInv0, d), dot(vInv1, d), dot(vInv2, d));
  float a = dot(ld, ld);
  float t0 = -dot(lo, ld) / a;
  vec3 closest = lo + t0 * ld;
  float r2 = dot(closest, closest);
  float coverage = 1.0;
  ${t?`float r = sqrt(r2);
  coverage = clamp(0.5 + (1.0 - r) / max(fwidth(r), 1e-6), 0.0, 1.0);
  if (coverage <= 0.0) discard;`:"if (r2 > 1.0) discard;"}
  // The near meeting (the closest approach, on the edge itself).
  float t = t0 - sqrt(max(1.0 - r2, 0.0) / a);
  vec3 local = lo + t * ld;
  vec3 normal = local.x * vInv0 + local.y * vInv1 + local.z * vInv2;
  vec4 clip = uMatrix * vec4(vCentre + o + t * d - uViewDir * uLift, 1.0);
  float z = clip.z / clip.w;
  if (z < -1.0 || z > 1.0) discard;
  float depth = 0.5 * z + 0.5;
  gl_FragDepth = depth;
  float diffuse = abs(dot(normalize(normal), uViewDir));
  vec3 colour = vColour * (0.3 + 0.7 * diffuse) + vec3(0.18) * pow(diffuse, 24.0);
  out_color = vec4(colour * coverage, coverage);
  ${i.z!==void 0?"out_z = vec4(1.0 - depth);":""}
  ${i.pick!==void 0?"out_pickId = vec4(0.0);":""}
}`;function St(i){const t=Array.from(i,Number),o=new Float32Array(16),e=[0,1,2,3].map(n=>[0,1,2,3].map(s=>t[4*s+n]).concat([0,1,2,3].map(s=>s===n?1:0)));for(let n=0;n<4;++n){let s=n;for(let a=n+1;a<4;++a)Math.abs(e[a][n])>Math.abs(e[s][n])&&(s=a);[e[n],e[s]]=[e[s],e[n]];const r=e[n][n]||1e-30;for(let a=0;a<8;++a)e[n][a]/=r;for(let a=0;a<4;++a){if(a===n)continue;const c=e[a][n];if(c!==0)for(let h=0;h<8;++h)e[a][h]-=c*e[n][h]}}for(let n=0;n<4;++n)for(let s=0;s<4;++s)o[4*s+n]=e[n][4+s];return o}const kt=i=>`#version 300 es
precision highp float;
uniform vec3 uViewDir;
in vec3 vColour;
in vec3 vNormal;
layout(location = ${i.color}) out vec4 out_color;
${i.z!==void 0?`layout(location = ${i.z}) out highp vec4 out_z;`:""}
${i.pick!==void 0?`layout(location = ${i.pick}) out highp vec4 out_pickId;`:""}
void main() {
  vec3 colour = vColour;
  if (dot(vNormal, vNormal) > 0.0) {
    float diffuse = abs(dot(normalize(vNormal), uViewDir));
    colour = vColour * (0.3 + 0.7 * diffuse) + vec3(0.18) * pow(diffuse, 24.0);
  }
  out_color = vec4(colour, 1.0);
  ${i.z!==void 0?"out_z = vec4(1.0 - gl_FragCoord.z);":""}
  ${i.pick!==void 0?"out_pickId = vec4(0.0);":""}
}`;class Ue{constructor(t,o){this.gl=t,this.outputs=o,this.maxTexture=t.getParameter(t.MAX_TEXTURE_SIZE)}odfs=new Map;line;ellipsoid;smooth;sets=new WeakMap;made=[];maxTexture;program(t,o=kt(this.outputs)){const{gl:e}=this,n=(r,a)=>{const c=e.createShader(r);if(e.shaderSource(c,a),e.compileShader(c),!e.getShaderParameter(c,e.COMPILE_STATUS))throw new Error(e.getShaderInfoLog(c)??"shader did not compile");return c},s=e.createProgram();if(e.attachShader(s,n(e.VERTEX_SHADER,t)),e.attachShader(s,n(e.FRAGMENT_SHADER,o)),e.linkProgram(s),!e.getProgramParameter(s,e.LINK_STATUS))throw new Error(e.getProgramInfoLog(s)??"program did not link");return s}nearest(){const{gl:t}=this;t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE)}buffers(t){let o=this.sets.get(t);if(o!==void 0)return o;const{gl:e}=this,n=e.createVertexArray();let s=1,r,a;if(t.shape==="odfs"){e.bindVertexArray(n),r=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,r),e.bufferData(e.ARRAY_BUFFER,t.bounds,e.STATIC_DRAW),e.enableVertexAttribArray(8),e.vertexAttribPointer(8,1,e.FLOAT,!1,0,0),e.vertexAttribDivisor(8,1);const l=(t.lmax+1)*(t.lmax+2)/2,d=Math.ceil(l/4);s=Math.max(1,Math.floor(this.maxTexture/d));const u=Math.max(1,Math.ceil(t.count/s)),y=(Math.min(t.count,s)||1)*d,v=new Float32Array(4*y*u),f=t.coefficients;for(let p=0;p<t.count;++p)v.set(f.subarray(p*l,(p+1)*l),4*(Math.floor(p/s)*y+p%s*d));a=e.createTexture(),e.bindTexture(e.TEXTURE_2D,a),e.pixelStorei(e.UNPACK_ALIGNMENT,4),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,y,u,0,e.RGBA,e.FLOAT,v),this.nearest(),e.bindTexture(e.TEXTURE_2D,null)}else if(t.shape==="ellipsoids"){e.bindVertexArray(n),r=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,r),e.bufferData(e.ARRAY_BUFFER,t.axes,e.STATIC_DRAW);for(let l=0;l<3;++l)e.enableVertexAttribArray(5+l),e.vertexAttribPointer(5+l,3,e.FLOAT,!1,36,12*l),e.vertexAttribDivisor(5+l,1)}else e.bindVertexArray(n),r=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,r),e.bufferData(e.ARRAY_BUFFER,t.dirs,e.STATIC_DRAW),e.enableVertexAttribArray(4),e.vertexAttribPointer(4,3,e.FLOAT,!1,0,0),e.vertexAttribDivisor(4,1);const c=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,c),e.bufferData(e.ARRAY_BUFFER,t.centres,e.STATIC_DRAW),e.enableVertexAttribArray(2),e.vertexAttribPointer(2,3,e.FLOAT,!1,0,0),e.vertexAttribDivisor(2,1);const h=e.createBuffer();return e.bindBuffer(e.ARRAY_BUFFER,h),e.bufferData(e.ARRAY_BUFFER,t.colours??new Float32Array(3*Math.max(1,t.count)),e.STATIC_DRAW),e.enableVertexAttribArray(3),e.vertexAttribPointer(3,3,e.FLOAT,!1,0,0),e.vertexAttribDivisor(3,1),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null),o={vao:n,centres:c,colours:h,dirs:r,texture:a,perRow:s},this.sets.set(t,o),this.made.push({set:t,buffers:o}),o}keepOnly(t){const o=new Set(t),{gl:e}=this;this.made=this.made.filter(({set:n,buffers:s})=>o.has(n)?!0:(e.deleteVertexArray(s.vao),e.deleteBuffer(s.centres),e.deleteBuffer(s.colours),s.dirs&&e.deleteBuffer(s.dirs),s.texture&&e.deleteTexture(s.texture),this.sets.delete(n),!1))}draw(t,o){if(t.count===0)return;const{gl:e}=this,n=this.buffers(t),s=t.shape==="odfs",r=t.shape==="ellipsoids",a=this.smooth??=this.outputs.z===void 0&&e.getParameter(e.SAMPLES)>1;let c;if(s){const l=t.lmax;let d=this.odfs.get(l);d===void 0&&this.odfs.set(l,d=this.program(wt,Mt(this.outputs,a,l))),c=d}else r?c=this.ellipsoid??=this.program(xt,At(this.outputs,a)):c=this.line??=this.program(gt);e.useProgram(c);const h=l=>e.getUniformLocation(c,l);if(e.uniformMatrix4fv(h("uMatrix"),!1,o.matrix),e.uniform3fv(h("uViewDir"),o.viewDir),e.uniform1f(h("uScale"),o.scale),e.uniform1f(h("uLift"),o.lift),e.bindVertexArray(n.vao),s||r){if(e.uniformMatrix4fv(h("uInverse"),!1,St(o.matrix)),e.uniform2fv(h("uViewport"),o.viewport),s){const l=t.toData;e.uniformMatrix3fv(h("uToData"),!1,[l[0],l[3],l[6],l[1],l[4],l[7],l[2],l[5],l[8]]),e.uniform1i(h("uPerRow"),n.perRow),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,n.texture),e.uniform1i(h("uCoefficients"),0)}a&&e.enable(e.SAMPLE_ALPHA_TO_COVERAGE),e.drawArraysInstanced(e.TRIANGLES,0,6,t.count),a&&e.disable(e.SAMPLE_ALPHA_TO_COVERAGE),s&&e.bindTexture(e.TEXTURE_2D,null)}else e.uniform2fv(h("uViewport"),o.viewport),e.uniform1f(h("uWidth"),o.lineWidth),e.drawArraysInstanced(e.TRIANGLES,0,6,t.count);e.bindVertexArray(null)}dispose(){const{gl:t}=this;this.keepOnly([]);for(const o of this.odfs.values())t.deleteProgram(o);this.odfs.clear(),this.line&&t.deleteProgram(this.line),this.ellipsoid&&t.deleteProgram(this.ellipsoid),this.line=this.ellipsoid=void 0}}function Tt(i,t){const o=i.toScreen,{width:e,height:n,origin:s}=i,r=Math.hypot(o[8],o[9],o[10])||1,a=o[8]*s[0]+o[9]*s[1]+o[10]*s[2]+o[11],c=[[2/e*o[0],2/e*o[1],2/e*o[2],2/e*o[3]-1],[-2/n*o[4],-2/n*o[5],-2/n*o[6],-2/n*o[7]+1],[o[8]/r/t,o[9]/r/t,o[10]/r/t,(o[11]-a)/r/t],[0,0,0,1]],h=new Float32Array(16);for(let l=0;l<4;++l)for(let d=0;d<4;++d)h[4*d+l]=c[l][d];return h}class $t{canvas=document.createElement("canvas");gl;renderer;problem;constructor(t){this.canvas.className="orientations-canvas",this.canvas.style.cssText="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;",t.append(this.canvas),this.gl=this.canvas.getContext("webgl2",{alpha:!0,depth:!0,premultipliedAlpha:!0,antialias:!0,preserveDrawingBuffer:!1}),this.gl===null?this.problem="This browser has no WebGL2 for the 2-D glyphs.":this.renderer=new Ue(this.gl,{color:0})}draw(t,o){const{gl:e,renderer:n,canvas:s}=this;if(e===null||n===void 0)return;const r=window.devicePixelRatio||1,a=Math.max(1,Math.round(s.clientWidth*r)),c=Math.max(1,Math.round(s.clientHeight*r));(s.width!==a||s.height!==c)&&(s.width=a,s.height=c),e.disable(e.SCISSOR_TEST),e.viewport(0,0,a,c),e.clearColor(0,0,0,0),e.clearDepth(1),e.clear(e.COLOR_BUFFER_BIT|e.DEPTH_BUFFER_BIT);const h=[];e.enable(e.SCISSOR_TEST),e.enable(e.DEPTH_TEST),e.depthFunc(e.LESS),e.disable(e.BLEND),e.disable(e.CULL_FACE);for(const l of t){const d=Math.round(l.left*r),u=Math.round(c-(l.top+l.height)*r),y=Math.round(l.width*r),v=Math.round(l.height*r);if(!(y<=0||v<=0)){e.viewport(d,u,y,v),e.scissor(d,u,y,v);for(const{set:f,scale:p,depthRange:m}of l.sets)h.push(f),n.draw(f,{matrix:Tt(l.section,m),viewDir:l.section.normal,scale:p,viewport:[y,v],lineWidth:o*r,lift:0})}}e.disable(e.SCISSOR_TEST),n.keepOnly(h)}dispose(){this.renderer?.dispose(),this.canvas.remove()}}const I=i=>{if(i===0)return"0";const t=Math.abs(i);return t>=.01&&t<1e3?i.toFixed(t>=10?1:3).replace(/\.?0+$/,""):i.toExponential(2)},ge=i=>`(${Array.from(i,t=>(Math.abs(t)<.005?0:t).toFixed(2)).join(", ")})`;function _e(i,t){return[0,1,2].map(o=>i[o]*t[0]+i[3+o]*t[1]+i[6+o]*t[2])}function Et(i,t,o){if(Array.from({length:t},(n,s)=>i[s]).every(n=>n===0||n!==n))return"nothing here";if(o.kind==="tensor"&&t===6){const n=ct(at(i,0,o.tensorOrder)),s=_e(o.toData,n.vectors.subarray(0,3));return`FA ${I(ht(n.values))}, MD ${I(dt(n.values))}, λ ${n.values.map(I).join(" / ")}, V1 ${ge(s)}`}if(o.kind==="sh"){const n=U(t);if(n===void 0)return`${t} components`;const s=Le(3),r=st(vt(o.basis,n,3,o.toData),t,i,0,new Float32Array(s.count)),a=yt(r,s),c=a[0]?.value??1,h=a.map(l=>`${ge(s.vertices.subarray(3*l.vertex,3*l.vertex+3))} ${I(l.value/c)}`);return`GFA ${I(it(i,0,t,o.basis))}; ${a.length===0?"no peaks":`peaks ${h.join(", ")}`}`}const e=[];for(let n=0;n+2<t;n+=3){const s=[i[n],i[n+1],i[n+2]],r=Math.hypot(s[0],s[1],s[2]);if(r>0&&(e.push(`${ge(_e(o.toData,s.map(a=>a/r)))} × ${I(r)}`),o.kind==="vector"))break}return e.length===0?"nothing here":e.join(", ")}const zt=i=>{const t=Number(i.toPrecision(7)).toString();return/[.e]/.test(t)?t:`${t}.0`},L=i=>`mat3(${Array.from(i,zt).join(", ")})`,Rt=`
vec3 principal(mat3 m) {
  float t = (m[0][0] + m[1][1] + m[2][2]) / 3.0;
  mat3 a = m - t * mat3(1.0);
  float n = sqrt(dot(a[0], a[0]) + dot(a[1], a[1]) + dot(a[2], a[2]));
  if (n <= 0.0) return vec3(0.0);
  mat3 b = a / n + mat3(1.0);
  b = b * b;
  // Start from b's longest column: never at right angles to the answer.
  vec3 e = b[0];
  if (dot(b[1], b[1]) > dot(e, e)) e = b[1];
  if (dot(b[2], b[2]) > dot(e, e)) e = b[2];
  for (int i = 0; i < 12; ++i) e = normalize(b * e);
  return e;
}
`;function Dt(i,t){const o=L(i.toData),e=`#uicontrol float brightness slider(min=0.2, max=4, default=1)
// Direction colour (orientations plugin): |x| red, |y| green, |z| blue, weighted by anisotropy.
float component(int i) { return toNormalized(getDataValue(i)); }
${Rt}`;if(i.kind==="vector"||i.kind==="peaks")return`${e}
void main() {
  vec3 v = vec3(component(0), component(1), component(2));
  float n = length(v);
  if (!(n > 0.0)) { emitRGB(vec3(0.0)); return; }
  emitRGB(clamp(abs(${o} * (v / n)) * min(n, 1.0) * brightness, 0.0, 1.0));
}
`;if(i.kind==="tensor"){if(t!==6)return;const[a,c,h,l,d,u]=Ne[i.tensorOrder];return`${e}
void main() {
  float xx = component(${a}), xy = component(${c}), xz = component(${h});
  float yy = component(${l}), yz = component(${d}), zz = component(${u});
  mat3 d = mat3(xx, xy, xz, xy, yy, yz, xz, yz, zz);
  float nd = sqrt(dot(d[0], d[0]) + dot(d[1], d[1]) + dot(d[2], d[2]));
  if (!(nd > 0.0)) { emitRGB(vec3(0.0)); return; }
  float t = (xx + yy + zz) / 3.0;
  mat3 a = d - t * mat3(1.0);
  float fa = clamp(sqrt(1.5) * sqrt(dot(a[0], a[0]) + dot(a[1], a[1]) + dot(a[2], a[2])) / nd, 0.0, 1.0);
  emitRGB(clamp(abs(${o} * principal(d)) * fa * brightness, 0.0, 1.0));
}
`}const n=U(t);if(n===void 0||n<2)return;const s=rt(i.basis),r=i.basis==="tournier07-legacy";return`${e}
void main() {
  float c0 = component(0);
  mat3 q = component(1) * ${L(s[0])}
    + component(2) * ${L(s[1])}
    + component(3) * ${L(s[2])}
    + component(4) * ${L(s[3])}
    + component(5) * ${L(s[4])};
  float total = c0 * c0;
  for (int i = 1; i < ${t}; ++i) { float c = component(i); total += ${r?"2.0 * ":""}c * c; }
  if (!(total > 0.0)) { emitRGB(vec3(0.0)); return; }
  float gfa = sqrt(max(0.0, 1.0 - c0 * c0 / total));
  emitRGB(clamp(abs(${o} * principal(q)) * gfa * brightness, 0.0, 1.0));
}
`}function _t(i,t,o,e){const n=i(t);if(n===void 0)return;const s=[];for(let p=0;p<3;++p){const m=[...t];m[p]+=1;const x=i(m);if(x===void 0)return;s.push([x.x-n.x,x.y-n.y,x.depth-n.depth])}const r=p=>[s[0][p],s[1][p],s[2][p]],[a,c]=[r(0),r(1)],h=[a[1]*c[2]-a[2]*c[1],a[2]*c[0]-a[0]*c[2],a[0]*c[1]-a[1]*c[0]],l=Math.hypot(h[0],h[1],h[2]),d=Math.sqrt(Math.hypot(a[0],a[1],a[2])*Math.hypot(c[0],c[1],c[2]));if(!(l>0)||!(d>0))return;const u=h.map(p=>p/l),y=u,v=[n.x,n.y,0].map((p,m)=>p-[a,c,y][m].reduce((x,g,w)=>x+g*t[w],0));return{toScreen:[...a,v[0],...c,v[1],...y,v[2]],width:o,height:e,origin:t,normal:u,pxPerMm:d}}function Ft(i,t){const[o,e,n,s,r,a,c,h,l]=i,d=o*(r*l-a*h)-e*(s*l-a*c)+n*(s*h-r*c);if(Math.abs(d)<1e-300)return;const u=[r*l-a*h,n*h-e*l,e*a-n*r,a*c-s*l,o*l-n*c,n*s-o*a,s*h-r*c,e*c-o*h,o*r-e*s].map(y=>y/d);return[0,1,2].map(y=>u[3*y]*t[0]+u[3*y+1]*t[1]+u[3*y+2]*t[2])}function Ct(i,t,o){const e=i.toScreen,n=e[8]*i.origin[0]+e[9]*i.origin[1]+e[10]*i.origin[2]+e[11];return Ft([e[0],e[1],e[2],e[4],e[5],e[6],e[8],e[9],e[10]],[t-e[3],o-e[7],n-e[11]])}function je(i,t,o){for(let e=0;e<i.length;++e)if(i[e]*t>=o*.98)return e;return i.length-1}function N(i){const t=Array.from({length:4},(o,e)=>[...Array.from({length:4},(n,s)=>i[4*e+s]),...[0,1,2,3].map(n=>n===e?1:0)]);for(let o=0;o<4;++o){let e=o;for(let s=o+1;s<4;++s)Math.abs(t[s][o])>Math.abs(t[e][o])&&(e=s);[t[o],t[e]]=[t[e],t[o]];const n=t[o][o];if(Math.abs(n)<1e-300)throw new Error("singular transform");for(let s=0;s<8;++s)t[o][s]/=n;for(let s=0;s<4;++s){if(s===o)continue;const r=t[s][o];if(r!==0)for(let a=0;a<8;++a)t[s][a]-=r*t[o][a]}}return t.flatMap(o=>o.slice(4))}function B(i,t){return[0,1,2].map(o=>i[4*o]*t[0]+i[4*o+1]*t[1]+i[4*o+2]*t[2]+i[4*o+3])}function Ot(i,t,o){const e=[0,1,2].map(a=>i[a]*o[0]+i[4+a]*o[1]+i[8+a]*o[2]),n=o.reduce((a,c,h)=>a+c*(t[h]-i[4*h+3]),0),s=Math.hypot(e[0],e[1],e[2])||1,r=e.map(a=>a/s);return{n:r,d:n/s,h:.5*Math.max(...r.map(Math.abs))}}function Fe(i,t,o,e){const n=N(i),s=[1/0,1/0,1/0],r=[-1/0,-1/0,-1/0];for(const c of o){const h=B(n,c);for(let l=0;l<3;++l)s[l]=Math.min(s[l],h[l]),r[l]=Math.max(r[l],h[l])}const a={lo:[0,0,0],hi:[0,0,0]};for(let c=0;c<3;++c){const h=(r[c]-s[c])*e+1;if(a.lo[c]=Math.max(0,Math.floor(s[c]-h)),a.hi[c]=Math.min(t[c],Math.ceil(r[c]+h)+1),a.hi[c]<=a.lo[c])return}return a}function Pt(i,t){return[0,1,2].every(o=>i.lo[o]<=t.lo[o]&&i.hi[o]>=t.hi[o])}function It(i,t){const o=[0,1,2].map(n=>i.hi[n]-i.lo[n]),e=[0,1,2].reduce((n,s)=>Math.abs(t.n[s])>Math.abs(t.n[n])?s:n,0);return o.reduce((n,s)=>n*s,1)/o[e]}function Lt(i,t,o){const e=i.map((r,a)=>Math.max(0,Math.min(t[a]-1,Math.round(r)))),n={lo:e.map(r=>Math.max(0,r-o)),hi:e.map((r,a)=>Math.min(t[a],r+o+1))},s=[0,1,2].map(r=>({n:[0,1,2].map(a=>a===r?1:0),d:e[r],h:.5}));return{box:n,slabs:s}}function Nt(i,t,o){const e=[[0,0],[t.width,0],[0,t.height],[t.width,t.height]].map(([n,s])=>Ct(t,n,s));if(e.some(n=>n===void 0))return{note:""};for(let n=je(i.map(s=>s.voxelSize),t.pxPerMm,o.spacing);n<i.length;++n){const s=i[n],r=Fe(s.voxelToRas,s.size,e,0),a=Fe(s.voxelToRas,s.size,e,.25);if(r===void 0||a===void 0)return{note:""};const c=Ot(s.voxelToRas,t.origin,t.normal);if(It(r,c)>o.maxGlyphs)continue;const h=s.voxelSize*t.pxPerMm;if(h<4)return{note:"Zoom in to show glyphs (under 4 pixels apart)"};const l=h*o.size>=40?3:2,d=`${n}|${c.n.map(u=>u.toFixed(4)).join(",")}|${Math.round(c.d*1e3)}|${l}`;return{level:n,box:a,visible:r,slabs:[c],key:d,subdivisions:l}}return{note:`more than ${o.maxGlyphs} glyphs even at the coarsest level: zoom in`}}function Bt(i){const t=i.rank+1,o=d=>Array.from({length:t},(u,y)=>Array.from({length:t},(v,f)=>d[f*t+y])),e=o(i.matrix),n=o(i.defaultMatrix).map((d,u)=>[...d,...Array.from({length:t},(y,v)=>v===u?1:0)]);for(let d=0;d<t;++d){let u=d;for(let v=d+1;v<t;++v)Math.abs(n[v][d])>Math.abs(n[u][d])&&(u=v);[n[d],n[u]]=[n[u],n[d]];const y=n[d][d];if(Math.abs(y)<1e-300)return;for(let v=0;v<2*t;++v)n[d][v]/=y;for(let v=0;v<t;++v){if(v===d)continue;const f=n[v][d];if(f!==0)for(let p=0;p<2*t;++p)n[v][p]-=f*n[d][p]}}const s=n.map(d=>d.slice(t)),r=e.map(d=>s[0].map((u,y)=>d.reduce((v,f,p)=>v+f*s[p][y],0))),a=["x","y","z"].map(d=>i.output.names.indexOf(d));if(a.includes(-1))return;const c=d=>i.output.units[d]==="m"?i.output.scales[d]*1e3:i.output.scales[d],h=[];for(let d=0;d<3;++d){const u=a[d];for(let y=0;y<3;++y)h.push(r[u][a[y]]*c(u)/c(a[y]));h.push(r[u][t-1]*c(u))}h.push(0,0,0,1);const l=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];return h.every((d,u)=>Math.abs(d-l[u])<1e-9)?void 0:h}const Ve=["sh","tensor","vector","peaks"];function be(i){const t=i??{},o=(s,r,a)=>r.includes(s)?s:a,e=Array.isArray(t.flips)&&t.flips.length===3?t.flips.map(s=>s===!0):[!1,!1,!1],n=(s,r,a,c)=>typeof s=="number"&&Number.isFinite(s)?Math.min(a,Math.max(r,s)):c;return{on:t.on===!0,layer:typeof t.layer=="string"?t.layer:void 0,kind:o(t.kind,["auto",...Ve],"auto"),basis:o(t.basis,["auto",...xe.map(([s])=>s)],"auto"),tensorOrder:o(t.tensorOrder,["auto",...we.map(([s])=>s)],"auto"),frame:o(t.frame,["auto","voxel","world"],"auto"),flips:e,normalise:o(t.normalise,["minmax","max","none"],"minmax"),tensorGlyph:o(t.tensorGlyph,["ellipsoid","line"],"ellipsoid"),shGlyph:o(t.shGlyph,["odf","peaks"],"odf"),size:n(t.size,.2,3,1),spacing:n(t.spacing,4,200,24),maxGlyphs:n(t.maxGlyphs,100,5e4,8e3),minAnisotropy:n(t.minAnisotropy,0,1,0),show2d:t.show2d!==!1,show3d:t.show3d!==!1}}function Ce(i,t,o){if(i.kind!=="auto")return i.kind;const e=t.metadata?.type;return e!==void 0&&Ve.includes(e)?e:o===3?"vector":o===6?"tensor":U(o)!==void 0?"sh":"peaks"}function Ut(i,t){if(i.basis!=="auto")return i.basis;const o=t.metadata,e=String(o?.basis??"").toLowerCase();return e.startsWith("tournier")||e==="mrtrix"||e==="mrtrix3"?o?.legacy===!0?"tournier07-legacy":"tournier07":(e.startsWith("descoteaux")||e==="dipy")&&o?.legacy===!1?"descoteaux07":"descoteaux07-legacy"}function jt(i,t){if(i.tensorOrder!=="auto")return i.tensorOrder;const o=String(t.metadata?.order??"");return o==="dipy"||o==="mrtrix"||o==="fsl"?o:t.nifti?.intent===1005?"dipy":"fsl"}function Vt(i,t,o,e){if(i.frame!=="auto")return i.frame;const n=t.metadata?.frame;return n==="voxel"||n==="world"?n:e==="sh"&&o.startsWith("tournier")?"world":"voxel"}function b(i,t={},...o){const e=document.createElement(i);for(const[n,s]of Object.entries(t))s===void 0||s===!1||(n.startsWith("on")&&typeof s=="function"?e.addEventListener(n.slice(2),s):n==="class"?e.className=String(s):e.setAttribute(n,s===!0?"":String(s)));for(const n of o)n!=null&&n!==!1&&e.append(n);return e}const se=i=>i>=1?`${+i.toFixed(2)} mm`:`${Math.round(i*1e3)} µm`;class Gt{constructor(t){this.ctx=t,this.saved=be(t.state.get()),this.toggle=t.ui.viewToggle({label:"Glyphs",title:"Orientation glyphs (ODFs, tensors, peaks) over the image; the Orientations tab has their settings",value:this.saved.on,onChange:o=>this.set({on:o})}),this.offs.push(t.state.onChanged(()=>{const o=be(t.state.get());JSON.stringify(o)!==JSON.stringify(this.saved)&&(this.saved=o,this.toggle.set(o.on),this.settingsChanged())}),t.viewer.onLayersChanged(()=>this.update()),t.viewer.onStateChanged(()=>{this.readSpace(),this.schedule()}),t.viewer.onRendered(()=>this.schedule()),t.viewer.onCursorChanged(()=>{clearTimeout(this.cursorTimer),this.cursorTimer=setTimeout(()=>this.readCursor(),120)}),()=>clearTimeout(this.cursorTimer),t.ui.screenshotOverlay((o,e)=>this.paintScreenshot(o,e)),()=>clearTimeout(this.timer)),this.readSpace(),this.update()}saved;client;store;opened;openError;failed;disposed=!1;overlay;glyphOverlay;handle;handleLayer;renderer3d;slots=new Map;space;timer;queued=!1;panelUpdate;toggle;offs=[];probed=new Map;set(t){this.saved={...this.saved,...t},this.ctx.state.set(this.saved),t.on!==void 0&&this.toggle.set(t.on),this.settingsChanged()}settingsChanged(t=!0){for(const o of this.slots.values())o.pending?.controller.abort(),o.pending=void 0,o.shown&&(o.shown.key="");this.update(),t&&this.retellStore().catch(o=>{this.disposed||(this.openError=`Could not remake the image's coarser levels: ${o.message}`,this.panelUpdate?.())})}readSpace(){const t=this.ctx.viewer.getState(),o=t.dimensions??{},e=Object.keys(o);this.space={names:e,scales:e.map(r=>o[r][0]),units:e.map(r=>o[r][1]),position:t.position??e.map(()=>0),projectionScale:t.projectionScale};const n=this.handleLayer===void 0?void 0:this.ctx.viewer.layerTransform(this.handleLayer),s=n===void 0?void 0:Bt(n);if(JSON.stringify(s)!==JSON.stringify(this.move)){this.move=s;for(const r of this.slots.values())r.shown&&(r.shown.key="")}}globalOf(t){const o=this.space;if(o===void 0)return;this.move!==void 0&&(t=B(this.move,t));const e=[...o.position];let n=0;return o.names.forEach((s,r)=>{const a=["x","y","z"].indexOf(s);a!==-1&&(n++,e[r]=o.units[r]==="m"?t[a]*.001/o.scales[r]:t[a]/o.scales[r])}),n===3?e:void 0}originRas(){const t=this.space;if(t===void 0)return;const o=[NaN,NaN,NaN];if(t.names.forEach((e,n)=>{const s=["x","y","z"].indexOf(e);s!==-1&&(o[s]=t.units[n]==="m"?t.position[n]*t.scales[n]*1e3:t.position[n]*t.scales[n])}),!!o.every(Number.isFinite))return this.move===void 0?o:B(N(this.move),o)}move;candidates(){return this.ctx.viewer.layers().filter(t=>t.type==="image"&&ye(t.sources[0])!==void 0)}probe(t){let o=this.probed.get(t);return o===void 0&&(o=(async()=>{let e=await fetch(`${t}zarr.json`);if(e.ok||(e=await fetch(`${t}.zattrs`)),!e.ok)return!1;const{spatialGroup:n}=await Ke(async()=>{const{spatialGroup:s}=await import("./ome4-WeV0h9cN.js");return{spatialGroup:s}},[],import.meta.url);return n(await e.json()),!0})().catch(()=>!1),this.probed.set(t,o)),o}chosen;target(){const t=this.candidates(),o=t.find(n=>n.name===this.saved.layer);if(o!==void 0)return o;const e=t.find(n=>n.name===this.chosen);if(e!==void 0)return e;(async()=>{for(const n of t)if(await this.probe(ye(n.sources[0]))){this.chosen!==n.name&&(this.chosen=n.name,this.update());return}})()}updating=!1;update(){if(!this.updating){this.updating=!0;try{this.updateNow()}finally{this.updating=!1}}}updateNow(){const t=this.saved.on?this.target():void 0;if(!this.saved.on||t===void 0){this.handle?.dispose(),this.handle=void 0,this.handleLayer=void 0,this.clearSlots(),this.glyphOverlay?.draw([],1),this.drawn="",this.panelUpdate?.();return}this.overlay===void 0&&(this.overlay=this.ctx.ui.overlay(),this.glyphOverlay=new $t(this.overlay.element));const o=ye(t.sources[0]);o!==this.store&&!(o===this.failed?.url&&Date.now()<this.failed.until)&&(this.store=o,this.failed=void 0,this.opened=void 0,this.openError=void 0,this.clearSlots(),this.open(o)),this.handleLayer!==t.name&&(this.handle?.dispose(),this.handleLayer=t.name,this.handle=this.ctx.viewer.draw3d(t.name,{draw:e=>this.draw3d(e),dispose:()=>{this.renderer3d?.dispose(),this.renderer3d=void 0}})),this.schedule(),this.panelUpdate?.()}clearSlots(){for(const t of this.slots.values())t.pending?.controller.abort();this.slots.clear()}async open(t){this.client??=new tt;try{let o=await this.client.open(t);if(this.store!==t)return;if(o.levels.length===0)throw new Error("it has no levels");if(await this.tellStore(t,o)&&(o=await this.client.open(t),this.ctx.viewer.reloadData(t),this.store!==t))return;this.opened=o,this.schedule()}catch(o){this.store===t&&!this.disposed&&(this.openError=`Could not read the image: ${o.message}. Trying again in a few seconds.`,this.store=void 0,this.probed.delete(t),this.failed={url:t,until:Date.now()+5e3},setTimeout(()=>{this.disposed||this.update()},5100))}this.panelUpdate?.()}coarsened;async tellStore(t,o){if(o.nifti===void 0||o.levels.length<2||o.levels[0].components!==6)return!1;const e=this.optionsFor(o,2),n=e.kind==="tensor"?e.tensorOrder:null,s=this.coarsened?.url===t?this.coarsened.tensor:o.nifti.tensorOrder??null;if(n===s)return this.coarsened={url:t,tensor:s},!1;try{const r=await this.ctx.workspace.local.send(t,{tensor:n});return this.coarsened={url:t,tensor:r.tensor},r.changed}catch{return this.coarsened={url:t,tensor:s},!1}}async retellStore(){const t=this.store,o=this.opened;t===void 0||o===void 0||this.client===void 0||!await this.tellStore(t,o)||this.store!==t||(await this.client.open(t),this.store===t&&(this.ctx.viewer.reloadData(t),this.settingsChanged(!1)))}options(t){return this.opened===void 0?void 0:this.optionsFor(this.opened,t)}optionsFor(t,o){const e=t.levels[0],n=Ce(this.saved,t,e.components),s=Ut(this.saved,t),r=Vt(this.saved,t,s,n),a=jt(this.saved,t),c=pt(r==="voxel"?ut(e.voxelToRas):[1,0,0,0,1,0,0,0,1],this.saved.flips);return{kind:n,basis:s,tensorOrder:a,toData:c,normalise:this.saved.normalise,tensorGlyph:this.saved.tensorGlyph,shGlyph:this.saved.shGlyph,subdivisions:o,minAnisotropy:this.saved.minAnisotropy}}schedule(){this.queued||(this.queued=!0,requestAnimationFrame(()=>{this.queued=!1,this.disposed||this.frame()}))}sections(){const t=this.originRas();if(t===void 0)return[];const o=[];for(const e of this.ctx.viewer.panels()){if(e.kind!=="2d")continue;const n=e.element.getBoundingClientRect();if(n.width<2||n.height<2)continue;const s=_t(r=>{const a=this.globalOf(r);return a===void 0?void 0:e.project(a)},t,n.width,n.height);s!==void 0&&o.push({panel:e,section:s})}return o}want2d(t){return Nt(this.opened.levels,t,this.saved)}want3d(){const t=this.opened.levels,o=this.originRas(),e=this.space,n=this.ctx.viewer.panels().find(v=>v.kind==="3d");if(o===void 0||e===void 0||n===void 0)return{note:""};const s=e.scales.filter((v,f)=>e.units[f]==="m"),r=(e.projectionScale??256)*Math.min(...s)*1e3,a=n.element.clientHeight/Math.max(1e-9,r),c=Math.max(2,Math.floor(Math.sqrt(this.saved.maxGlyphs/3)/2));let h=je(t.map(v=>v.voxelSize),a,this.saved.spacing);for(;h<t.length-1&&2*c*t[h].voxelSize*a<.6*n.element.clientHeight;)++h;const l=t[h],d=B(N(l.voxelToRas),o),u=Lt(d,l.size,c);if(u===void 0)return{note:""};const y=`3d|${h}|${u.slabs.map(v=>v.d).join(",")}|${u.box.lo.join(",")}`;return{level:h,box:u.box,visible:u.box,slabs:u.slabs,key:y,subdivisions:2}}frame(t=!1){const o=this.opened;if(this.stats.frames++,!this.saved.on||o===void 0||this.glyphOverlay===void 0){this.drawn!==""&&this.glyphOverlay?.draw([],1),this.drawn="";return}this.channelise();const e=this.ctx.viewer.layers().find(l=>l.name===this.handleLayer)?.visible!==!1,n=this.sections(),s=new Set,r=[],a=this.overlay.element.getBoundingClientRect();for(const{panel:l,section:d}of n){s.add(l.element);let u=this.slots.get(l.element);u===void 0&&this.slots.set(l.element,u={});const y=this.want2d(d);if(this.follow(u,y),this.saved.show2d&&e&&u.shown!==void 0){const v=l.element.getBoundingClientRect(),f=o.levels[u.shown.level].voxelSize;r.push({left:v.left-a.left,top:v.top-a.top,width:v.width,height:v.height,section:d,sets:[{set:u.shown.set,scale:f*this.saved.size/2,depthRange:4*f*Math.max(1,this.saved.size)}]})}}if(n.length===0&&this.saved.show3d){s.add("3d");let l=this.slots.get("3d");l===void 0&&this.slots.set("3d",l={}),this.follow(l,this.want3d())}for(const[l,d]of this.slots)s.has(l)||(d.pending?.controller.abort(),this.slots.delete(l));const c=r.map(l=>[l.left,l.top,l.width,l.height,...l.section.toScreen.map(d=>d.toPrecision(7)),...l.sets.map(d=>`${this.idOf(d.set)}:${d.scale}`)].join(",")).join("|");if(!t&&c===this.drawn)return;this.drawn=c;const h=performance.now();this.glyphOverlay.draw(r,2),this.stats.draws++,this.stats.drawMs+=performance.now()-h}drawn="";ids=new WeakMap;nextId=1;stats={frames:0,draws:0,drawMs:0,reads:0,readMs:0};idOf(t){let o=this.ids.get(t);return o===void 0&&this.ids.set(t,o=this.nextId++),o}follow(t,o){if("note"in o){t.pending?.controller.abort(),t.pending=void 0,o.note!==t.note&&(t.note=o.note,this.panelUpdate?.()),o.note&&(t.shown=void 0);return}t.note=void 0;const e=n=>n!==void 0&&n.key===o.key&&Pt(n.box,o.visible);e(t.shown)||e(t.pending)||(clearTimeout(this.timer),this.timer=setTimeout(()=>this.schedule(),120),!(t.pending!==void 0&&t.pending.key===o.key)&&(this.settling(t,o)||this.read(t,o)))}wanted=new WeakMap;settling(t,o){const e=performance.now(),n=this.wanted.get(t),s=`${o.key}|${o.visible.lo.join(",")}|${o.visible.hi.join(",")}`;return n===void 0||n.key!==s?(this.wanted.set(t,{key:s,since:e}),!0):e-n.since<100}read(t,o){const e=this.client,n=this.options(o.subdivisions);if(e===void 0||n===void 0)return;t.pending?.controller.abort();const s=new AbortController;t.pending={key:o.key,box:o.box,level:o.level,controller:s},this.panelUpdate?.();const r=performance.now();e.glyphs(o.level,{lo:o.box.lo,hi:o.box.hi,slabs:o.slabs},n,s.signal).then(({set:a})=>{t.pending?.controller===s&&(t.pending=void 0,t.shown={set:a,level:o.level,box:o.box,key:o.key},this.stats.reads++,this.stats.readMs+=performance.now()-r,this.schedule(),this.handle?.redraw(),this.panelUpdate?.())},a=>{s.signal.aborted||t.pending?.controller!==s||(t.pending=void 0,t.note=`Could not read glyphs: ${a.message}`,this.panelUpdate?.())})}cursorTimer;cursorRead;cursorLine;readCursor(){const t=this.opened,o=this.client,e=this.ctx.viewer.cursor(),n=this.space;if(!this.saved.on||t===void 0||o===void 0||n===void 0||!e.active)return;const s=[NaN,NaN,NaN];if(e.names.forEach((u,y)=>{const v=["x","y","z"].indexOf(u),f=n.names.indexOf(u);v===-1||f===-1||(s[v]=n.units[f]==="m"?e.position[y]*n.scales[f]*1e3:e.position[y]*n.scales[f])}),!s.every(Number.isFinite))return;const r=this.move===void 0?s:B(N(this.move),s),a=t.levels[0],c=B(N(a.voxelToRas),r).map(Math.round),h=c.every((u,y)=>u>=0&&u<a.size[y]);if(this.cursorRead?.abort(),!h){this.setCursorLine(void 0);return}const l=this.cursorRead=new AbortController,d=this.options(2);o.values(0,{lo:c,hi:c.map(u=>u+1)},l.signal).then(u=>{l.signal.aborted||u.count===0||this.setCursorLine(`Voxel ${c.join(", ")} (${se(a.voxelSize)}): ${Et(u.values,a.components,d)}`)},()=>{})}setCursorLine(t){t!==this.cursorLine&&(this.cursorLine=t,this.panelUpdate?.())}draw3d(t){if(!this.saved.on||!this.saved.show3d||this.opened===void 0)return;const o=qt(t.dimensions);if(o===void 0)return;const{gl:e}=t;this.renderer3d?.gl!==e&&(this.renderer3d?.dispose(),this.renderer3d=new Ue(e,t.outputs));const n=t.viewProjection,s=new Float32Array(16),r=this.move;for(let p=0;p<4;++p)for(let m=0;m<4;++m){let x=0;for(let g=0;g<4;++g)x+=o[4*g+m]*(r===void 0?g===p?1:0:r[4*g+p]);s[4*p+m]=x}const a=new Float32Array(16);for(let p=0;p<4;++p)for(let m=0;m<4;++m){let x=0;for(let g=0;g<4;++g)x+=n[4*g+m]*s[4*p+g];a[4*p+m]=x}const c=t.invViewProjection,h=p=>{const m=c[11]*p+c[15];return[0,1,2].map(x=>(c[8+x]*p+c[12+x])/m)},l=h(-1),d=h(1);let u=[0,0,0];for(let p=0;p<3;++p)for(let m=0;m<3;++m)o[4*m+p]!==0&&(u[m]=(d[p]-l[p])/o[4*m+p]);if(r!==void 0){const p=N(r);u=[0,1,2].map(m=>p[4*m]*u[0]+p[4*m+1]*u[1]+p[4*m+2]*u[2])}const y=Math.hypot(u[0],u[1],u[2])||1,v=u.map(p=>p/y);e.enable(e.DEPTH_TEST),e.depthFunc(e.LESS);const f=[];for(const p of this.slots.values()){const m=p.shown;if(m===void 0)continue;const g=this.opened.levels[m.level].voxelSize*this.saved.size/2;f.push(m.set),this.renderer3d.draw(m.set,{matrix:a,viewDir:v,scale:g,viewport:[t.width,t.height],lineWidth:2,lift:g*1.05})}this.renderer3d.keepOnly(f)}paintScreenshot(t,o){if(!this.saved.on||!this.saved.show2d||this.glyphOverlay===void 0||this.overlay===void 0)return;this.frame(!0);const e=this.glyphOverlay.canvas,n=o.getBoundingClientRect(),s=o.width/Math.max(1,n.width),r=this.overlay.element.getBoundingClientRect();t.drawImage(e,(r.left-n.left)*s,(r.top-n.top)*s,r.width*s,r.height*s)}applyDirectionColour(){const t=this.opened,o=this.target();if(t===void 0||o===void 0){this.ctx.ui.toast("Open an image with orientations first.");return}const e=this.options(2),n=Dt(e,t.levels[0].components);if(n===void 0){this.ctx.ui.toast("Direction colour needs vectors, tensors or spherical harmonics.");return}const s=t.levels[0];if(s.componentChunk<s.components){this.ctx.ui.toast(`Can't colour by direction: this image splits each voxel's ${s.components} components over chunks of ${s.componentChunk}. Write it as OME-Zarr with whole channel chunks (see the README).`,"error");return}const r=this.channelEdit(o.name,"^");if(r==="loading"){this.ctx.ui.toast("The image's layer has not loaded yet; try again in a moment.");return}this.ctx.viewer.patchState(a=>{const c=(a.layers??[]).find(h=>h.name===o.name);c!==void 0&&(c.shader=n,r?.(c))})}channelEdit(t,o){const e=this.ctx.viewer.layerTransform(t),n=this.opened?.componentAxis,s=e?.output.names??[],r=s.find(a=>a===`${n}'`||a===n||a===`${n}^`);if(e===void 0||n===void 0||r===void 0)return"loading";if(!(r===`${n}${o}`||r===`${n}^`))return a=>{const c=typeof a.source=="string"?{url:a.source}:{...a.source},h={};s.forEach((l,d)=>h[l===r?`${n}${o}`:l]=[e.output.scales[d],e.output.units[d]]),c.transform={...c.transform??{},outputDimensions:h},a.source=c,delete a.localDimensions,delete a.localPosition}}channelised;channelise(){const t=this.opened,o=this.handleLayer;if(t===void 0||o===void 0||this.channelised===this.store)return;if(!(this.space?.names??[]).includes(t.componentAxis)){this.channelised=this.store;return}const e=this.channelEdit(o,"'");e!=="loading"&&(this.channelised=this.store,e!==void 0&&this.ctx.viewer.patchState(n=>{const s=(n.layers??[]).find(r=>r.name===o);s!==void 0&&e(s)},{quiet:!0}))}describe(){const t=[],o=this.opened;if(o===void 0)return t;const e=o.levels[0],n=this.options(2),s=n.kind==="sh"?`spherical harmonics, order ${U(e.components)} (${e.components} coefficients), ${xe.find(([c])=>c===n.basis)?.[1]}`:n.kind==="tensor"?`tensors, ${we.find(([c])=>c===n.tensorOrder)?.[1]}`:n.kind==="vector"?"vectors":`peaks (${Math.floor(e.components/3)} per voxel)`;t.push(`${o.name}: ${s}; ${o.levels.length} level${o.levels.length===1?"":"s"}, ${o.levels.map(c=>se(c.voxelSize)).join(", ")}.`);const r=this.coarsened;o.nifti!==void 0&&o.levels.length>1&&r!==void 0&&r.url===this.store&&t.push(r.tensor!==null?"Coarser levels: log-Euclidean means of the tensors (made by the app).":"Coarser levels: means of each component (made by the app).");let a=0;for(const[c,h]of this.slots){a++;const l=c==="3d"?"3-D view":`View ${a}`,d=h.shown,u=[];d&&u.push(`${d.set.count} glyphs at ${se(o.levels[d.level].voxelSize)}`),h.pending&&u.push(`reading ${se(o.levels[h.pending.level].voxelSize)}…`),h.note&&u.push(h.note),u.length>0&&t.push(`${l}: ${u.join("; ")}`)}return t}render(t){const o=()=>{const{saved:e}=this,n=this.candidates(),s=e.on?this.target():n.find(f=>f.name===e.layer)??n.find(f=>f.name===this.chosen)??n[0],r=(f,p,m,x,g=!1)=>{const w=b("select",{class:"text-input","aria-label":f});for(const[$,M]of m)w.append(b("option",{value:$},M));return w.value=p,w.disabled=g,w.addEventListener("change",()=>x(w.value)),b("label",{class:"field"},b("span",{},f),w)},a=(f,p,m,x)=>{const g=b("input",{type:"checkbox"});return g.checked=p,g.addEventListener("change",()=>m(g.checked)),b("label",{class:"field check",title:x},g,b("span",{},f))},c=(f,p,m,x,g,w,$)=>{const M=b("input",{type:"range",min:String(m),max:String(x),step:String(g),value:String(p),"aria-label":f}),z=b("span",{class:"type"},w(p));return M.addEventListener("input",()=>z.textContent=w(Number(M.value))),M.addEventListener("change",()=>$(Number(M.value))),b("label",{class:"field"},b("span",{},f),b("div",{class:"or-row"},M,z))},h=b("input",{type:"checkbox","aria-label":"Orientation glyphs"});h.checked=e.on,h.addEventListener("change",()=>this.set({on:h.checked}));const l=this.opened?.levels[0].components,d=this.opened?Ce(e,this.opened,l):void 0,u=b("div",{class:"or-flips"},...[0,1,2].map(f=>a(`Flip ${"xyz"[f]}`,e.flips[f],p=>{const m=[...e.flips];m[f]=p,this.set({flips:m})}))),y=e.on&&n.length>0&&this.target()===void 0?"None of these images has a component axis (c) to draw as glyphs.":void 0,v=[this.openError,y,this.glyphOverlay?.problem,...this.describe(),this.cursorLine].filter(f=>!!f);if(n.length===0){t.replaceChildren(b("div",{class:"or-panel"},b("label",{class:"or-row"},b("span",{class:"or-label"},"Orientation glyphs"),h),b("p",{class:"note"},"Add an image of orientations (ODFs, tensors or peaks): an OME-Zarr or 4-D NIfTI with a component axis.")));return}t.replaceChildren(b("div",{class:"or-panel"},b("label",{class:"or-row",title:"ODFs, tensors and peaks over an image with a component axis. Also Glyphs beside Sections in the 3-D view."},b("span",{class:"or-label"},"Orientation glyphs"),h),r("Image",s?.name??"",n.map(f=>[f.name,f.name]),f=>this.set({layer:f}),n.length<2),r("Data",e.kind,[["auto",`Automatic${d&&e.kind==="auto"?` (${d==="sh"?"spherical harmonics":d})`:""}`],["sh","Spherical harmonics (ODF)"],["tensor","Diffusion tensor (6)"],["vector","Vector (3)"],["peaks","Peaks (3 per peak)"]],f=>this.set({kind:f})),d==="sh"||e.kind==="auto"?r("SH basis",e.basis,[["auto","Automatic (the store's, else DIPY's)"],...xe],f=>this.set({basis:f})):null,d==="sh"?r("SH glyph",e.shGlyph,[["odf","ODF shape"],["peaks","Peaks (up to 3)"]],f=>this.set({shGlyph:f})):null,d==="tensor"?r("Tensor order",e.tensorOrder,[["auto","Automatic (the store's, else FSL's)"],...we],f=>this.set({tensorOrder:f})):null,d==="tensor"?r("Tensor glyph",e.tensorGlyph,[["ellipsoid","Ellipsoid"],["line","Principal direction"]],f=>this.set({tensorGlyph:f})):null,r("Frame",e.frame,[["auto","Automatic"],["voxel","Voxel axes (DIPY, FSL)"],["world","World x, y, z (MRtrix)"]],f=>this.set({frame:f})),u,r("Normalise",e.normalise,[["minmax","Min–max per voxel (FURY)"],["max","Maximum per voxel"],["none","Across the view (sizes compare)"]],f=>this.set({normalise:f})),c("Size",e.size,.2,3,.05,f=>`${f.toFixed(2)} voxel`,f=>this.set({size:f})),c("Spacing",e.spacing,4,80,1,f=>`${f} px`,f=>this.set({spacing:f})),d==="sh"||d==="tensor"?c("Hide below anisotropy",e.minAnisotropy,0,.9,.01,f=>f>0?`${d==="sh"?"GFA":"FA"} ${f.toFixed(2)}`:"off",f=>this.set({minAnisotropy:f})):null,c("Most glyphs per view",e.maxGlyphs,500,3e4,500,f=>String(f),f=>this.set({maxGlyphs:f})),b("div",{class:"or-flips"},a("2-D views",e.show2d,f=>this.set({show2d:f})),a("3-D view",e.show3d,f=>this.set({show3d:f}))),b("button",{class:"btn outline small",type:"button",title:"Set the image layer's shader to show the principal direction as colour, weighted by anisotropy",onclick:()=>this.applyDirectionColour()},"Colour image by direction"),v.length?b("div",{class:"note or-status"},...v.map(f=>b("div",{},f))):null))};return this.panelUpdate=o,o(),()=>{this.panelUpdate===o&&(this.panelUpdate=void 0)}}dispose(){this.disposed=!0,this.cursorRead?.abort(),this.offs.forEach(t=>t()),this.clearSlots(),this.handle?.dispose(),this.toggle.dispose(),this.glyphOverlay?.dispose(),this.overlay?.dispose(),this.client?.dispose()}}function qt(i){const t=new Float32Array(16);t[15]=1;for(let o=0;o<3;++o){const e=["x","y","z"].indexOf(i.names[o]);if(e===-1)return;const n=i.units[o]==="m"?.001/i.scales[o]:1/i.scales[o];t[4*e+o]=n}return t}const Wt=`
.or-panel { display: grid; gap: 10px; }
.or-row { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.or-row input[type="range"] { flex: 1; }
.or-label { font-weight: 600; }
.or-flips { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.or-status { display: grid; gap: 2px; }
`;let ie;const Qt={activate(i){const t=b("style",{},Wt);document.head.append(t),ie=new Gt(i);const o=ie;i.subscriptions.push(()=>t.remove()),i.subscriptions.push(()=>{o.dispose(),ie===o&&(ie=void 0)}),i.ui.panel(et,e=>o.render(e)),i.services.provide("orientations.status",{lines:()=>o.describe(),stats:o.stats}),i.commands.register("orientations.toggle",()=>{const e=be(i.state.get());i.state.set({...e,on:!e.on})})}};export{Qt as plugin,be as readSaved,Ut as resolveBasis,Vt as resolveFrame,Ce as resolveKind,jt as resolveTensorOrder};
