import{a as lt,_ as ct}from"./manifest-BgncpzkO.js";import{d as ht,j as dt,t as ft,m as G,e as F,f as E,c as be,p as pe,r as ut,n as pt,a as ve,g as Oe}from"./dom-SP1g9eJL.js";import{m as me}from"./format-CobcTlGJ.js";import{o as Me,g as Ce}from"./sources-CfxaY8yx.js";import{W as vt}from"./worker_rpc-BGQIcfWl.js";function mt(n,e,o){const t=Math.max(Math.abs(n[0]),Math.abs(n[1]),Math.abs(n[2]),Math.abs(n[3]),Math.abs(n[4]),Math.abs(n[5]));if(!(t>0)||!Number.isFinite(t)){e[0]=e[1]=e[2]=t===0?0:NaN,o.fill(0),o[0]=o[4]=o[8]=1;return}const s=n[0]/t,i=n[1]/t,a=n[2]/t,r=n[3]/t,l=n[4]/t,h=n[5]/t,c=(s+r+h)/3,d=s-c,f=r-c,v=h-c,p=i*i+a*a+l*l,g=Math.sqrt((d*d+f*f+v*v+2*p)/6);if(g<1e-12){e[0]=e[1]=e[2]=c*t,o.fill(0),o[0]=o[4]=o[8]=1;return}const u=d*(f*v-l*l)-i*(i*v-l*a)+a*(i*l-f*a),m=Math.max(-1,Math.min(1,u/(2*g*g*g))),x=Math.acos(m)/3,w=c+2*g*Math.cos(x),b=c+2*g*Math.cos(x+2*Math.PI/3),$=3*c-w-b,z=w-$>=$-b,O=z?w:b,U=s-O,V=i,B=a,j=i,q=r-O,W=l,X=a,L=l,Y=h-O,H=V*W-B*q,y=B*j-U*W,S=U*q-V*j,C=V*Y-B*L,ce=B*X-U*Y,D=U*L-V*X,ee=q*Y-W*L,te=W*X-j*Y,Q=j*L-q*X,N=H*H+y*y+S*S,M=C*C+ce*ce+D*D,oe=ee*ee+te*te+Q*Q;let k=1,R=0,T=0;if(N>=M&&N>=oe&&N>0){const A=1/Math.sqrt(N);k=H*A,R=y*A,T=S*A}else if(M>=oe&&M>0){const A=1/Math.sqrt(M);k=C*A,R=ce*A,T=D*A}else if(oe>0){const A=1/Math.sqrt(oe);k=ee*A,R=te*A,T=Q*A}let P=0,I=0,_=0;if(Math.abs(k)>Math.abs(R)){const A=1/Math.sqrt(k*k+T*T);P=-T*A,_=k*A}else{const A=1/Math.sqrt(R*R+T*T);I=T*A,_=-R*A}const J=R*_-T*I,K=T*P-k*_,Z=k*I-R*P,ke=s*P+i*I+a*_,Re=i*P+r*I+l*_,ze=a*P+l*I+h*_,Ee=P*ke+I*Re+_*ze,xe=J*ke+K*Re+Z*ze,$e=J*(s*J+i*K+a*Z)+K*(i*J+r*K+l*Z)+Z*(a*J+l*K+h*Z),Ze=k*(s*k+i*R+a*T)+R*(i*k+r*R+l*T)+T*(a*k+l*R+h*T),we=(Ee-$e)/2,De=Math.sqrt(we*we+xe*xe),_e=(Ee+$e)/2,Fe=.5*Math.atan2(xe,we),se=Math.cos(Fe),ie=Math.sin(Fe),et=(_e+De)*t,tt=(_e-De)*t,ot=se*P+ie*J,st=se*I+ie*K,it=se*_+ie*Z,nt=-ie*P+se*J,rt=-ie*I+se*K,at=-ie*_+se*Z,de=z?0:6,fe=z?3:0,ue=z?6:3;e[de/3]=Ze*t,e[fe/3]=et,e[ue/3]=tt,o[de]=k,o[de+1]=R,o[de+2]=T,o[fe]=ot,o[fe+1]=st,o[fe+2]=it,o[ue]=nt,o[ue+1]=rt,o[ue+2]=at}class yt{rpc=new vt(()=>new Worker(new URL(""+new URL("worker-DLVlTs_r.js",import.meta.url).href,import.meta.url),{type:"module",name:"orientations"}),{stopped:e=>`the orientation reader stopped: ${e}. Reload the page to try again`});request(e,o){return this.rpc.request(e,{signal:o})}open(e){return this.request({type:"open",url:e})}glyphs(e,o,t,s){return this.request({type:"glyphs",level:e,request:o,options:t},s)}values(e,o,t){return this.request({type:"values",level:e,request:o},t)}dispose(){this.rpc.dispose()}}const Ve=[["descoteaux07-legacy","descoteaux07 (DIPY's default, legacy)"],["descoteaux07","descoteaux07 (DIPY, legacy=False)"],["tournier07","tournier07 (MRtrix3)"],["tournier07-legacy","tournier07 legacy (MRtrix 0.2)"]];function Be(n){return(n+1)*(n+2)/2}function he(n){for(let e=0;e<=20;e+=2)if(Be(e)===n)return e}function je(n){const e=[];for(let o=0;o<=n;o+=2)for(let t=-o;t<=o;++t)e.push({l:o,m:t||0});return e}function gt(n,e){const o=n+1,t=new Float64Array(o*o),s=Math.sqrt(Math.max(0,1-e*e));let i=1;for(let a=0;a<=n;++a){a>0&&(i*=-(2*a-1)*s),t[a*o+a]=i,a+1<=n&&(t[(a+1)*o+a]=e*(2*a+1)*i);for(let r=a+2;r<=n;++r)t[r*o+a]=((2*r-1)*e*t[(r-1)*o+a]-(r+a-1)*t[(r-2)*o+a])/(r-a)}return t}function xt(n,e){let o=1;for(let t=n-e+1;t<=n+e;++t)o/=t;return Math.sqrt((2*n+1)/(4*Math.PI)*o)}function qe(n,e,o){const t=Be(e),s=Math.floor(o.length/3),i=new Float32Array(s*t),a=e+1,r=new Float64Array(a*a);for(let h=0;h<=e;++h)for(let c=0;c<=h;++c)r[h*a+c]=xt(h,c);const l=je(e);for(let h=0;h<s;++h){const c=o[3*h],d=o[3*h+1],f=o[3*h+2],v=Math.hypot(c,d,f)||1,p=Math.max(-1,Math.min(1,f/v)),g=Math.atan2(d,c),u=gt(e,p);for(let m=0;m<t;++m){const{l:x,m:w}=l[m],b=Math.abs(w),$=r[x*a+b]*u[x*a+b];let z;if(w===0)z=$;else if(n==="descoteaux07-legacy")z=Math.SQRT2*$*(w<0?Math.cos(b*g):Math.sin(b*g));else if(n==="descoteaux07")z=Math.SQRT2*$*(w<0?(b%2===1?-1:1)*Math.cos(b*g):Math.sin(b*g));else{const O=w<0?Math.sin(b*g):Math.cos(b*g);z=n==="tournier07"?Math.SQRT2*$*O:$*O}i[h*t+m]=z}}return i}function wt(n,e,o,t,s){const i=s.length;for(let a=0;a<i;++a){let r=0;const l=a*e;for(let h=0;h<e;++h)r+=n[l+h]*o[t+h];s[a]=r}return s}function bt(n,e,o,t){const s=n[e];let i=s*s;const a=t==="tournier07-legacy"?2:1,r=je(he(o)??0);for(let l=1;l<o;++l){const h=n[e+l];i+=(r[l].m===0?1:a)*h*h}return i>0?Math.sqrt(Math.max(0,1-s*s/i)):0}function Mt(n){const o=qe(n,2,[[1,0,0],[0,1,0],[0,0,1],[Math.SQRT1_2,Math.SQRT1_2,0],[Math.SQRT1_2,0,Math.SQRT1_2],[0,Math.SQRT1_2,Math.SQRT1_2]].flat()),t=[];for(let s=1;s<=5;++s){const i=f=>o[f*6+s],a=i(0),r=i(1),l=i(2),h=i(3)-(a+r)/2,c=i(4)-(a+l)/2,d=i(5)-(r+l)/2;t.push(Float64Array.from([a,h,c,h,r,d,c,d,l]))}return t}const Pe=new Map;function We(n){const e=Pe.get(n);if(e!==void 0)return e;const o=(1+Math.sqrt(5))/2,t=[[-1,o,0],[1,o,0],[-1,-o,0],[1,-o,0],[0,-1,o],[0,1,o],[0,-1,-o],[0,1,-o],[o,0,-1],[o,0,1],[-o,0,-1],[-o,0,1]].map(c=>{const d=Math.hypot(c[0],c[1],c[2]);return c.map(f=>f/d)});let s=[[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];for(let c=0;c<n;++c){const d=new Map,f=(p,g)=>{const u=p<g?`${p},${g}`:`${g},${p}`;let m=d.get(u);if(m===void 0){const x=[0,1,2].map(b=>t[p][b]+t[g][b]),w=Math.hypot(x[0],x[1],x[2]);m=t.push(x.map(b=>b/w))-1,d.set(u,m)}return m},v=[];for(const[p,g,u]of s){const m=f(p,g),x=f(g,u),w=f(u,p);v.push([p,m,w],[g,x,m],[u,w,x],[m,x,w])}s=v}for(const c of s){const[d,f,v]=c.map(m=>t[m]),p=[0,1,2].map(m=>f[m]-d[m]),g=[0,1,2].map(m=>v[m]-d[m]),u=[p[1]*g[2]-p[2]*g[1],p[2]*g[0]-p[0]*g[2],p[0]*g[1]-p[1]*g[0]];u[0]*d[0]+u[1]*d[1]+u[2]*d[2]<0&&([c[1],c[2]]=[c[2],c[1]])}const i=t.length,a=Array.from({length:i},()=>new Map);for(const[c,d,f]of s)a[c].set(d,f),a[d].set(f,c),a[f].set(c,d);const r=new Uint32Array(4*i),l=[];for(let c=0;c<i;++c){const d=[];let f=a[c].keys().next().value;for(;d.length<a[c].size;)d.push(f),f=a[c].get(f);l.push(d);const v=d.length;r[4*c]=d[0],r[4*c+1]=d[Math.round(v/4)],r[4*c+2]=d[Math.round(v/2)],r[4*c+3]=d[Math.round(3*v/4)%v]}const h={vertices:Float32Array.from(t.flat()),faces:Uint32Array.from(s.flat()),around:r,rings:l,count:i};return Pe.set(n,h),h}const Xe=[["fsl","Dxx Dxy Dxz Dyy Dyz Dzz (FSL)"],["dipy","Dxx Dxy Dyy Dxz Dyz Dzz (DIPY)"],["mrtrix","Dxx Dyy Dzz Dxy Dxz Dyz (MRtrix)"]],Ye={fsl:[0,1,2,3,4,5],dipy:[0,1,3,2,4,5],mrtrix:[0,3,4,1,5,2]};function At(n,e,o,t=new Float64Array(9)){const[s,i,a,r,l,h]=Ye[o].map(c=>n[e+c]);return t[0]=s,t[1]=i,t[2]=a,t[3]=i,t[4]=r,t[5]=l,t[6]=a,t[7]=l,t[8]=h,t}function St(n){const e=new Float64Array(3),o=new Float64Array(9);return mt([n[0],n[1],n[2],n[4],n[5],n[8]],e,o),{values:[e[0],e[1],e[2]],vectors:o}}function Tt(n){const[e,o,t]=[n[0],n[1],n[2]],s=e*e+o*o+t*t;return s>0?Math.min(1,Math.sqrt(.5*((e-o)**2+(o-t)**2+(t-e)**2)/s)):0}function kt(n){return(n[0]+n[1]+n[2])/3}function Rt(n,e,o,t){return[n[0]*e+n[1]*o+n[2]*t,n[3]*e+n[4]*o+n[5]*t,n[6]*e+n[7]*o+n[8]*t]}function zt(n){const e=[];for(let o=0;o<3;++o){const t=[n[o],n[4+o],n[8+o]],s=Math.hypot(t[0],t[1],t[2])||1;e.push(t[0]/s,t[1]/s,t[2]/s)}return e}function Et(n,e){return n.map((o,t)=>e[Math.floor(t/3)]?-o:o)}const ye=new Map;function $t(n,e,o,t){const s=`${n}|${e}|${o}|${t.map(a=>a.toFixed(6)).join(",")}`;let i=ye.get(s);if(i===void 0){const{vertices:a,count:r}=We(o),l=new Float32Array(3*r);for(let h=0;h<r;++h)l.set(Rt(t,a[3*h],a[3*h+1],a[3*h+2]),3*h);i=qe(n,e,l),ye.size>16&&ye.clear(),ye.set(s,i)}return i}const Ie=new Map;function Dt(n){let e=Ie.get(n);if(e===void 0){const{vertices:o,count:t}=n;e=new Uint32Array(t);for(let s=0;s<t;++s){let i=0,a=1/0;for(let r=0;r<t;++r){const l=o[3*s]*o[3*r]+o[3*s+1]*o[3*r+1]+o[3*s+2]*o[3*r+2];l<a&&([i,a]=[r,l])}e[s]=i}Ie.set(n,e)}return e}function _t(n,e,o=.5,t=3){const s=Dt(e),i=[];for(let l=0;l<e.count;++l){const h=n[l];h>0&&e.rings[l].every(c=>n[c]<=h)&&i.push({vertex:l,value:h})}i.sort((l,h)=>h.value-l.value);const a=[],r=new Set;for(const l of i){if(a.length>=t||l.value<o*(i[0]?.value??0))break;r.has(l.vertex)||r.has(s[l.vertex])||e.rings[l.vertex].some(h=>r.has(h)||r.has(s[h]))||(r.add(l.vertex),a.push(l))}return a}const Ft=`#version 300 es
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
}`,He=`
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
}`,Ot=`#version 300 es
precision highp float;
${He}
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
}`,Ct=`#version 300 es
precision highp float;
${He}
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
}`,Pt=n=>{const e=(n+1)*(n+2)/2,o=Math.ceil(e/4),t=(r,l)=>l===0?"":` * ${r}${l}`,s=[];let i=0;for(let r=0;r<=n;++r){const l=[];for(let h=0;h<=n-r;++h,++i)l.push(`C[${i>>2}].${"xyzw"[i&3]}${t("x",n-r-h)}${t("y",h)}`);s.push(`  s += (${l.join(" + ")})${t("z",r)};`)}const a=r=>Array.from({length:n},(l,h)=>h===0?`  float ${r}1 = q.${r};`:`  float ${r}${h+1} = ${r}${h} * ${r}1;`).join(`
`);return`
#define TEXELS ${o}
uniform mat3 uToData;
vec4 C[TEXELS];
float odf(vec3 w) {
  vec3 q = uToData * w;
${n>0?[a("x"),a("y"),a("z")].join(`
`):""}
  float s = 0.0;
${s.join(`
`)}
  return s;
}
void loadCoefficients(highp sampler2D coefficients, int glyph, int perRow) {
  ivec2 at = ivec2((glyph % perRow) * TEXELS, glyph / perRow);
  for (int k = 0; k < TEXELS; ++k) C[k] = texelFetch(coefficients, at + ivec2(k, 0), 0);
}`},It=(n,e,o)=>`#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform mat4 uMatrix;
uniform vec3 uViewDir;
uniform float uLift;
uniform float uScale;
uniform sampler2D uCoefficients;
uniform int uPerRow;
${Pt(o)}
flat in vec3 vCentre;
flat in float vBound;
flat in int vGlyph;
flat in float vPxPerUnit;
flat in int vSteps;
in vec4 vPoint;
in vec4 vNear;
in vec4 vFar;
layout(location = ${n.color}) out vec4 out_color;
${n.z!==void 0?`layout(location = ${n.z}) out highp vec4 out_z;`:""}
${n.pick!==void 0?`layout(location = ${n.pick}) out highp vec4 out_pickId;`:""}
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
    ${e?`// Missed: within a pixel of the surface (radially) is the edge, partly covered.
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
  ${n.z!==void 0?"out_z = vec4(1.0 - depth);":""}
  ${n.pick!==void 0?"out_pickId = vec4(0.0);":""}
}`,Lt=(n,e)=>`#version 300 es
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
layout(location = ${n.color}) out vec4 out_color;
${n.z!==void 0?`layout(location = ${n.z}) out highp vec4 out_z;`:""}
${n.pick!==void 0?`layout(location = ${n.pick}) out highp vec4 out_pickId;`:""}
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
  ${e?`float r = sqrt(r2);
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
  ${n.z!==void 0?"out_z = vec4(1.0 - depth);":""}
  ${n.pick!==void 0?"out_pickId = vec4(0.0);":""}
}`;function Nt(n){const e=Array.from(n,Number),o=new Float32Array(16),t=[0,1,2,3].map(s=>[0,1,2,3].map(i=>e[4*i+s]).concat([0,1,2,3].map(i=>i===s?1:0)));for(let s=0;s<4;++s){let i=s;for(let r=s+1;r<4;++r)Math.abs(t[r][s])>Math.abs(t[i][s])&&(i=r);[t[s],t[i]]=[t[i],t[s]];const a=t[s][s]||1e-30;for(let r=0;r<8;++r)t[s][r]/=a;for(let r=0;r<4;++r){if(r===s)continue;const l=t[r][s];if(l!==0)for(let h=0;h<8;++h)t[r][h]-=l*t[s][h]}}for(let s=0;s<4;++s)for(let i=0;i<4;++i)o[4*i+s]=t[s][4+i];return o}const Gt=n=>`#version 300 es
precision highp float;
uniform vec3 uViewDir;
in vec3 vColour;
in vec3 vNormal;
layout(location = ${n.color}) out vec4 out_color;
${n.z!==void 0?`layout(location = ${n.z}) out highp vec4 out_z;`:""}
${n.pick!==void 0?`layout(location = ${n.pick}) out highp vec4 out_pickId;`:""}
void main() {
  vec3 colour = vColour;
  if (dot(vNormal, vNormal) > 0.0) {
    float diffuse = abs(dot(normalize(vNormal), uViewDir));
    colour = vColour * (0.3 + 0.7 * diffuse) + vec3(0.18) * pow(diffuse, 24.0);
  }
  out_color = vec4(colour, 1.0);
  ${n.z!==void 0?"out_z = vec4(1.0 - gl_FragCoord.z);":""}
  ${n.pick!==void 0?"out_pickId = vec4(0.0);":""}
}`;class Se{constructor(e,o){this.gl=e,this.outputs=o,this.maxTexture=e.getParameter(e.MAX_TEXTURE_SIZE)}odfs=new Map;line;ellipsoid;smooth;sets=new WeakMap;made=[];maxTexture;program(e,o=Gt(this.outputs)){const{gl:t}=this,s=(a,r)=>{const l=t.createShader(a);if(t.shaderSource(l,r),t.compileShader(l),!t.getShaderParameter(l,t.COMPILE_STATUS))throw new Error(t.getShaderInfoLog(l)??"shader did not compile");return l},i=t.createProgram();if(t.attachShader(i,s(t.VERTEX_SHADER,e)),t.attachShader(i,s(t.FRAGMENT_SHADER,o)),t.linkProgram(i),!t.getProgramParameter(i,t.LINK_STATUS))throw new Error(t.getProgramInfoLog(i)??"program did not link");return i}nearest(){const{gl:e}=this;e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE)}buffers(e){let o=this.sets.get(e);if(o!==void 0)return o;const{gl:t}=this,s=t.createVertexArray();let i=1,a,r;if(e.shape==="odfs"){t.bindVertexArray(s),a=t.createBuffer(),t.bindBuffer(t.ARRAY_BUFFER,a),t.bufferData(t.ARRAY_BUFFER,e.bounds,t.STATIC_DRAW),t.enableVertexAttribArray(8),t.vertexAttribPointer(8,1,t.FLOAT,!1,0,0),t.vertexAttribDivisor(8,1);const c=(e.lmax+1)*(e.lmax+2)/2,d=Math.ceil(c/4);i=Math.max(1,Math.floor(this.maxTexture/d));const f=Math.max(1,Math.ceil(e.count/i)),v=(Math.min(e.count,i)||1)*d,p=new Float32Array(4*v*f),g=e.coefficients;for(let u=0;u<e.count;++u)p.set(g.subarray(u*c,(u+1)*c),4*(Math.floor(u/i)*v+u%i*d));r=t.createTexture(),t.bindTexture(t.TEXTURE_2D,r),t.pixelStorei(t.UNPACK_ALIGNMENT,4),t.texImage2D(t.TEXTURE_2D,0,t.RGBA32F,v,f,0,t.RGBA,t.FLOAT,p),this.nearest(),t.bindTexture(t.TEXTURE_2D,null)}else if(e.shape==="ellipsoids"){t.bindVertexArray(s),a=t.createBuffer(),t.bindBuffer(t.ARRAY_BUFFER,a),t.bufferData(t.ARRAY_BUFFER,e.axes,t.STATIC_DRAW);for(let c=0;c<3;++c)t.enableVertexAttribArray(5+c),t.vertexAttribPointer(5+c,3,t.FLOAT,!1,36,12*c),t.vertexAttribDivisor(5+c,1)}else t.bindVertexArray(s),a=t.createBuffer(),t.bindBuffer(t.ARRAY_BUFFER,a),t.bufferData(t.ARRAY_BUFFER,e.dirs,t.STATIC_DRAW),t.enableVertexAttribArray(4),t.vertexAttribPointer(4,3,t.FLOAT,!1,0,0),t.vertexAttribDivisor(4,1);const l=t.createBuffer();t.bindBuffer(t.ARRAY_BUFFER,l),t.bufferData(t.ARRAY_BUFFER,e.centres,t.STATIC_DRAW),t.enableVertexAttribArray(2),t.vertexAttribPointer(2,3,t.FLOAT,!1,0,0),t.vertexAttribDivisor(2,1);const h=t.createBuffer();return t.bindBuffer(t.ARRAY_BUFFER,h),t.bufferData(t.ARRAY_BUFFER,e.colours??new Float32Array(3*Math.max(1,e.count)),t.STATIC_DRAW),t.enableVertexAttribArray(3),t.vertexAttribPointer(3,3,t.FLOAT,!1,0,0),t.vertexAttribDivisor(3,1),t.bindVertexArray(null),t.bindBuffer(t.ARRAY_BUFFER,null),o={vao:s,centres:l,colours:h,dirs:a,texture:r,perRow:i},this.sets.set(e,o),this.made.push({set:e,buffers:o}),o}keepOnly(e){const o=new Set(e),{gl:t}=this;this.made=this.made.filter(({set:s,buffers:i})=>o.has(s)?!0:(t.deleteVertexArray(i.vao),t.deleteBuffer(i.centres),t.deleteBuffer(i.colours),i.dirs&&t.deleteBuffer(i.dirs),i.texture&&t.deleteTexture(i.texture),this.sets.delete(s),!1))}draw(e,o){if(e.count===0)return;const{gl:t}=this,s=this.buffers(e),i=e.shape==="odfs",a=e.shape==="ellipsoids",r=this.smooth??=this.outputs.z===void 0&&t.getParameter(t.SAMPLES)>1;let l;if(i){const c=e.lmax;let d=this.odfs.get(c);d===void 0&&this.odfs.set(c,d=this.program(Ct,It(this.outputs,r,c))),l=d}else a?l=this.ellipsoid??=this.program(Ot,Lt(this.outputs,r)):l=this.line??=this.program(Ft);t.useProgram(l);const h=c=>t.getUniformLocation(l,c);if(t.uniformMatrix4fv(h("uMatrix"),!1,o.matrix),t.uniform3fv(h("uViewDir"),o.viewDir),t.uniform1f(h("uScale"),o.scale),t.uniform1f(h("uLift"),o.lift),t.bindVertexArray(s.vao),i||a){if(t.uniformMatrix4fv(h("uInverse"),!1,Nt(o.matrix)),t.uniform2fv(h("uViewport"),o.viewport),i){const c=e.toData;t.uniformMatrix3fv(h("uToData"),!1,[c[0],c[3],c[6],c[1],c[4],c[7],c[2],c[5],c[8]]),t.uniform1i(h("uPerRow"),s.perRow),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,s.texture),t.uniform1i(h("uCoefficients"),0)}r&&t.enable(t.SAMPLE_ALPHA_TO_COVERAGE),t.drawArraysInstanced(t.TRIANGLES,0,6,e.count),r&&t.disable(t.SAMPLE_ALPHA_TO_COVERAGE),i&&t.bindTexture(t.TEXTURE_2D,null)}else t.uniform2fv(h("uViewport"),o.viewport),t.uniform1f(h("uWidth"),o.lineWidth),t.drawArraysInstanced(t.TRIANGLES,0,6,e.count);t.bindVertexArray(null)}dispose(){const{gl:e}=this;this.keepOnly([]);for(const o of this.odfs.values())e.deleteProgram(o);this.odfs.clear(),this.line&&e.deleteProgram(this.line),this.ellipsoid&&e.deleteProgram(this.ellipsoid),this.line=this.ellipsoid=void 0}}function Ut(n,e){const o=n.toScreen,{width:t,height:s,origin:i}=n,a=Math.hypot(o[8],o[9],o[10])||1,r=o[8]*i[0]+o[9]*i[1]+o[10]*i[2]+o[11],l=[[2/t*o[0],2/t*o[1],2/t*o[2],2/t*o[3]-1],[-2/s*o[4],-2/s*o[5],-2/s*o[6],-2/s*o[7]+1],[o[8]/a/e,o[9]/a/e,o[10]/a/e,(o[11]-r)/a/e],[0,0,0,1]],h=new Float32Array(16);for(let c=0;c<4;++c)for(let d=0;d<4;++d)h[4*d+c]=l[c][d];return h}const Qe="The 2-D glyphs stopped: the browser took back their drawing context.";class Vt{canvas=document.createElement("canvas");gl;renderer;problem;constructor(e,o){if(this.canvas.className="orientations-canvas",this.canvas.style.cssText="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;",e.append(this.canvas),this.gl=this.canvas.getContext("webgl2",{alpha:!0,depth:!0,premultipliedAlpha:!0,antialias:!0,preserveDrawingBuffer:!1}),this.gl===null){this.problem="This browser has no WebGL2 for the 2-D glyphs.";return}this.renderer=new Se(this.gl,{color:0}),this.canvas.addEventListener("webglcontextlost",t=>{t.preventDefault(),this.renderer=void 0,this.problem=Qe,o?.()}),this.canvas.addEventListener("webglcontextrestored",()=>{this.renderer=new Se(this.gl,{color:0}),this.problem=void 0,o?.()})}draw(e,o){const{gl:t,renderer:s,canvas:i}=this;if(t===null||s===void 0)return;const a=window.devicePixelRatio||1,r=Math.max(1,Math.round(i.clientWidth*a)),l=Math.max(1,Math.round(i.clientHeight*a));(i.width!==r||i.height!==l)&&(i.width=r,i.height=l),t.disable(t.SCISSOR_TEST),t.viewport(0,0,r,l),t.clearColor(0,0,0,0),t.clearDepth(1),t.clear(t.COLOR_BUFFER_BIT|t.DEPTH_BUFFER_BIT);const h=[];t.enable(t.SCISSOR_TEST),t.enable(t.DEPTH_TEST),t.depthFunc(t.LESS),t.disable(t.BLEND),t.disable(t.CULL_FACE);for(const c of e){const d=Math.round(c.left*a),f=Math.round(l-(c.top+c.height)*a),v=Math.round(c.width*a),p=Math.round(c.height*a);if(!(v<=0||p<=0)){t.viewport(d,f,v,p),t.scissor(d,f,v,p);for(const{set:g,scale:u,depthRange:m}of c.sets)h.push(g),s.draw(g,{matrix:Ut(c.section,m),viewDir:c.section.normal,scale:u,viewport:[v,p],lineWidth:o*a,lift:0})}}t.disable(t.SCISSOR_TEST),s.keepOnly(h)}dispose(){this.gl?.isContextLost()===!1&&this.renderer?.dispose(),this.canvas.remove()}}const ne=n=>{if(n===0)return"0";const e=Math.abs(n);return e>=.01&&e<1e3?n.toFixed(e>=10?1:3).replace(/\.?0+$/,""):n.toExponential(2)},Ae=n=>`(${Array.from(n,e=>(Math.abs(e)<.005?0:e).toFixed(2)).join(", ")})`;function Le(n,e){return[0,1,2].map(o=>n[o]*e[0]+n[3+o]*e[1]+n[6+o]*e[2])}function Bt(n,e,o){if(Array.from({length:e},(s,i)=>n[i]).every(s=>s===0||s!==s))return"nothing here";if(o.kind==="tensor"&&e===6){const s=St(At(n,0,o.tensorOrder)),i=Le(o.toData,s.vectors.subarray(0,3));return`FA ${ne(Tt(s.values))}, MD ${ne(kt(s.values))}, λ ${s.values.map(ne).join(" / ")}, V1 ${Ae(i)}`}if(o.kind==="sh"){const s=he(e);if(s===void 0)return`${e} components`;const i=We(3),a=wt($t(o.basis,s,3,o.toData),e,n,0,new Float32Array(i.count)),r=_t(a,i),l=r[0]?.value??1,h=r.map(c=>`${Ae(i.vertices.subarray(3*c.vertex,3*c.vertex+3))} ${ne(c.value/l)}`);return`GFA ${ne(bt(n,0,e,o.basis))}; ${r.length===0?"no peaks":`peaks ${h.join(", ")}`}`}const t=[];for(let s=0;s+2<e;s+=3){const i=[n[s],n[s+1],n[s+2]],a=Math.hypot(i[0],i[1],i[2]);if(a>0&&(t.push(`${Ae(Le(o.toData,i.map(r=>r/a)))} × ${ne(a)}`),o.kind==="vector"))break}return t.length===0?"nothing here":t.join(", ")}const jt=n=>{const e=Number(n.toPrecision(7)).toString();return/[.e]/.test(e)?e:`${e}.0`},re=n=>`mat3(${Array.from(n,jt).join(", ")})`,qt=`
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
`;function Wt(n,e){const o=re(n.toData),t=`#uicontrol float brightness slider(min=0.2, max=4, default=1)
// Direction colour (orientations plugin): |x| red, |y| green, |z| blue, weighted by anisotropy.
float component(int i) { return toNormalized(getDataValue(i)); }
${qt}`;if(n.kind==="vector"||n.kind==="peaks")return`${t}
void main() {
  vec3 v = vec3(component(0), component(1), component(2));
  float n = length(v);
  if (!(n > 0.0)) { emitRGB(vec3(0.0)); return; }
  emitRGB(clamp(abs(${o} * (v / n)) * min(n, 1.0) * brightness, 0.0, 1.0));
}
`;if(n.kind==="tensor"){if(e!==6)return;const[r,l,h,c,d,f]=Ye[n.tensorOrder];return`${t}
void main() {
  float xx = component(${r}), xy = component(${l}), xz = component(${h});
  float yy = component(${c}), yz = component(${d}), zz = component(${f});
  mat3 d = mat3(xx, xy, xz, xy, yy, yz, xz, yz, zz);
  float nd = sqrt(dot(d[0], d[0]) + dot(d[1], d[1]) + dot(d[2], d[2]));
  if (!(nd > 0.0)) { emitRGB(vec3(0.0)); return; }
  float t = (xx + yy + zz) / 3.0;
  mat3 a = d - t * mat3(1.0);
  float fa = clamp(sqrt(1.5) * sqrt(dot(a[0], a[0]) + dot(a[1], a[1]) + dot(a[2], a[2])) / nd, 0.0, 1.0);
  emitRGB(clamp(abs(${o} * principal(d)) * fa * brightness, 0.0, 1.0));
}
`}const s=he(e);if(s===void 0||s<2)return;const i=Mt(n.basis),a=n.basis==="tournier07-legacy";return`${t}
void main() {
  float c0 = component(0);
  mat3 q = component(1) * ${re(i[0])}
    + component(2) * ${re(i[1])}
    + component(3) * ${re(i[2])}
    + component(4) * ${re(i[3])}
    + component(5) * ${re(i[4])};
  float total = c0 * c0;
  for (int i = 1; i < ${e}; ++i) { float c = component(i); total += ${a?"2.0 * ":""}c * c; }
  if (!(total > 0.0)) { emitRGB(vec3(0.0)); return; }
  float gfa = sqrt(max(0.0, 1.0 - c0 * c0 / total));
  emitRGB(clamp(abs(${o} * principal(q)) * gfa * brightness, 0.0, 1.0));
}
`}function Xt(n,e,o,t){const s=n(e);if(s===void 0)return;const i=[];for(let u=0;u<3;++u){const m=[...e];m[u]+=1;const x=n(m);if(x===void 0)return;i.push([x.x-s.x,x.y-s.y,x.depth-s.depth])}const a=u=>[i[0][u],i[1][u],i[2][u]],[r,l]=[a(0),a(1)],h=[r[1]*l[2]-r[2]*l[1],r[2]*l[0]-r[0]*l[2],r[0]*l[1]-r[1]*l[0]],c=Math.hypot(h[0],h[1],h[2]),d=Math.sqrt(Math.hypot(r[0],r[1],r[2])*Math.hypot(l[0],l[1],l[2]));if(!(c>0)||!(d>0))return;const f=h.map(u=>u/c),v=f,p=[s.x,s.y,0].map((u,m)=>u-[r,l,v][m].reduce((x,w,b)=>x+w*e[b],0));return{toScreen:[...r,p[0],...l,p[1],...v,p[2]],width:o,height:t,origin:e,normal:f,pxPerMm:d}}function Yt(n,e){const[o,t,s,i,a,r,l,h,c]=n,d=o*(a*c-r*h)-t*(i*c-r*l)+s*(i*h-a*l);if(Math.abs(d)<1e-300)return;const f=[a*c-r*h,s*h-t*c,t*r-s*a,r*l-i*c,o*c-s*l,s*i-o*r,i*h-a*l,t*l-o*h,o*a-t*i].map(v=>v/d);return[0,1,2].map(v=>f[3*v]*e[0]+f[3*v+1]*e[1]+f[3*v+2]*e[2])}function Ht(n,e,o){const t=n.toScreen,s=t[8]*n.origin[0]+t[9]*n.origin[1]+t[10]*n.origin[2]+t[11];return Yt([t[0],t[1],t[2],t[4],t[5],t[6],t[8],t[9],t[10]],[e-t[3],o-t[7],s-t[11]])}function Je(n,e,o){for(let t=0;t<n.length;++t)if(n[t]*e>=o*.98)return t;return n.length-1}function ae(n){const e=Array.from({length:4},(o,t)=>[...Array.from({length:4},(s,i)=>n[4*t+i]),...[0,1,2,3].map(s=>s===t?1:0)]);for(let o=0;o<4;++o){let t=o;for(let i=o+1;i<4;++i)Math.abs(e[i][o])>Math.abs(e[t][o])&&(t=i);[e[o],e[t]]=[e[t],e[o]];const s=e[o][o];if(Math.abs(s)<1e-300)throw new Error("singular transform");for(let i=0;i<8;++i)e[o][i]/=s;for(let i=0;i<4;++i){if(i===o)continue;const a=e[i][o];if(a!==0)for(let r=0;r<8;++r)e[i][r]-=a*e[o][r]}}return e.flatMap(o=>o.slice(4))}function le(n,e){return[0,1,2].map(o=>n[4*o]*e[0]+n[4*o+1]*e[1]+n[4*o+2]*e[2]+n[4*o+3])}function Qt(n,e,o){const t=[0,1,2].map(r=>n[r]*o[0]+n[4+r]*o[1]+n[8+r]*o[2]),s=o.reduce((r,l,h)=>r+l*(e[h]-n[4*h+3]),0),i=Math.hypot(t[0],t[1],t[2])||1,a=t.map(r=>r/i);return{n:a,d:s/i,h:.5*Math.max(...a.map(Math.abs))}}function Ne(n,e,o,t){const s=ae(n),i=[1/0,1/0,1/0],a=[-1/0,-1/0,-1/0];for(const l of o){const h=le(s,l);for(let c=0;c<3;++c)i[c]=Math.min(i[c],h[c]),a[c]=Math.max(a[c],h[c])}const r={lo:[0,0,0],hi:[0,0,0]};for(let l=0;l<3;++l){const h=(a[l]-i[l])*t+1;if(r.lo[l]=Math.max(0,Math.floor(i[l]-h)),r.hi[l]=Math.min(e[l],Math.ceil(a[l]+h)+1),r.hi[l]<=r.lo[l])return}return r}function Jt(n,e){return[0,1,2].every(o=>n.lo[o]<=e.lo[o]&&n.hi[o]>=e.hi[o])}function Kt(n,e){const o=[0,1,2].map(s=>n.hi[s]-n.lo[s]),t=[0,1,2].reduce((s,i)=>Math.abs(e.n[i])>Math.abs(e.n[s])?i:s,0);return o.reduce((s,i)=>s*i,1)/o[t]}function Zt(n,e,o){const t=n.map((a,r)=>Math.max(0,Math.min(e[r]-1,Math.round(a)))),s={lo:t.map(a=>Math.max(0,a-o)),hi:t.map((a,r)=>Math.min(e[r],a+o+1))},i=[0,1,2].map(a=>({n:[0,1,2].map(r=>r===a?1:0),d:t[a],h:.5}));return{box:s,slabs:i}}function eo(n,e,o){const t=[[0,0],[e.width,0],[0,e.height],[e.width,e.height]].map(([s,i])=>Ht(e,s,i));if(t.some(s=>s===void 0))return{note:""};for(let s=Je(n.map(i=>i.voxelSize),e.pxPerMm,o.spacing);s<n.length;++s){const i=n[s],a=Ne(i.voxelToRas,i.size,t,0),r=Ne(i.voxelToRas,i.size,t,.25);if(a===void 0||r===void 0)return{note:""};const l=Qt(i.voxelToRas,e.origin,e.normal);if(Kt(a,l)>o.maxGlyphs)continue;const h=i.voxelSize*e.pxPerMm;if(h<4)return{note:"Zoom in to show glyphs (under 4 pixels apart)"};const c=h*o.size>=40?3:2,d=`${s}|${l.n.map(f=>f.toFixed(4)).join(",")}|${Math.round(l.d*1e3)}|${c}`;return{level:s,box:r,visible:a,slabs:[l],key:d,subdivisions:c}}return{note:`more than ${o.maxGlyphs} glyphs even at the coarsest level: zoom in`}}function to(n){const e=n.rank+1,o=d=>Array.from({length:e},(f,v)=>Array.from({length:e},(p,g)=>d[g*e+v])),t=o(n.matrix),s=o(n.defaultMatrix).map((d,f)=>[...d,...Array.from({length:e},(v,p)=>p===f?1:0)]);for(let d=0;d<e;++d){let f=d;for(let p=d+1;p<e;++p)Math.abs(s[p][d])>Math.abs(s[f][d])&&(f=p);[s[d],s[f]]=[s[f],s[d]];const v=s[d][d];if(Math.abs(v)<1e-300)return;for(let p=0;p<2*e;++p)s[d][p]/=v;for(let p=0;p<e;++p){if(p===d)continue;const g=s[p][d];if(g!==0)for(let u=0;u<2*e;++u)s[p][u]-=g*s[d][u]}}const i=s.map(d=>d.slice(e)),a=t.map(d=>i[0].map((f,v)=>d.reduce((p,g,u)=>p+g*i[u][v],0))),r=["x","y","z"].map(d=>n.output.names.indexOf(d));if(r.includes(-1))return;const l=d=>n.output.units[d]==="m"?n.output.scales[d]*1e3:n.output.scales[d],h=[];for(let d=0;d<3;++d){const f=r[d];for(let v=0;v<3;++v)h.push(a[f][r[v]]*l(f)/l(r[v]));h.push(a[f][e-1]*l(f))}h.push(0,0,0,1);const c=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];return h.every((d,f)=>Math.abs(d-c[f])<1e-9)?void 0:h}const Ke=["sh","tensor","vector","peaks"];function Te(n){const e=n??{},o=(i,a,r)=>a.includes(i)?i:r,t=Array.isArray(e.flips)&&e.flips.length===3?e.flips.map(i=>i===!0):[!1,!1,!1],s=(i,a,r,l)=>typeof i=="number"&&Number.isFinite(i)?Math.min(r,Math.max(a,i)):l;return{on:e.on===!0,layer:typeof e.layer=="string"?e.layer:void 0,kind:o(e.kind,["auto",...Ke],"auto"),basis:o(e.basis,["auto",...Ve.map(([i])=>i)],"auto"),tensorOrder:o(e.tensorOrder,["auto",...Xe.map(([i])=>i)],"auto"),frame:o(e.frame,["auto","voxel","world"],"auto"),flips:t,normalise:o(e.normalise,["minmax","max","none"],"minmax"),tensorGlyph:o(e.tensorGlyph,["ellipsoid","line"],"ellipsoid"),shGlyph:o(e.shGlyph,["odf","peaks"],"odf"),size:s(e.size,.2,3,1),spacing:s(e.spacing,4,200,24),maxGlyphs:s(e.maxGlyphs,100,5e4,8e3),minAnisotropy:s(e.minAnisotropy,0,1,0),show2d:e.show2d!==!1,show3d:e.show3d!==!1}}function Ge(n,e,o){if(n.kind!=="auto")return n.kind;const t=e.metadata?.type;return t!==void 0&&Ke.includes(t)?t:o===3?"vector":o===6?"tensor":he(o)!==void 0?"sh":"peaks"}function oo(n,e){if(n.basis!=="auto")return n.basis;const o=e.metadata,t=String(o?.basis??"").toLowerCase();return t.startsWith("tournier")||t==="mrtrix"||t==="mrtrix3"?o?.legacy===!0?"tournier07-legacy":"tournier07":(t.startsWith("descoteaux")||t==="dipy")&&o?.legacy===!1?"descoteaux07":"descoteaux07-legacy"}function so(n,e){if(n.tensorOrder!=="auto")return n.tensorOrder;const o=String(e.metadata?.order??"");return o==="dipy"||o==="mrtrix"||o==="fsl"?o:e.nifti?.intent===1005?"dipy":"fsl"}function io(n,e,o,t){if(n.frame!=="auto")return n.frame;const s=e.metadata?.frame;return s==="voxel"||s==="world"?s:t==="sh"&&o.startsWith("tournier")?"world":"voxel"}const no=3,ro=2e3;class ao{constructor(e,o=()=>new yt){this.ctx=e,this.makeClient=o,this.saved=Te(e.state.get()),this.toggle=e.ui.viewToggle({label:"Glyphs",title:"Orientation glyphs (ODFs, tensors, peaks) over the image; the Orientations panel has their settings",value:this.saved.on,onChange:t=>this.set({on:t})}),this.offs.push(e.state.onChanged(()=>{const t=Te(e.state.get());JSON.stringify(t)!==JSON.stringify(this.saved)&&(this.saved=t,this.toggle.set(t.on),this.settingsChanged())}),e.viewer.onLayersChanged(()=>this.update()),e.viewer.onStateChanged(()=>{this.readSpace(),this.schedule()}),e.viewer.onRendered(()=>this.schedule()),e.viewer.onCursorChanged(()=>{clearTimeout(this.cursorTimer),this.cursorTimer=setTimeout(()=>this.readCursor(),120)}),()=>clearTimeout(this.cursorTimer),e.ui.screenshotOverlay((t,s)=>this.paintScreenshot(t,s)),()=>clearTimeout(this.timer),()=>clearTimeout(this.retryTimer)),this.readSpace(),this.update()}saved;client;store;opened;openError;failed;retryTimer;disposed=!1;overlay;glyphOverlay;handle;handleLayer;renderer3d;slots=new Map;space;timer;queued=!1;panelUpdate;cursorText;toggle;offs=[];probed=new Map;set(e){this.saved={...this.saved,...e},this.ctx.state.set(this.saved),e.on!==void 0&&this.toggle.set(e.on),this.settingsChanged()}settingsChanged(e=!0){for(const o of this.slots.values())o.pending?.controller.abort(),o.pending=void 0,o.shown&&(o.shown.key="");this.update(),e&&this.retellStore().catch(o=>{this.disposed||(this.openError=`Could not remake the image's coarser levels: ${o.message}`,this.panelUpdate?.())})}readSpace(){const e=this.ctx.viewer.getState(),o=e.dimensions??{},t=Object.keys(o);this.space={names:t,scales:t.map(a=>o[a][0]),units:t.map(a=>o[a][1]),position:e.position??t.map(()=>0),projectionScale:e.projectionScale};const s=this.handleLayer===void 0?void 0:this.ctx.viewer.layerTransform(this.handleLayer),i=s===void 0?void 0:to(s);if(JSON.stringify(i)!==JSON.stringify(this.move)){this.move=i;for(const a of this.slots.values())a.shown&&(a.shown.key="")}}globalOf(e){const o=this.space;if(o===void 0)return;this.move!==void 0&&(e=le(this.move,e));const t=[...o.position];let s=0;return o.names.forEach((i,a)=>{const r=["x","y","z"].indexOf(i);r!==-1&&(s++,t[a]=o.units[a]==="m"?e[r]*.001/o.scales[a]:e[r]/o.scales[a])}),s===3?t:void 0}originRas(){const e=this.space;if(e===void 0)return;const o=[NaN,NaN,NaN];if(e.names.forEach((t,s)=>{const i=["x","y","z"].indexOf(t);i!==-1&&(o[i]=e.units[s]==="m"?e.position[s]*e.scales[s]*1e3:e.position[s]*e.scales[s])}),!!o.every(Number.isFinite))return this.move===void 0?o:le(ae(this.move),o)}move;candidates(){return this.ctx.viewer.layers().filter(e=>e.type==="image"&&Me(e.sources[0])!==void 0)}probe(e){let o=this.probed.get(e);return o===void 0&&(o=(async()=>{let t=await fetch(Ce(`${e}zarr.json`));if(t.ok||(t=await fetch(Ce(`${e}.zattrs`))),!t.ok)return!1;const{spatialGroup:s}=await ct(async()=>{const{spatialGroup:i}=await import("./ome4-CLdHOBnc.js");return{spatialGroup:i}},[],import.meta.url);return s(await t.json()),!0})().catch(()=>!1),this.probed.set(e,o)),o}chosen;target(){const e=this.candidates(),o=e.find(s=>s.name===this.saved.layer);if(o!==void 0)return o;const t=e.find(s=>s.name===this.chosen);if(t!==void 0)return t;(async()=>{for(const s of e)if(await this.probe(Me(s.sources[0]))){this.chosen!==s.name&&(this.chosen=s.name,this.update());return}})()}updating=!1;update(){if(!this.updating){this.updating=!0;try{this.updateNow()}finally{this.updating=!1}}}updateNow(){const e=this.saved.on?this.target():void 0;if(!this.saved.on||e===void 0){this.handle?.dispose(),this.handle=void 0,this.handleLayer=void 0,this.clearSlots(),this.glyphOverlay?.draw([],1),this.drawn="",this.panelUpdate?.();return}this.overlay===void 0&&(this.overlay=this.ctx.ui.overlay(),this.newGlyphOverlay());const o=Me(e.sources[0]);o!==this.store&&!(o===this.failed?.url&&Date.now()<this.failed.until)&&(this.store=o,this.failed?.url!==o&&(this.failed=void 0,this.openError=void 0),this.opened=void 0,this.clearSlots(),this.open(o)),this.handleLayer!==e.name&&(this.handle?.dispose(),this.handleLayer=e.name,this.handle=this.ctx.viewer.draw3d(e.name,{draw:t=>this.draw3d(t),dispose:()=>{this.renderer3d?.dispose(),this.renderer3d=void 0}})),this.schedule(),this.panelUpdate?.()}newGlyphOverlay(){this.overlay!==void 0&&(this.glyphOverlay?.dispose(),this.glyphOverlay=new Vt(this.overlay.element,()=>{this.drawn="",this.schedule(),this.panelUpdate?.()}),this.drawn="",this.schedule(),this.panelUpdate?.())}clearSlots(){for(const e of this.slots.values())e.pending?.controller.abort();this.slots.clear()}async open(e){this.client??=this.makeClient();try{let o=await this.client.open(e);if(this.store!==e)return;if(o.levels.length===0)throw new Error("it has no levels");if(await this.tellStore(e,o)&&(o=await this.client.open(e),this.ctx.viewer.reloadData(e),this.store!==e))return;this.opened=o,this.failed=void 0,this.openError=void 0,this.schedule()}catch(o){if(this.store===e&&!this.disposed){const t=(this.failed?.url===e?this.failed.attempts:0)+1,s=t<no?ro*2**(t-1):1/0;this.openError=`Could not read the image: ${o.message}`,this.store=void 0,this.probed.delete(e),this.failed={url:e,until:Date.now()+s,attempts:t},clearTimeout(this.retryTimer),Number.isFinite(s)&&(this.retryTimer=setTimeout(()=>{this.disposed||this.failed?.url!==e||(this.failed.until=0,this.update())},s))}}this.panelUpdate?.()}retryOpen(){clearTimeout(this.retryTimer),this.failed=void 0,this.openError=void 0,this.store=void 0,this.update()}openState(){if(this.failed!==void 0)return Number.isFinite(this.failed.until)?"retrying":"failed";if(this.saved.on&&this.store!==void 0&&this.opened===void 0)return"reading"}coarsened;async tellStore(e,o){if(o.nifti===void 0||o.levels.length<2||o.levels[0].components!==6)return!1;const t=this.optionsFor(o,2),s=t.kind==="tensor"?t.tensorOrder:null,i=this.coarsened?.url===e?this.coarsened.tensor:o.nifti.tensorOrder??null;if(s===i)return this.coarsened={url:e,tensor:i},!1;try{const a=await this.ctx.workspace.local.send(e,{tensor:s});return this.coarsened={url:e,tensor:a.tensor},a.changed}catch{return this.coarsened={url:e,tensor:i},!1}}async retellStore(){const e=this.store,o=this.opened;e===void 0||o===void 0||this.client===void 0||!await this.tellStore(e,o)||this.store!==e||(await this.client.open(e),this.store===e&&(this.ctx.viewer.reloadData(e),this.settingsChanged(!1)))}options(e){return this.opened===void 0?void 0:this.optionsFor(this.opened,e)}optionsFor(e,o){const t=e.levels[0],s=Ge(this.saved,e,t.components),i=oo(this.saved,e),a=io(this.saved,e,i,s),r=so(this.saved,e),l=Et(a==="voxel"?zt(t.voxelToRas):[1,0,0,0,1,0,0,0,1],this.saved.flips);return{kind:s,basis:i,tensorOrder:r,toData:l,normalise:this.saved.normalise,tensorGlyph:this.saved.tensorGlyph,shGlyph:this.saved.shGlyph,subdivisions:o,minAnisotropy:this.saved.minAnisotropy}}schedule(){this.queued||(this.queued=!0,requestAnimationFrame(()=>{this.queued=!1,this.disposed||this.frame()}))}sections(){const e=this.originRas();if(e===void 0)return[];const o=[];for(const t of this.ctx.viewer.panels()){if(t.kind!=="2d")continue;const s=t.element.getBoundingClientRect();if(s.width<2||s.height<2)continue;const i=Xt(a=>{const r=this.globalOf(a);return r===void 0?void 0:t.project(r)},e,s.width,s.height);i!==void 0&&o.push({panel:t,section:i})}return o}want2d(e){return eo(this.opened.levels,e,this.saved)}want3d(){const e=this.opened.levels,o=this.originRas(),t=this.space,s=this.ctx.viewer.panels().find(p=>p.kind==="3d");if(o===void 0||t===void 0||s===void 0)return{note:""};const i=t.scales.filter((p,g)=>t.units[g]==="m"),a=(t.projectionScale??256)*Math.min(...i)*1e3,r=s.element.clientHeight/Math.max(1e-9,a),l=Math.max(2,Math.floor(Math.sqrt(this.saved.maxGlyphs/3)/2));let h=Je(e.map(p=>p.voxelSize),r,this.saved.spacing);for(;h<e.length-1&&2*l*e[h].voxelSize*r<.6*s.element.clientHeight;)++h;const c=e[h],d=le(ae(c.voxelToRas),o),f=Zt(d,c.size,l);if(f===void 0)return{note:""};const v=`3d|${h}|${f.slabs.map(p=>p.d).join(",")}|${f.box.lo.join(",")}`;return{level:h,box:f.box,visible:f.box,slabs:f.slabs,key:v,subdivisions:2}}frame(e=!1){const o=this.opened;if(this.stats.frames++,!this.saved.on||o===void 0||this.glyphOverlay===void 0){this.drawn!==""&&this.glyphOverlay?.draw([],1),this.drawn="";return}this.channelise();const t=this.ctx.viewer.layers().find(c=>c.name===this.handleLayer)?.visible!==!1,s=this.sections(),i=new Set,a=[],r=this.overlay.element.getBoundingClientRect();for(const{panel:c,section:d}of s){i.add(c.element);let f=this.slots.get(c.element);f===void 0&&this.slots.set(c.element,f={});const v=this.want2d(d);if(this.follow(f,v),this.saved.show2d&&t&&f.shown!==void 0){const p=c.element.getBoundingClientRect(),g=o.levels[f.shown.level].voxelSize;a.push({left:p.left-r.left,top:p.top-r.top,width:p.width,height:p.height,section:d,sets:[{set:f.shown.set,scale:g*this.saved.size/2,depthRange:4*g*Math.max(1,this.saved.size)}]})}}if(s.length===0&&this.saved.show3d){i.add("3d");let c=this.slots.get("3d");c===void 0&&this.slots.set("3d",c={}),this.follow(c,this.want3d())}for(const[c,d]of this.slots)i.has(c)||(d.pending?.controller.abort(),this.slots.delete(c));const l=a.map(c=>[c.left,c.top,c.width,c.height,...c.section.toScreen.map(d=>d.toPrecision(7)),...c.sets.map(d=>`${this.idOf(d.set)}:${d.scale}`)].join(",")).join("|");if(!e&&l===this.drawn)return;this.drawn=l;const h=performance.now();this.glyphOverlay.draw(a,2),this.stats.draws++,this.stats.drawMs+=performance.now()-h}drawn="";ids=new WeakMap;nextId=1;stats={frames:0,draws:0,drawMs:0,reads:0,readMs:0};idOf(e){let o=this.ids.get(e);return o===void 0&&this.ids.set(e,o=this.nextId++),o}follow(e,o){if("note"in o){e.pending?.controller.abort(),e.pending=void 0,(o.note||void 0)!==e.note&&(e.note=o.note||void 0,this.panelUpdate?.()),o.note&&(e.shown=void 0);return}e.note!==void 0&&(e.note=void 0,this.panelUpdate?.());const t=s=>s!==void 0&&s.key===o.key&&Jt(s.box,o.visible);t(e.shown)||t(e.pending)||e.error?.key!==o.key&&(clearTimeout(this.timer),this.timer=setTimeout(()=>this.schedule(),120),!(e.pending!==void 0&&e.pending.key===o.key)&&(this.settling(e,o)||this.read(e,o)))}wanted=new WeakMap;settling(e,o){const t=performance.now(),s=this.wanted.get(e),i=`${o.key}|${o.visible.lo.join(",")}|${o.visible.hi.join(",")}`;return s===void 0||s.key!==i?(this.wanted.set(e,{key:i,since:t}),!0):t-s.since<100}read(e,o){const t=this.client,s=this.options(o.subdivisions);if(t===void 0||s===void 0)return;e.pending?.controller.abort();const i=new AbortController;e.pending={key:o.key,box:o.box,level:o.level,controller:i};const a=performance.now();t.glyphs(o.level,{lo:o.box.lo,hi:o.box.hi,slabs:o.slabs},s,i.signal).then(({set:r})=>{e.pending?.controller===i&&(e.pending=void 0,e.shown={set:r,level:o.level,box:o.box,key:o.key},this.stats.reads++,this.stats.readMs+=performance.now()-a,this.schedule(),this.handle?.redraw(),e.error!==void 0&&(e.error=void 0,this.panelUpdate?.()))},r=>{i.signal.aborted||e.pending?.controller!==i||(e.pending=void 0,e.error={message:r.message,key:o.key},this.panelUpdate?.())})}cursorTimer;cursorRead;cursorLine;readCursor(){const e=this.opened,o=this.client,t=this.ctx.viewer.cursor(),s=this.space;if(!this.saved.on||e===void 0||o===void 0||s===void 0||!t.active)return;const i=[NaN,NaN,NaN];if(t.names.forEach((f,v)=>{const p=["x","y","z"].indexOf(f),g=s.names.indexOf(f);p===-1||g===-1||(i[p]=s.units[g]==="m"?t.position[v]*s.scales[g]*1e3:t.position[v]*s.scales[g])}),!i.every(Number.isFinite))return;const a=this.move===void 0?i:le(ae(this.move),i),r=e.levels[0],l=le(ae(r.voxelToRas),a).map(Math.round),h=l.every((f,v)=>f>=0&&f<r.size[v]);if(this.cursorRead?.abort(),!h){this.setCursorLine(void 0);return}const c=this.cursorRead=new AbortController,d=this.options(2);o.values(0,{lo:l,hi:l.map(f=>f+1)},c.signal).then(f=>{c.signal.aborted||f.count===0||this.setCursorLine(`Voxel ${l.join(", ")} (${me(r.voxelSize)}): ${Bt(f.values,r.components,d)}`)},()=>{})}setCursorLine(e){e!==this.cursorLine&&(this.cursorLine=e,this.cursorText!==void 0&&(this.cursorText.textContent=e??Ue))}retryGlyphs(){for(const e of this.slots.values())e.error=void 0;this.drawn="",this.schedule(),this.panelUpdate?.()}draw3d(e){if(!this.saved.on||!this.saved.show3d||this.opened===void 0)return;const o=lo(e.dimensions);if(o===void 0)return;const{gl:t}=e;this.renderer3d?.gl!==t&&(this.renderer3d?.dispose(),this.renderer3d=new Se(t,e.outputs));const s=e.viewProjection,i=new Float32Array(16),a=this.move;for(let u=0;u<4;++u)for(let m=0;m<4;++m){let x=0;for(let w=0;w<4;++w)x+=o[4*w+m]*(a===void 0?w===u?1:0:a[4*w+u]);i[4*u+m]=x}const r=new Float32Array(16);for(let u=0;u<4;++u)for(let m=0;m<4;++m){let x=0;for(let w=0;w<4;++w)x+=s[4*w+m]*i[4*u+w];r[4*u+m]=x}const l=e.invViewProjection,h=u=>{const m=l[11]*u+l[15];return[0,1,2].map(x=>(l[8+x]*u+l[12+x])/m)},c=h(-1),d=h(1);let f=[0,0,0];for(let u=0;u<3;++u)for(let m=0;m<3;++m)o[4*m+u]!==0&&(f[m]=(d[u]-c[u])/o[4*m+u]);if(a!==void 0){const u=ae(a);f=[0,1,2].map(m=>u[4*m]*f[0]+u[4*m+1]*f[1]+u[4*m+2]*f[2])}const v=Math.hypot(f[0],f[1],f[2])||1,p=f.map(u=>u/v);t.enable(t.DEPTH_TEST),t.depthFunc(t.LESS);const g=[];for(const u of this.slots.values()){const m=u.shown;if(m===void 0)continue;const w=this.opened.levels[m.level].voxelSize*this.saved.size/2;g.push(m.set),this.renderer3d.draw(m.set,{matrix:r,viewDir:p,scale:w,viewport:[e.width,e.height],lineWidth:2,lift:w*1.05})}this.renderer3d.keepOnly(g)}paintScreenshot(e,o){if(!this.saved.on||!this.saved.show2d||this.glyphOverlay===void 0||this.overlay===void 0)return;this.frame(!0);const t=this.glyphOverlay.canvas,s=o.getBoundingClientRect(),i=o.width/Math.max(1,s.width),a=this.overlay.element.getBoundingClientRect();e.drawImage(t,(a.left-s.left)*i,(a.top-s.top)*i,a.width*i,a.height*i)}applyDirectionColour(){const e=this.opened,o=this.target();if(e===void 0||o===void 0){this.ctx.ui.toast("Open an image with orientations first.");return}const t=this.options(2),s=Wt(t,e.levels[0].components);if(s===void 0){this.ctx.ui.toast("Direction colour needs vectors, tensors or spherical harmonics.");return}const i=e.levels[0];if(i.componentChunk<i.components){this.ctx.ui.toast(`Can't colour by direction: this image splits each voxel's ${i.components} components over chunks of ${i.componentChunk}. Write it as OME-Zarr with whole channel chunks (see the README).`,"error");return}const a=this.channelEdit(o.name,"^");if(a==="loading"){this.ctx.ui.toast("The image's layer has not loaded yet; try again in a moment.");return}this.ctx.viewer.patchState(r=>{const l=(r.layers??[]).find(h=>h.name===o.name);l!==void 0&&(l.shader=s,a?.(l))})}channelEdit(e,o){const t=this.ctx.viewer.layerTransform(e),s=this.opened?.componentAxis,i=t?.output.names??[],a=i.find(r=>r===`${s}'`||r===s||r===`${s}^`);if(t===void 0||s===void 0||a===void 0)return"loading";if(!(a===`${s}${o}`||a===`${s}^`))return r=>{const l=typeof r.source=="string"?{url:r.source}:{...r.source},h={};i.forEach((c,d)=>h[c===a?`${s}${o}`:c]=[t.output.scales[d],t.output.units[d]]),l.transform={...l.transform??{},outputDimensions:h},r.source=l,delete r.localDimensions,delete r.localPosition}}channelised;channelise(){const e=this.opened,o=this.handleLayer;if(e===void 0||o===void 0||this.channelised===this.store)return;if(!(this.space?.names??[]).includes(e.componentAxis)){this.channelised=this.store;return}const t=this.channelEdit(o,"'");t!=="loading"&&(this.channelised=this.store,t!==void 0&&this.ctx.viewer.patchState(s=>{const i=(s.layers??[]).find(a=>a.name===o);i!==void 0&&t(i)},{quiet:!0}))}summary(){const e=this.opened;if(e===void 0)return;const o=e.levels[0],t=this.options(2),s=t.kind==="sh"?`Spherical harmonics, order ${he(o.components)}, ${t.basis.replace("-"," ")}`:t.kind==="tensor"?`Tensors in ${{fsl:"FSL",dipy:"DIPY",mrtrix:"MRtrix"}[t.tensorOrder]} order`:t.kind==="vector"?"Vectors":`Peaks, ${Math.floor(o.components/3)} per voxel`,i=`${e.levels.length} level${e.levels.length===1?"":"s"}, ${e.levels.map(l=>me(l.voxelSize)).join(", ")}`,a=this.coarsened,r=e.nifti!==void 0&&e.levels.length>1&&a!==void 0&&a.url===this.store?a.tensor!==null?"; coarser levels: log-Euclidean means":"; coarser levels: means":"";return`${s} · ${i}${r}`}describe(){const e=[],o=this.opened;if(o===void 0)return e;e.push(`${o.name}: ${this.summary()}.`);let t=0;for(const[s,i]of this.slots){t++;const a=s==="3d"?"3-D view":`View ${t}`,r=i.shown,l=[];r&&l.push(`${r.set.count} glyphs at ${me(o.levels[r.level].voxelSize)}`),i.pending&&l.push(`reading ${me(o.levels[i.pending.level].voxelSize)}…`),i.note&&l.push(i.note),i.error&&l.push(`could not read glyphs: ${i.error.message}`),l.length>0&&e.push(`${a}: ${l.join("; ")}`)}return e}render(e){const o=this.ctx,t=ht("No image in this scene.",{label:"Open data…",run:()=>void o.commands.invoke("dataset.add")}),s=dt(),i=this.saved,a=ft("Orientation glyphs",i.on,y=>this.set({on:y}),{info:"ODFs, tensors and peaks over an image with an axis of components (c). Also Glyphs beside Sections in the 3-D view."}),r=G([],"",y=>this.set({layer:y}),"Image"),l=F("p",{class:"hint"},"None of these images has an axis of components (c)."),h=G([["auto","Automatic"],["sh","Spherical harmonics (ODFs)"],["tensor","Diffusion tensors"],["vector","Vectors"],["peaks","Peaks"]],i.kind,y=>this.set({kind:y}),"Voxels hold"),c=G([["auto","Automatic"],...Ve],i.basis,y=>this.set({basis:y}),"SH basis"),d=E("SH basis",c,{info:"Automatic: the store's own word, else DIPY's legacy descoteaux07. MRtrix3 writes tournier07. A wrong basis scrambles the glyphs."}),f=G([["auto","Automatic"],...Xe],i.tensorOrder,y=>this.set({tensorOrder:y}),"Tensor order"),v=E("Tensor order",f,{info:"Automatic: the store's own word, DIPY's for a NIfTI whose header says symmetric matrix, else FSL's."}),p=G([["auto","Automatic"],["voxel","Voxel axes (DIPY, FSL)"],["world","World x, y, z (MRtrix)"]],i.frame,y=>this.set({frame:y}),"Frame"),g=[0,1,2].map(y=>be(`Flip ${"xyz"[y]}`,i.flips[y],S=>{const C=[...this.saved.flips];C[y]=S,this.set({flips:C})})),u=F("p",{class:"hint"}),m=G([["odf","ODF shape"],["peaks","Peaks (up to 3)"]],i.shGlyph,y=>this.set({shGlyph:y}),"ODF glyph"),x=E("ODF glyph",m),w=G([["ellipsoid","Ellipsoid"],["line","Principal direction"]],i.tensorGlyph,y=>this.set({tensorGlyph:y}),"Tensor glyph"),b=E("Tensor glyph",w),$=G([["minmax","Each voxel's range"],["max","Each voxel's maximum"],["none","The view's largest"]],i.normalise,y=>this.set({normalise:y}),"Scale glyphs to"),z=pe(i.size,{min:.2,max:3,step:.05,unit:"voxel",label:"Size",onchange:y=>this.set({size:y})}),O=pe(i.spacing,{min:4,max:80,step:1,unit:"px",label:"Spacing",onchange:y=>this.set({spacing:y})}),U=pe(i.minAnisotropy,{min:0,max:.9,step:.01,label:"Hide below anisotropy",onchange:y=>this.set({minAnisotropy:y})}),V=E("Hide below anisotropy",U,{info:"Leaves out glyphs whose GFA (spherical harmonics) or FA (tensors) is lower: outside the white matter, say. 0 hides none."}),B=pe(i.maxGlyphs,{min:500,max:3e4,step:500,label:"Glyph limit per view",onchange:y=>this.set({maxGlyphs:y})}),j=be("2-D views",i.show2d,y=>this.set({show2d:y})),q=be("3-D view",i.show3d,y=>this.set({show3d:y}),{info:"On the 2-D views' sections; with only a 3-D view, on three planes through the position."}),W=ut(y=>y.map(S=>F("p",{class:"hint"},S)),{class:"stack"}),X=pt("Colour image by direction",()=>this.applyDirectionColour()),L=F("p",{class:"readout"},this.cursorLine??Ue);this.cursorText=L;const Y=F("div",{class:"stack"},a,ve("orientations.image","Image",{open:!0},E("Image",r),l,E("Voxels hold",h,{info:"Automatic reads the store's orientations attributes, else goes by the number of components: 3 a vector, 6 a tensor, 15, 28, 45… spherical harmonics, other multiples of 3 peaks. Six can also be order-2 harmonics: choose them here."}),d,v,E("Frame",p,{info:"Directions along the voxel axes (DIPY, FSL) or along the world's x, y, z (MRtrix). Automatic: the store's word, else world for tournier07 and voxel otherwise."}),F("div",{class:"row"},...g,Oe("Flip an axis when glyphs point the wrong way (a common bvec problem), as in mrview or DSI Studio.","About Flip")),u),ve("orientations.glyphs","Glyphs",{},x,b,E("Scale glyphs to",$,{info:"Each voxel's range (min to max, as FURY), each voxel's maximum, or the largest in the view, so that sizes compare."}),E("Size",z,{info:"1 fills a voxel."}),E("Spacing",O,{info:"Glyphs at least this many pixels apart: each view shows the finest level that keeps them so."}),V,E("Glyph limit per view",B,{info:"At most this many glyphs in a view: beyond it a coarser level, and beyond the coarsest none until you zoom in."})),ve("orientations.views","Views",{},F("div",{class:"row"},j,q),W,F("div",{class:"row"},X,Oe("Sets the image layer's colours to the principal direction (red left-right, green front-back, blue up-down), weighted by the anisotropy, as Freeview's -dti display. Its Display tab has a brightness slider.","About Colour image by direction"))),ve("orientations.voxel","Voxel",{info:"What the voxel under the mouse holds: a tensor's FA, MD, eigenvalues and principal direction; an ODF's GFA and peaks; a vector's direction and length."},L));e.append(F("div",{class:"stack"},t,Y,s));const H=()=>{const y=this.saved,S=this.candidates();t.hidden=S.length>0,Y.hidden=S.length===0,a.set(y.on);const C=y.on?this.target():void 0,ce=C??S.find(M=>M.name===y.layer)??S.find(M=>M.name===this.chosen)??S[0];co(r,S.map(M=>[M.name,M.name]),ce?.name??""),r.disabled=S.length<2,l.hidden=!(y.on&&S.length>0&&C===void 0);const D=this.opened?Ge(y,this.opened,this.opened.levels[0].components):void 0;h.set(y.kind),c.set(y.basis),d.hidden=D!=="sh",f.set(y.tensorOrder),v.hidden=D!=="tensor",p.set(y.frame),g.forEach((M,oe)=>M.set(y.flips[oe]));const ee=this.summary();u.textContent=ee??"",u.hidden=ee===void 0,m.set(y.shGlyph),x.hidden=D!=="sh",w.set(y.tensorGlyph),b.hidden=D!=="tensor",$.set(y.normalise),z.set(y.size),O.set(y.spacing),U.set(y.minAnisotropy),V.hidden=D!=="sh"&&D!=="tensor",B.set(y.maxGlyphs),j.set(y.show2d),q.set(y.show3d),W.update([...new Set([...this.slots.values()].flatMap(M=>M.note?[M.note]:[]))]),X.disabled=this.opened===void 0;const te=[...this.slots.values()].find(M=>M.error!==void 0)?.error,Q=this.glyphOverlay?.problem,N=this.openState();Q!==void 0?s.error(Q,Q===Qe?{label:"Retry",run:()=>this.newGlyphOverlay()}:void 0):N==="failed"?s.error(this.openError??"Could not read the image.",{label:"Retry",run:()=>this.retryOpen()}):N==="retrying"?s.progress(`${this.openError??"Could not read the image"}. Trying again…`):this.openError!==void 0&&y.on?s.error(this.openError):te!==void 0?s.error(`Could not read glyphs: ${te.message}`,{label:"Retry",run:()=>this.retryGlyphs()}):N==="reading"?s.progress("Reading the image…"):s.clear()};return this.panelUpdate=H,H(),()=>{this.panelUpdate===H&&(this.panelUpdate=void 0),this.cursorText===L&&(this.cursorText=void 0)}}dispose(){this.disposed=!0,this.cursorRead?.abort(),clearTimeout(this.retryTimer),this.offs.forEach(e=>e()),this.clearSlots(),this.handle?.dispose(),this.toggle.dispose(),this.glyphOverlay?.dispose(),this.overlay?.dispose(),this.client?.dispose()}}function lo(n){const e=new Float32Array(16);e[15]=1;for(let o=0;o<3;++o){const t=["x","y","z"].indexOf(n.names[o]);if(t===-1)return;const s=n.units[o]==="m"?.001/n.scales[o]:1/n.scales[o];e[4*t+o]=s}return e}const Ue="No voxel under the mouse.";function co(n,e,o){const t=JSON.stringify(e);n.getAttribute("data-options")!==t&&(n.setAttribute("data-options",t),n.replaceChildren(...e.map(([s,i])=>F("option",{value:s},i))),n.value=o),n.set(o)}let ge;const mo={activate(n){ge=new ao(n);const e=ge;n.subscriptions.push(()=>{e.dispose(),ge===e&&(ge=void 0)}),n.ui.panel(lt,o=>e.render(o)),n.services.provide("orientations.status",{lines:()=>e.describe(),stats:e.stats}),n.commands.register("orientations.toggle",()=>{const o=Te(n.state.get());n.state.set({...o,on:!o.on})})}};export{no as OPEN_ATTEMPTS,ro as OPEN_WAIT_MS,ao as Orientations,mo as plugin,Te as readSaved,oo as resolveBasis,io as resolveFrame,Ge as resolveKind,so as resolveTensorOrder};
