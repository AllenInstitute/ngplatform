import{b as it,i as Qt,l as es}from"./colour_shader-rTf7ovXs.js";import{e as te,g as ts,r as de,j as ss,t as ke,b as ne,p as rt,o as nt,f as Q,n as Le,q as at}from"./dom-B9rdSvZ1.js";import{P as lt,g as os,s as is,m as ct}from"./sources-CfxaY8yx.js";import{s as rs}from"./source_url-CkBYFb6f.js";import{T as U,S as oe,P as ht,G as _e,m as Ot,a as ns,b as W,i as Me,c as Fe,s as Be,d as ce,p as Dt,e as kt,f as Lt,g as Ce,h as It,j as as,k as ls,l as cs,n as hs,o as us,q as ds,r as fs,t as ms,v as Ie,u as Ae,w as vs,x as ps,y as gs,z as ws,A as fe,B as bs,C as ys,D as Es,E as Ts}from"./mesh_layers-XXZCRHqZ.js";import{z as xs,d as Ss}from"./worker_factories-B1Z4AVpb.js";import{w as As,a as ut,b as dt}from"./manifest-Dpf2k_8c.js";import{S as Rs,o as _s,c as Cs,Z as Ms}from"./zarr_array-CRtOb2bc.js";import{h as ft,r as Fs,P as Bs}from"./precomputed-DNtQCeou.js";import{l as Ns,c as Os}from"./shared_chunks-BvbSDm9W.js";import{w as Ds}from"./chunk_host-DnLSg23N.js";import"./decode_common-w4_Fc8qv.js";import"./jpg-DHI4uRBb.js";import"./hash-BMM8fdB1.js";function mt(n,t){const[e,s,o,i]=n,[a,r,l,h]=t;return[i*a+e*h+s*l-o*r,i*r-e*l+s*h+o*a,i*l+e*r-s*a+o*h,i*h-e*a-s*r-o*l]}function ks(n){return[-n[0],-n[1],-n[2],n[3]]}function Ut(n){const t=Math.hypot(...n)||1;return[n[0]/t,n[1]/t,n[2]/t,n[3]/t]}function Ls(n){let[t,e,s,o]=Ut(n);o<0&&([t,e,s,o]=[-t,-e,-s,-o]);const i=Math.hypot(t,e,s);if(i<1e-12)return[0,0,0];const a=2*Math.atan2(i,o);return[t/i*a,e/i*a,s/i*a]}function Is(n){const t=Math.hypot(...n);if(t<1e-12)return[0,0,0,1];const e=Math.sin(t/2)/t;return[n[0]*e,n[1]*e,n[2]*e,Math.cos(t/2)]}function Us(n,t){return n*Math.pow(.75,t/(1e3/60))}function Ps(){try{return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches===!0}catch{return!1}}class $s{constructor(t){this.ctx=t}on=!1;samples=[];dragging=!1;glide;offs=[];set(t){t!==this.on&&(this.on=t,t?this.listen():this.unlisten())}orientation(){const t=this.ctx.viewer.getState().projectionOrientation;return Array.isArray(t)&&t.length===4?t:[0,0,0,1]}in3d(t){const e=t.target;return this.ctx.viewer.panels().some(s=>s.kind==="3d"&&e!==null&&s.element.contains(e))}listen(){const t=o=>{this.stop(),this.in3d(o)&&(this.dragging=!0,this.samples=[])},e=()=>{this.dragging&&(this.dragging=!1,this.start())},s=()=>this.stop();window.addEventListener("pointerdown",t,!0),window.addEventListener("pointerup",e,!0),window.addEventListener("wheel",s,!0),window.addEventListener("keydown",s,!0),this.offs.push(()=>window.removeEventListener("pointerdown",t,!0),()=>window.removeEventListener("pointerup",e,!0),()=>window.removeEventListener("wheel",s,!0),()=>window.removeEventListener("keydown",s,!0),this.ctx.viewer.onStateChanged(()=>{if(!this.dragging)return;const o=this.orientation();if(o===void 0)return;const i=performance.now();for(this.samples.push({t:i,q:o});this.samples.length>2&&i-this.samples[0].t>100;)this.samples.shift()}))}unlisten(){this.stop(),this.offs.splice(0).forEach(t=>t())}start(){if(Ps())return;const t=this.samples;if(t.length<2)return;const e=t[0],s=t[t.length-1],o=performance.now()-s.t,i=s.t-e.t;if(i<8||o>60)return;const a=Ls(mt(s.q,ks(e.q)));let r=[a[0]/i,a[1]/i,a[2]/i];if(Math.hypot(...r)<1e-5)return;let l=performance.now();const h=()=>{const c=performance.now(),u=Math.min(c-l,50);l=c;const m=this.orientation();if(m===void 0)return;const w=Is([r[0]*u,r[1]*u,r[2]*u]),A=Ut(mt(w,m)),p=Us(1,u);if(r=[r[0]*p,r[1]*p,r[2]*p],this.ctx.viewer.patchState(d=>{d.projectionOrientation=A},{quiet:!0}),Math.hypot(...r)<2e-5){this.glide=void 0;return}this.glide=requestAnimationFrame(h)};this.glide=requestAnimationFrame(h)}stop(){this.glide!==void 0&&cancelAnimationFrame(this.glide),this.glide=void 0}dispose(){this.unlisten()}}function zs(n){return`#version 300 es
precision highp float;
precision highp int;
${n}
uniform highp sampler2D uNormals;
// The eye in store coordinates: a point (w = 1) or, for a view from far away, a direction (w = 0).
uniform vec4 uEye;
layout(location = 0) in uint aVertex;
out vec3 vColour;
out vec3 vNormal;
out vec3 vToEye;
out float vWeight;
out vec3 vModel;

void main() {
  vec4 object = objectAt(aVertex);
  vModel = vec3(0.0);
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
  vec3 n = texelFetch(uNormals, ivec2(int(aVertex % ${U}u), int(aVertex / ${U}u)), 0).xyz;
  gl_Position = uModelToClip * vec4(v.xyz, 1.0);
  vModel = v.xyz;
  vNormal = n;
  vToEye = uEye.w > 0.5 ? uEye.xyz - v.xyz : uEye.xyz;
  vColour = colourAt(v, n, object.rgb);
}
`}function js(n,t){const e=[`layout(location = ${t.color}) out vec4 outColour;`];t.z!==void 0&&e.push(`layout(location = ${t.z}) out highp vec4 outZ;`),t.pick!==void 0&&e.push(`layout(location = ${t.pick}) out highp vec4 outPick;`);const s=`${t.z!==void 0?"outZ = vec4(1.0 - fragDepth);":""}${t.pick!==void 0?"outPick = vec4(0.0);":""}`,o={accumulate:`
      // Lit from the eye, with a rim where the surface turns away: a glowing shell.
      float light = 0.2 + 0.6 * facing + 0.6 * pow(1.0 - facing, 3.0);
      float fragDepth = gl_FragCoord.z;
      // Fainter the further behind the nearest surface at this pixel.
      float behind = 1.0;
      if (uFalloff > 0.0) {
        float near = texelFetch(uFront, ivec2(gl_FragCoord.xy), 0).r;
        if (near < 1.0) {
          vec4 p = uClipToModel * vec4(gl_FragCoord.xy / uViewport * 2.0 - 1.0, 2.0 * near - 1.0, 1.0);
          behind = exp(-length(vModel - p.xyz / p.w) / uFalloff);
        }
      }
      // Seen edge on, the path through the surface is longer: it absorbs more.
      outColour = vec4(vColour * (light * uGain * behind), uAbsorption / max(facing, 0.2)) * vWeight;
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
      ${s}`}[n];return`#version 300 es
precision highp float;
uniform float uGain;
uniform float uAbsorption;
uniform bool uDepthNear;
// The nearest surface's depth at each pixel, and how quickly light behind it fades (store units; 0: it does not).
uniform highp sampler2D uFront;
uniform float uFalloff;
uniform mat4 uClipToModel;
uniform vec2 uViewport;
in vec3 vColour;
in vec3 vNormal;
in vec3 vToEye;
in float vWeight;
in vec3 vModel;
${e.join(`
`)}

void main() {
  vec3 n = length(vNormal) > 0.0 ? normalize(vNormal) : vec3(0.0, 0.0, 1.0);
  vec3 e = length(vToEye) > 0.0 ? normalize(vToEye) : vec3(0.0, 0.0, 1.0);
  // Either side faces the light at the eye.
  float facing = abs(dot(n, e));
  ${o}
}
`}function Vs(n){return`#version 300 es
precision highp float;
precision highp int;
${n}
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
`}function Gs(n,t){return t===0?BigInt(n>>>0):BigInt(t>>>0)<<32n|BigInt(n>>>0)}function Pt(n){return!n.all||n.colour!==void 0||n.slotColours===!0}function Xs(n,t){return n.all?1:n.has(t)?n.chosenAlpha??1:n.othersAlpha??0}function Ws(n){return n>0?Math.max(1,Math.min(255,Math.round(n*255))):0}function Hs(n,t,e,s){const o=n.length/2,i=Math.max(1,Math.ceil(o/U)),a=new Uint8Array(i*U*4);let r=0,l=0,h=0,c=!1;for(let m=0;m<o;++m){const w=Gs(n[2*m],n[2*m+1]),A=Ws(Xs(e,w)),p=t[m]??0;if(r+=p,A===0)continue;l+=p,h+=p*A/255,c=!0,a[4*m+3]=A;const d=e.slotColours?s?.[m]:void 0,f=d!==void 0?void 0:e.colour?.(w);if(d!==void 0)a[4*m]=d>>>16&255,a[4*m+1]=d>>>8&255,a[4*m+2]=d&255;else if(f!==void 0)for(let v=0;v<3;++v)a[4*m+v]=Math.round(Math.min(1,Math.max(0,f[v]))*255);else a.fill(255,4*m,4*m+3)}const u=m=>r>0?m/r:c?1:0;return{table:a,rows:i,shown:u(l),light:u(h)}}const $t=6,be=32,zt=`uniform vec3 uLut[${be}];

// Colormaps as polynomial fits (viridis, magma, inferno and plasma after
// Matt Zucker's fits of matplotlib's, CC0; turbo after Google's); 6, a table.
vec3 colormap(int which, float t) {
  t = clamp(t, 0.0, 1.0);
  if (which == ${$t}) {
    float s = t * ${be-1}.0;
    int i = int(min(floor(s), ${be-2}.0));
    return mix(uLut[i], uLut[i + 1], s - float(i));
  }
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
}`,Ne=`
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
// Coloured by a value: those outside uRange are not drawn (a layer's window, its outside hidden).
uniform bool uHideOutside;
// Drawn opaque (solid): an object drawn faintly (the layer's notSelectedAlpha) is left out.
uniform bool uOpaque;

vec4 vertexAt(uint i) {
  return texelFetch(uVertices, ivec2(int(i % ${U}u), int(i / ${U}u)), 0);
}

// Whether an object (its table entry, from objectAt) is not drawn: not shown, or faint and drawn opaque.
bool hidden(vec4 object) {
  return object.a < 0.5 / 255.0 || (uOpaque && object.a < 254.5 / 255.0);
}

// A vertex's object: its colour (as the layer colours segments) and how strongly it is drawn (alpha; 0 not at all).
vec4 objectAt(uint i) {
  vec4 object = vec4(1.0);
  if (uObjectTable) {
    uint slot = texelFetch(uSlots, ivec2(int(i % ${U}u), int(i / ${U}u)), 0).r;
    object = texelFetch(uObjects, ivec2(int(slot % ${U}u), int(slot / ${U}u)), 0);
  }
  if (uHideOutside) {
    float w = vertexAt(i).w;
    if (!(w >= uRange.x && w <= uRange.y)) object.a = 0.0;
  }
  return object;
}

${zt}

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
`,qs=zs(Ne),Ys=Vs(Ne),Js=`#version 300 es
precision highp float;
precision highp int;
${Ne}
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
`,Ks=`#version 300 es
precision highp float;
precision highp int;
${Ne}
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
`;function Zs(n,t,e){const s=[];s.push(`layout(location = ${e.color}) out vec4 outColour;`),e.z!==void 0&&s.push(`layout(location = ${e.z}) out highp vec4 outZ;`),e.pick!==void 0&&s.push(`layout(location = ${e.pick}) out highp vec4 outPick;`);const o=`${e.z!==void 0?"outZ = vec4(1.0 - fragDepth);":""}${e.pick!==void 0?"outPick = vec4(0.0);":""}`,i={accumulate:`
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
${n?"in vec2 vCorner;":"in float vAcross;"}
in float vSection;
in float vFade;
${s.join(`
`)}

void main() {
  float r = ${n?"length(vCorner)":"abs(vAcross)"};
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
`}const Qs=`#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;function eo(n,t){const e=t?[`layout(location = ${n.color}) out vec4 outColour;`,n.z!==void 0?`layout(location = ${n.z}) out highp vec4 outZ;`:"",n.pick!==void 0?`layout(location = ${n.pick}) out highp vec4 outPick;`:""].join(`
`):`layout(location = ${n.color}) out vec4 outColour;`,s=t?`
  if (shown.a < uCut) discard;
  float d = texelFetch(uDepth, ivec2(gl_FragCoord.xy) - uOrigin, 0).r;
  if (d >= 1.0) discard;
  float fragDepth = uNear ? 0.0 : d;
  gl_FragDepth = fragDepth;
  outColour = vec4(0.0);
  ${n.z!==void 0?"outZ = vec4(1.0 - fragDepth);":""}
  ${n.pick!==void 0?"outPick = vec4(0.0);":""}`:"outColour = shown;";return`#version 300 es
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
}`}class Ye{constructor(t){this.gl=t,this.floatTargets=t.getExtension("EXT_color_buffer_float")!==null}programs=new Map;emptyVao;floatTargets;compile(t,e,s){let o=this.programs.get(t);if(o!==void 0)return o;const{gl:i}=this,a=(c,u)=>{const m=i.createShader(c);if(i.shaderSource(m,u),i.compileShader(m),!i.getShaderParameter(m,i.COMPILE_STATUS))throw new Error(`Luxar shader: ${i.getShaderInfoLog(m)??"did not compile"}`);return m},r=i.createProgram(),l=a(i.VERTEX_SHADER,e),h=a(i.FRAGMENT_SHADER,s);if(i.attachShader(r,l),i.attachShader(r,h),i.linkProgram(r),i.deleteShader(l),i.deleteShader(h),!i.getProgramParameter(r,i.LINK_STATUS))throw new Error(`Luxar program: ${i.getProgramInfoLog(r)??"did not link"}`);return o={program:r,uniforms:new Map},this.programs.set(t,o),o}uniform(t,e){let s=t.uniforms.get(e);return s===void 0&&(s=this.gl.getUniformLocation(t.program,e),t.uniforms.set(e,s)),s}upload(t){const{gl:e}=this,s=e.createTexture();e.bindTexture(e.TEXTURE_2D,s),e.pixelStorei(e.UNPACK_ALIGNMENT,4);const o=t.vertices.length/4/U;e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,U,o,0,e.RGBA,e.FLOAT,t.vertices),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST);const i=e.createTexture();e.bindTexture(e.TEXTURE_2D,i),e.texImage2D(e.TEXTURE_2D,0,e.R32UI,U,o,0,e.RED_INTEGER,e.UNSIGNED_INT,t.slots),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.bindTexture(e.TEXTURE_2D,null);const a=e.createVertexArray();let r;t.segmentCount>0&&(e.bindVertexArray(a),r=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,r),e.bufferData(e.ARRAY_BUFFER,t.segments,e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribIPointer(0,4,e.UNSIGNED_INT,0,0),e.vertexAttribDivisor(0,1),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null));let l,h,c,u;return t.triangleCount>0&&(l=e.createTexture(),e.bindTexture(e.TEXTURE_2D,l),e.texImage2D(e.TEXTURE_2D,0,e.RGBA32F,U,o,0,e.RGBA,e.FLOAT,t.normals),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.bindTexture(e.TEXTURE_2D,null),h=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,h),e.bufferData(e.ARRAY_BUFFER,t.triangles,e.STATIC_DRAW),c=e.createVertexArray(),e.bindVertexArray(c),e.enableVertexAttribArray(0),e.vertexAttribIPointer(0,1,e.UNSIGNED_INT,0,0),u=e.createVertexArray(),e.bindVertexArray(u),e.enableVertexAttribArray(0),e.vertexAttribIPointer(0,3,e.UNSIGNED_INT,12,0),e.vertexAttribDivisor(0,1),e.bindVertexArray(null),e.bindBuffer(e.ARRAY_BUFFER,null)),{texture:s,segments:r,vao:a,segmentCount:t.segmentCount,pointCount:t.pointCount,bytes:t.vertices.byteLength+t.slots.byteLength+t.segmentCount*16+t.normals.byteLength+t.triangles.byteLength,length:t.length,slots:i,objectIds:t.objectIds,objectWeight:t.objectWeight,slotColours:t.slotColours,objects:void 0,tableVersion:-1,shown:1,light:1,lower:t.lower,upper:t.upper,pieces:t.pieces,triangleCount:t.triangleCount,area:t.area,normals:l,faces:h,meshVao:c,cutVao:u}}shade(t,e){if(t.tableVersion===e.version)return;if(t.tableVersion=e.version,!Pt(e)){t.shown=t.light=1;return}const{gl:s}=this,{table:o,rows:i,shown:a,light:r}=Hs(t.objectIds,t.objectWeight,e,t.slotColours);t.shown=a,t.light=r,t.objects??=s.createTexture(),s.bindTexture(s.TEXTURE_2D,t.objects),s.pixelStorei(s.UNPACK_ALIGNMENT,4),s.texImage2D(s.TEXTURE_2D,0,s.RGBA8,U,i,0,s.RGBA,s.UNSIGNED_BYTE,o),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.NEAREST),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.NEAREST),s.bindTexture(s.TEXTURE_2D,null)}release(t){const{gl:e}=this;e.deleteTexture(t.texture),e.deleteTexture(t.slots),t.objects&&e.deleteTexture(t.objects),t.segments&&e.deleteBuffer(t.segments),e.deleteVertexArray(t.vao),t.normals&&e.deleteTexture(t.normals),t.faces&&e.deleteBuffer(t.faces),t.meshVao&&e.deleteVertexArray(t.meshVao),t.cutVao&&e.deleteVertexArray(t.cutVao)}draw(t,e,s,o,i,a=oe){const{gl:r}=this;for(const l of["lines","points","triangles"]){const h=l==="points",c=f=>l==="lines"?f.segmentCount:h?f.pointCount:f.triangleCount,u=t.filter(f=>c(f)>0&&(!o.objectTable||f.shown>0&&f.objects!==void 0));if(u.length===0)continue;const m=l==="triangles"&&o.slab>0,w=l==="triangles"&&!m,A=`${m?"cut":l}|${e}|${s.color},${s.z},${s.pick}`,p=l==="lines"?Js:h?Ks:m?Ys:qs,d=this.compile(A,p,w?js(e,s):Zs(h,e,s));r.useProgram(d.program),r.uniformMatrix4fv(this.uniform(d,"uModelToClip"),!1,o.modelToClip),r.uniformMatrix3fv(this.uniform(d,"uDirections"),!1,o.directions),r.uniform2f(this.uniform(d,"uViewport"),o.viewport[0],o.viewport[1]),r.uniform1f(this.uniform(d,"uHalfWidth"),h?3*o.halfWidth:o.halfWidth),r.uniform1i(this.uniform(d,"uColourBy"),h&&o.colourBy===0?1:o.colourBy),r.uniform3fv(this.uniform(d,"uColour"),o.colour),r.uniform1i(this.uniform(d,"uColormap"),o.colormap),r.uniform2f(this.uniform(d,"uRange"),o.range[0],o.range[1]),o.lut!==void 0&&r.uniform3fv(this.uniform(d,"uLut"),o.lut),r.uniform1i(this.uniform(d,"uHideOutside"),o.hideOutside?1:0),r.uniform4fv(this.uniform(d,"uPlane"),o.plane),r.uniform1f(this.uniform(d,"uSlab"),o.slab),r.uniform1f(this.uniform(d,"uSharpness"),o.sharpness),r.uniform1f(this.uniform(d,"uGain"),o.gain),r.uniform1f(this.uniform(d,"uAbsorption"),o.absorption),r.uniform1f(this.uniform(d,"uDepthCut"),o.depthCut),r.uniform1i(this.uniform(d,"uDepthNear"),o.depthNear?1:0),r.uniform1i(this.uniform(d,"uVertices"),0),r.uniform1i(this.uniform(d,"uSlots"),1),r.uniform1i(this.uniform(d,"uObjects"),2),r.uniform1i(this.uniform(d,"uObjectTable"),o.objectTable?1:0),r.uniform1i(this.uniform(d,"uOpaque"),e==="solid"?1:0),r.uniform1i(this.uniform(d,"uNormals"),3),r.uniform4fv(this.uniform(d,"uEye"),o.eye),w&&(r.uniform1i(this.uniform(d,"uFront"),4),r.uniform1f(this.uniform(d,"uFalloff"),o.front?.falloff??0),o.front!==void 0&&r.uniformMatrix4fv(this.uniform(d,"uClipToModel"),!1,o.front.clipToModel),r.activeTexture(r.TEXTURE4),r.bindTexture(r.TEXTURE_2D,o.front?.texture??null));for(const f of u)if(r.activeTexture(r.TEXTURE3),r.bindTexture(r.TEXTURE_2D,f.normals??null),r.activeTexture(r.TEXTURE1),r.bindTexture(r.TEXTURE_2D,f.slots),r.activeTexture(r.TEXTURE2),r.bindTexture(r.TEXTURE_2D,f.objects??null),r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,f.texture),h)this.emptyVao??=r.createVertexArray(),r.bindVertexArray(this.emptyVao),r.drawArraysInstanced(r.TRIANGLE_STRIP,0,4,f.pointCount);else if(w)r.bindVertexArray(f.meshVao),r.drawArrays(r.TRIANGLES,0,3*f.triangleCount);else if(m)r.bindVertexArray(f.cutVao),r.drawArraysInstanced(r.TRIANGLE_STRIP,0,4,f.triangleCount);else if(f.pieces!==void 0&&f.segments!==void 0){r.bindVertexArray(f.vao),r.bindBuffer(r.ARRAY_BUFFER,f.segments);const{pieces:v}=f,b=Math.max(1,Math.min(oe,Math.round(a)));for(let y=0;y+ht<=v.length;y+=ht){if(i!==void 0&&!i([v[y+2],v[y+3],v[y+4]],[v[y+5],v[y+6],v[y+7]]))continue;const R=v[y+7+b];R!==0&&(r.vertexAttribIPointer(0,4,r.UNSIGNED_INT,0,v[y]*16),r.drawArraysInstanced(r.TRIANGLE_STRIP,0,4,R))}r.vertexAttribIPointer(0,4,r.UNSIGNED_INT,0,0),r.bindBuffer(r.ARRAY_BUFFER,null)}else r.bindVertexArray(f.vao),r.drawArraysInstanced(r.TRIANGLE_STRIP,0,4,f.segmentCount);r.bindVertexArray(null);for(const f of[r.TEXTURE4,r.TEXTURE3,r.TEXTURE2,r.TEXTURE1])r.activeTexture(f),r.bindTexture(r.TEXTURE_2D,null);r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,null)}}composite(t,e,s){const{gl:o}=this,i=s.depth,a=this.compile(`composite|${i?"depth":"colour"}|${e.color},${e.z},${e.pick}`,Qs,eo(e,i!==void 0));if(o.useProgram(a.program),o.activeTexture(o.TEXTURE0),o.bindTexture(o.TEXTURE_2D,t),o.uniform1i(this.uniform(a,"uLight"),0),i&&(o.activeTexture(o.TEXTURE1),o.bindTexture(o.TEXTURE_2D,i.texture),o.uniform1i(this.uniform(a,"uDepth"),1),o.uniform1f(this.uniform(a,"uCut"),i.cut),o.uniform1i(this.uniform(a,"uNear"),i.near?1:0)),!i){const r=s.bloom;for(let l=0;l<3;++l)o.activeTexture(o.TEXTURE1+l),o.bindTexture(o.TEXTURE_2D,r?.textures[l]??null),o.uniform1i(this.uniform(a,`uBloom${l}`),1+l);o.uniform1f(this.uniform(a,"uBloom"),r!==void 0&&r.textures.length>=3?r.amount:0),o.activeTexture(o.TEXTURE0)}if(o.uniform2i(this.uniform(a,"uOrigin"),s.origin[0],s.origin[1]),o.uniform1i(this.uniform(a,"uToneMap"),s.toneMap),o.uniform1i(this.uniform(a,"uEmission"),s.emission?1:0),this.emptyVao??=o.createVertexArray(),o.bindVertexArray(this.emptyVao),o.drawArrays(o.TRIANGLES,0,3),o.bindVertexArray(null),i)o.bindTexture(o.TEXTURE_2D,null),o.activeTexture(o.TEXTURE0);else{for(let r=3;r>=1;--r)o.activeTexture(o.TEXTURE0+r),o.bindTexture(o.TEXTURE_2D,null);o.activeTexture(o.TEXTURE0)}o.bindTexture(o.TEXTURE_2D,null)}fullScreen(t,e,s,o,i={},a={}){const{gl:r}=this,l=this.compile(t,e,s);r.useProgram(l.program);const h=Object.keys(o);h.forEach((c,u)=>{r.activeTexture(r.TEXTURE0+u),r.bindTexture(r.TEXTURE_2D,o[c]),r.uniform1i(this.uniform(l,c),u)});for(const[c,u]of Object.entries(i))r.uniform2i(this.uniform(l,c),u[0],u[1]);for(const[c,u]of Object.entries(a))r.uniform1f(this.uniform(l,c),u);this.emptyVao??=r.createVertexArray(),r.bindVertexArray(this.emptyVao),r.drawArrays(r.TRIANGLES,0,3),r.bindVertexArray(null);for(let c=h.length-1;c>=0;--c)r.activeTexture(r.TEXTURE0+c),r.bindTexture(r.TEXTURE_2D,null)}dispose(){for(const t of this.programs.values())this.gl.deleteProgram(t.program);this.programs.clear(),this.emptyVao&&this.gl.deleteVertexArray(this.emptyVao),this.emptyVao=void 0}}class Je{constructor(t,e){this.gl=t,this.float=e}framebuffer;texture;size=[0,0];depth=null;bind(t,e,s){const{gl:o}=this;return this.framebuffer===void 0||this.size[0]!==t||this.size[1]!==e?(this.release(),this.texture=o.createTexture(),o.bindTexture(o.TEXTURE_2D,this.texture),this.float?o.texImage2D(o.TEXTURE_2D,0,o.RGBA16F,t,e,0,o.RGBA,o.HALF_FLOAT,null):o.texImage2D(o.TEXTURE_2D,0,o.RGBA8,t,e,0,o.RGBA,o.UNSIGNED_BYTE,null),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_MIN_FILTER,o.NEAREST),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_MAG_FILTER,o.NEAREST),o.bindTexture(o.TEXTURE_2D,null),this.framebuffer=o.createFramebuffer(),o.bindFramebuffer(o.FRAMEBUFFER,this.framebuffer),o.framebufferTexture2D(o.FRAMEBUFFER,o.COLOR_ATTACHMENT0,o.TEXTURE_2D,this.texture,0),this.size=[t,e],this.depth=null):o.bindFramebuffer(o.FRAMEBUFFER,this.framebuffer),s!==this.depth&&(o.framebufferRenderbuffer(o.FRAMEBUFFER,o.DEPTH_STENCIL_ATTACHMENT,o.RENDERBUFFER,s),this.depth=s),o.drawBuffers([o.COLOR_ATTACHMENT0]),o.checkFramebufferStatus(o.FRAMEBUFFER)===o.FRAMEBUFFER_COMPLETE}release(){const{gl:t}=this;this.framebuffer&&t.deleteFramebuffer(this.framebuffer),this.texture&&t.deleteTexture(this.texture),this.framebuffer=this.texture=void 0,this.depth=null,this.size=[0,0]}}class vt{constructor(t){this.gl=t}framebuffer;texture;size=[0,0];bind(t,e){const{gl:s}=this;return this.framebuffer===void 0||this.size[0]!==t||this.size[1]!==e?(this.release(),this.texture=s.createTexture(),s.bindTexture(s.TEXTURE_2D,this.texture),s.texImage2D(s.TEXTURE_2D,0,s.DEPTH_COMPONENT24,t,e,0,s.DEPTH_COMPONENT,s.UNSIGNED_INT,null),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.NEAREST),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.NEAREST),s.bindTexture(s.TEXTURE_2D,null),this.framebuffer=s.createFramebuffer(),s.bindFramebuffer(s.FRAMEBUFFER,this.framebuffer),s.framebufferTexture2D(s.FRAMEBUFFER,s.DEPTH_ATTACHMENT,s.TEXTURE_2D,this.texture,0),this.size=[t,e]):s.bindFramebuffer(s.FRAMEBUFFER,this.framebuffer),s.drawBuffers([s.NONE]),s.checkFramebufferStatus(s.FRAMEBUFFER)!==s.FRAMEBUFFER_COMPLETE?!1:(s.depthMask(!0),s.clearDepth(1),s.clear(s.DEPTH_BUFFER_BIT),!0)}release(){const{gl:t}=this;this.framebuffer&&t.deleteFramebuffer(this.framebuffer),this.texture&&t.deleteTexture(this.texture),this.framebuffer=this.texture=void 0,this.size=[0,0]}}const we={on:!0,blending:"glow",colourBy:"direction",colormap:"viridis",colour:"#ffb347",width:2,exposure:0,sharpness:.5,absorption:1,toneMap:"aces-hue",detail:2,autoBrightness:!0,bloom:0,glowDepth:.02},to=["glow","glow-through","emission","solid"],so=["direction","object","attribute","solid","segment","layer"],jt=["viridis","magma","inferno","plasma","turbo","grey"],oo=["aces-hue","aces","reinhard","clamp"],io=[["glow","Glow (behind what is in front)"],["glow-through","Glow through (over everything)"],["emission","Emission and absorption"],["solid","Solid tubes"]],ro=[["direction","Direction (x red, y green, z blue)"],["object","Each object its own colour"],["attribute","An attribute, through a colormap"],["solid","One colour"],["segment","The layer's segment colours"],["layer","As the layer (its Colour by)"]],pt=jt.map(n=>[n,n==="grey"?"Grey":n[0].toUpperCase()+n.slice(1)]),no=[["aces-hue","ACES filmic, keeping colour"],["aces","ACES filmic (bright light turns white)"],["reinhard","Reinhard"],["clamp","None (clamp)"]],ee=(n,t,e,s)=>typeof n=="number"&&Number.isFinite(n)?Math.min(e,Math.max(t,n)):s,Te=(n,t,e)=>t.includes(n)?n:e;function Vt(n,t=!1){const e=n??{},s=we,o=Array.isArray(e.range)&&e.range.length===2&&e.range.every(i=>typeof i=="number"&&Number.isFinite(i))?[e.range[0],e.range[1]]:void 0;return{on:e.on!==!1,blending:Te(e.blending,to,s.blending),colourBy:Te(e.colourBy,so,s.colourBy),attribute:typeof e.attribute=="string"?e.attribute:void 0,colormap:Te(e.colormap,jt,s.colormap),range:o,colour:typeof e.colour=="string"&&/^#[0-9a-f]{6}$/i.test(e.colour)?e.colour:s.colour,width:ee(e.width,.5,40,s.width),exposure:ee(e.exposure,-12,12,s.exposure),sharpness:ee(e.sharpness,0,1,s.sharpness),absorption:ee(e.absorption,0,20,s.absorption),toneMap:Te(e.toneMap,oo,s.toneMap),slab:typeof e.slab=="number"&&Number.isFinite(e.slab)&&!(t&&e.slab===Gt)?Math.min(Wt,Math.max(Xt,e.slab)):void 0,detail:ee(e.detail,.1,50,s.detail),autoBrightness:e.autoBrightness!==!1,bloom:ee(e.bloom,0,3,s.bloom),glowDepth:ee(e.glowDepth,0,.5,s.glowDepth)}}function gt(n){const t=n??{},e={};if(t.layers!==null&&typeof t.layers=="object")for(const[s,o]of Object.entries(t.layers))e[s]=Vt(o,t.version!==2);return{version:2,layers:e,momentum:t.momentum===!0}}const Gt=4,Xt=1e-7,Wt=1e4;function Ve(n){return n.bounds.lower.map((t,e)=>{const s=n.axisScales[e]??1;return Math.abs((n.bounds.upper[e]??t)-t)*(n.axisUnits[e]==="m"?s*1e3:s)})}function Ge(n){const t=n.filter(s=>Number.isFinite(s)&&s>0);if(t.length===0)return Gt;const e=t.reduce((s,o)=>s+o,0)/t.length;return Math.min(Wt,Math.max(Xt,Number((e/40).toPrecision(1))))}function Ht(n,t){return n.slab??Ge(t)}function ao(n){const t=10**Math.floor(Math.log10(n)),e=n/t;return Number(((e<Math.sqrt(2)?1:e<Math.sqrt(10)?2:e<Math.sqrt(50)?5:10)*t).toPrecision(1))}function wt(n){const[t,e]=n>=1?["mm",1]:n>=.001?["µm",.001]:["nm",1e-6],s=n/e,o=ao(s/8);return{unit:t,perUnit:e,min:o,max:Number((10*s).toPrecision(3)),step:o}}function Ke(n){const t=parseInt(n.slice(1),16);return[(t>>16&255)/255,(t>>8&255)/255,(t&255)/255]}const Ze={viridis:0,magma:1,inferno:2,plasma:3,turbo:4,grey:5},Qe={aces:0,reinhard:1,clamp:2,"aces-hue":3},bt={direction:0,object:1,attribute:2,solid:3,segment:4,layer:4};function xe(n,t){if(n.colourBy==="layer"){const e=t?.by==="group"?t.group:void 0;return e!==void 0?`group:${e.attribute}${e.colours==="stored"&&e.colorAttribute?`:${e.colorAttribute}`:""}`:t?.by==="attribute"&&t.attribute!==void 0?`attribute:${t.attribute}`:"object"}return n.colourBy==="attribute"&&n.attribute!==void 0?`attribute:${n.attribute}`:"object"}const yt=1,Ue=.5,lo=3,co=2,Pe=6;function ho(n,t){const e=new Float32Array(t+1);let s=0;for(let o=0;o<=t;++o)e[o]=Math.exp(-(o*o)/(2*n*n)),s+=o===0?e[o]:2*e[o];for(let o=0;o<=t;++o)e[o]/=s;return e}const uo=`
vec3 brightPass(vec3 c) {
  float x = max(c.r, max(c.g, c.b));
  if (x <= 0.0) return vec3(0.0);
  float soft = clamp(x - ${yt.toFixed(4)} + ${Ue.toFixed(4)}, 0.0, ${(2*Ue).toFixed(4)});
  float curve = soft * soft / ${(4*Ue).toFixed(4)};
  return c * (max(curve, x - ${yt.toFixed(4)}) / x);
}`,$e=`#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;function fo(n){return`#version 300 es
precision highp float;
uniform highp sampler2D uSource;
uniform float uEmission;
out vec4 outColour;
${uo}
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
      sum += ${n?"brightPass(shownLight(v))":"max(v.rgb, vec3(0.0))"};
    }
  }
  outColour = vec4(sum * 0.25, 1.0);
}`}function Et(){const n=ho(co,Pe);return`#version 300 es
precision highp float;
uniform highp sampler2D uSource;
uniform ivec2 uStep;
out vec4 outColour;
const float W[${Pe+1}] = float[](${Array.from(n,t=>t.toFixed(8)).join(", ")});
void main() {
  ivec2 size = textureSize(uSource, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 sum = texelFetch(uSource, p, 0).rgb * W[0];
  for (int i = 1; i <= ${Pe}; ++i) {
    sum += texelFetch(uSource, clamp(p + uStep * i, ivec2(0), size - 1), 0).rgb * W[i];
    sum += texelFetch(uSource, clamp(p - uStep * i, ivec2(0), size - 1), 0).rgb * W[i];
  }
  outColour = vec4(sum, 1.0);
}`}class et{constructor(t,e){this.renderer=t,this.float=e}levels=[];size=[0,0];make(t,e){this.release();const{gl:s}=this.renderer;let o=t,i=e;for(let a=0;a<lo;++a){o=Math.max(1,Math.ceil(o/2)),i=Math.max(1,Math.ceil(i/2));const r=[],l=[];for(let h=0;h<2;++h){const c=s.createTexture();s.bindTexture(s.TEXTURE_2D,c),this.float?s.texImage2D(s.TEXTURE_2D,0,s.RGBA16F,o,i,0,s.RGBA,s.HALF_FLOAT,null):s.texImage2D(s.TEXTURE_2D,0,s.RGBA8,o,i,0,s.RGBA,s.UNSIGNED_BYTE,null),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_S,s.CLAMP_TO_EDGE),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_T,s.CLAMP_TO_EDGE);const u=s.createFramebuffer();s.bindFramebuffer(s.FRAMEBUFFER,u),s.framebufferTexture2D(s.FRAMEBUFFER,s.COLOR_ATTACHMENT0,s.TEXTURE_2D,c,0),r.push(c),l.push(u)}this.levels.push({size:[o,i],textures:r,framebuffers:l})}s.bindTexture(s.TEXTURE_2D,null),this.size=[t,e]}run(t,e,s,o){const{renderer:i}=this,{gl:a}=i;(this.size[0]!==e||this.size[1]!==s||this.levels.length===0)&&this.make(e,s),a.disable(a.BLEND),a.disable(a.DEPTH_TEST),a.disable(a.STENCIL_TEST),a.disable(a.SCISSOR_TEST),a.depthMask(!1);let r=t;for(let l=0;l<this.levels.length;++l){const h=this.levels[l];if(a.bindFramebuffer(a.FRAMEBUFFER,h.framebuffers[0]),a.drawBuffers([a.COLOR_ATTACHMENT0]),a.checkFramebufferStatus(a.FRAMEBUFFER)!==a.FRAMEBUFFER_COMPLETE)return;a.viewport(0,0,h.size[0],h.size[1]),i.fullScreen(`bloom-down|${l===0}`,$e,fo(l===0),{uSource:r},{},{uEmission:o?1:0}),a.bindFramebuffer(a.FRAMEBUFFER,h.framebuffers[1]),a.drawBuffers([a.COLOR_ATTACHMENT0]),i.fullScreen("bloom-blur",$e,Et(),{uSource:h.textures[0]},{uStep:[1,0]}),a.bindFramebuffer(a.FRAMEBUFFER,h.framebuffers[0]),i.fullScreen("bloom-blur",$e,Et(),{uSource:h.textures[1]},{uStep:[0,1]}),r=h.textures[0]}return this.levels.map(l=>l.textures[0])}release(){const{gl:t}=this.renderer;for(const e of this.levels)e.textures.forEach(s=>t.deleteTexture(s)),e.framebuffers.forEach(s=>t.deleteFramebuffer(s));this.levels=[],this.size=[0,0]}}const mo=1e3;class qt{constructor(t,e,s=()=>performance.now()){this.name=t,this.limit=e,this.now=s}members=new Set;refusals=0;add(t){this.members.add(t)}remove(t){this.members.delete(t)}get total(){let t=0;for(const e of this.members)t+=e.gpuBytes;return t}get size(){return this.members.size}reserve(t,e,s){if(this.total+e<=this.limit||(s(this.limit-e),this.total+e<=this.limit))return!0;const o=this.now(),i=[...this.members].filter(a=>a!==t&&a.gpuBytes>0&&o-a.lastDrawn>mo).sort((a,r)=>a.lastDrawn-r.lastDrawn);for(const a of i)if(a.evict(),this.total+e<=this.limit)return!0;return++this.refusals,!1}}const Tt=new qt("3-D",1024*1024*1024),vo=`#version 300 es
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
}`,po=`#version 300 es
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

${zt}

void main() {
  float power = -0.5 * (vInvCov.x * vOffset.x * vOffset.x + 2.0 * vInvCov.y * vOffset.x * vOffset.y + vInvCov.z * vOffset.y * vOffset.y);
  if (power < -4.5) discard;
  float g = exp(power) * vWeight;
  vec3 colour = uOneColour ? uColour : colormap(uColormap, vColourAt);
  // Light, and (for emission and absorption) optical depth.
  outLight = vec4(colour * g * uGain, g * uAbsorption);
}`;class Yt{constructor(t){this.gl=t;const e=(o,i)=>{const a=t.createShader(o);if(t.shaderSource(a,i),t.compileShader(a),!t.getShaderParameter(a,t.COMPILE_STATUS))throw new Error(t.getShaderInfoLog(a)??"the splat shader did not compile");return a},s=t.createProgram();if(t.attachShader(s,e(t.VERTEX_SHADER,vo)),t.attachShader(s,e(t.FRAGMENT_SHADER,po)),t.linkProgram(s),!t.getProgramParameter(s,t.LINK_STATUS))throw new Error(t.getProgramInfoLog(s)??"the splat program did not link");this.program=s}program;uniforms=new Map;u(t){return this.uniforms.has(t)||this.uniforms.set(t,this.gl.getUniformLocation(this.program,t)),this.uniforms.get(t)}upload(t,e,s){const{gl:o}=this,i=s.length,a=new Float32Array(10*i);for(let c=0;c<i;++c)a.set(t.subarray(3*c,3*c+3),10*c),a.set(e.subarray(6*c,6*c+6),10*c+3),a[10*c+9]=s[c];const r=o.createVertexArray(),l=o.createBuffer();o.bindVertexArray(r),o.bindBuffer(o.ARRAY_BUFFER,l),o.bufferData(o.ARRAY_BUFFER,a,o.STATIC_DRAW);const h=(c,u,m)=>{o.enableVertexAttribArray(c),o.vertexAttribPointer(c,u,o.FLOAT,!1,40,m),o.vertexAttribDivisor(c,1)};return h(0,3,0),h(1,3,12),h(2,3,24),h(3,1,36),o.bindVertexArray(null),o.bindBuffer(o.ARRAY_BUFFER,null),{vao:r,buffer:l,count:i,bytes:a.byteLength}}release(t){this.gl.deleteVertexArray(t.vao),this.gl.deleteBuffer(t.buffer)}draw(t,e){const{gl:s}=this;s.useProgram(this.program),s.uniformMatrix4fv(this.u("uModelToClip"),!1,e.modelToClip),s.uniform2fv(this.u("uViewport"),e.viewport),s.uniform1f(this.u("uGain"),e.gain),s.uniform1f(this.u("uAbsorption"),e.absorption),s.uniform1i(this.u("uColormap"),e.colormap),s.uniform1i(this.u("uOneColour"),e.colour?1:0),s.uniform3fv(this.u("uColour"),e.colour??[1,1,1]),s.uniform1i(this.u("uSection"),e.plane?1:0),s.uniform4fv(this.u("uPlane"),e.plane??[0,0,0,0]),s.uniform1f(this.u("uWiden"),e.widen??1);for(const o of t)s.bindVertexArray(o.vao),s.drawArraysInstanced(s.TRIANGLE_STRIP,0,4,o.count);s.bindVertexArray(null)}dispose(){this.gl.deleteProgram(this.program)}}const go=768*1024*1024;class Oe{canvas;pool=new qt("2-D",go);gl=null;parts;splatRenderer;epoch=0;lost=!1;problem;restored=new Set;users=0;constructor(){this.canvas=document.createElement("canvas"),this.canvas.addEventListener("webglcontextlost",t=>{t.preventDefault(),this.lost=!0,++this.epoch,this.parts=void 0,this.splatRenderer=void 0}),this.canvas.addEventListener("webglcontextrestored",()=>{this.lost=!1;for(const t of[...this.restored])t()})}context(){if(this.lost)return;if(this.gl===null&&(this.gl=this.canvas.getContext("webgl2",{alpha:!0,premultipliedAlpha:!0,antialias:!1,depth:!0,stencil:!1}),this.gl===null)){this.problem="No WebGL2 for the 2-D views.";return}const t=this.gl;if(this.parts===void 0){const e=new Ye(t);this.parts={renderer:e,target:new Je(t,e.floatTargets),bloom:new et(e,e.floatTargets)}}return{gl:t,canvas:this.canvas,...this.parts,splats:()=>this.splatRenderer??=new Yt(t)}}onRestored(t){return this.restored.add(t),()=>this.restored.delete(t)}get layers(){return this.users}get hasContext(){return this.gl!==null}acquired(){++this.users}released(){--this.users>0||(this.parts?.target.release(),this.parts?.bloom.release(),this.parts?.renderer.dispose(),this.splatRenderer?.dispose(),this.parts=void 0,this.splatRenderer=void 0,this.gl?.getExtension("WEBGL_lose_context")?.loseContext(),this.gl=null,me===this&&(me=void 0))}static acquire(){return me??=new Oe,me.acquired(),me}release(){this.released()}}let me;function Jt(n,t){(n.width!==t.width||n.height!==t.height)&&(n.width=t.width,n.height=t.height);const e=n.getContext("2d");e!==null&&(e.clearRect(0,0,n.width,n.height),e.drawImage(t,0,0))}const wo=512*1024*1024,bo=384*1024*1024;class yo{constructor(t){this.view=t,this.overlay=t.ctx.ui.overlay(),this.canvas=document.createElement("canvas"),this.canvas.className="luxar-canvas",this.overlay.element.append(this.canvas),this.offRendered=t.ctx.viewer.onRendered(()=>this.schedule()),this.offScreenshot=t.ctx.ui.screenshotOverlay((e,s)=>this.paint(e,s)),this.offRestored=this.shared.onRestored(()=>{this.signature="",this.schedule()})}overlay;canvas;shared=Oe.acquire();epoch=-1;chunks;sets;queued=!1;visible=!0;shows=!1;offRendered;offScreenshot;offRestored;problem;selections=[];signature="";drawnStyle;more=!1;wasFull=!1;setVisible(t){this.visible=t,this.canvas.style.display=t?"":"none",this.schedule()}schedule(){this.queued||(this.queued=!0,requestAnimationFrame(()=>{if(this.queued=!1,!this.disposed)try{this.render()}catch(t){this.problem=`2-D views: ${t.message}`}}))}context(){const t=this.shared.context();if(this.epoch!==this.shared.epoch&&(this.chunks?.forget(),this.sets?.forget(),this.chunks=this.sets=void 0,this.epoch=this.shared.epoch),t===void 0){this.problem=this.shared.lost?void 0:this.shared.problem;return}return this.chunks??=new _e(t.renderer,this.view.client,wo,this.shared.pool),t}get full(){return(this.chunks?.refused??!1)||(this.sets?.refused??!1)}clear(){this.shows&&(this.canvas.getContext("2d")?.clearRect(0,0,this.canvas.width,this.canvas.height),this.shows=!1,this.signature="")}panelMatrices(t,e,s,o,i){const a=this.view.transform();if(a===void 0)return;const r=Ot(d=>t.project(d),e.position);if(r===void 0)return;let l=0;e.names.forEach((d,f)=>{const v=e.units[f]==="m"?e.scales[f]*1e3:e.scales[f];l+=(r[2][f]/v)**2});const h=l>0?1/Math.sqrt(l):0,c=ns(a,e.names,r),u=new Float64Array(16);u[0]=2/s,u[12]=-1,u[5]=-2/o,u[13]=1,u[10]=h>0?.999*h/i:0,u[15]=1;const m=W(u,c),w=[c[2]*h,c[6]*h,c[10]*h,c[14]*h],A=Me(c),p=A?Fe(A,[s/2,o/2,0]):[0,0,0];return{modelToClip:m,plane:w,centre:p,slab:h>0?i:0}}render(){const{view:t}=this,e=t.client.info,s=this.visible?t.ctx.viewer.panels().filter(f=>f.kind==="2d"):[],o=s.length>0&&e!==void 0?this.context():void 0;if(o===void 0){this.clear();return}const i=this.overlay.element.getBoundingClientRect(),a=globalThis.devicePixelRatio||1,r=Math.max(1,Math.round(i.width*a)),l=Math.max(1,Math.round(i.height*a)),h=t.style;this.canvas.style.mixBlendMode=h.blending==="glow"||h.blending==="glow-through"?"plus-lighter":"normal";const c=t.ctx.viewer.getState(),u=c.dimensions??{},m=Object.keys(u),w={names:m,scales:m.map(f=>u[f][0]),units:m.map(f=>u[f][1]),position:m.map((f,v)=>c.position?.[v]??0)},A=e===void 0?0:Ht(h,Ve(e))/2,p=s.flatMap(f=>{const v=f.element.getBoundingClientRect();if(v.width<2||v.height<2)return[];const b=this.panelMatrices(f,w,v.width,v.height,A);return b===void 0?[]:[{rect:v,m:b}]}),d=JSON.stringify([r,l,t.client.arrivals,t.client.generation,t.client.objects.arrivals,t.client.objects.generation,t.drawing().version,t.held,t.budget("2d"),e===void 0,p.map(({rect:f,m:v})=>[f.left,f.top,f.width,f.height,Array.from(v.modelToClip,b=>+b.toPrecision(9))])]);if(!(d===this.signature&&h===this.drawnStyle&&!this.more)){this.signature=d,this.drawnStyle=h,this.problem=void 0,(o.canvas.width!==r||o.canvas.height!==l)&&(o.canvas.width=r,o.canvas.height=l);try{this.draw(o,r,l,i,a,p)}finally{Jt(this.canvas,o.canvas),this.shows=!0}}}draw(t,e,s,o,i,a){const{view:r}=this,{gl:l}=t,h=r.client.info,c=r.style;if(l.bindFramebuffer(l.FRAMEBUFFER,null),l.viewport(0,0,e,s),l.clearColor(0,0,0,0),l.clearDepth(1),l.clear(l.COLOR_BUFFER_BIT|l.DEPTH_BUFFER_BIT),h===void 0||a.length===0)return;const u=c.blending==="solid",{renderer:m,target:w,bloom:A}=t,p=this.chunks;if(!u&&!w.bind(e,s,null)){this.problem="This GPU cannot add light up in a float target here.";return}l.viewport(0,0,e,s),l.clearColor(0,0,0,0),l.clear(l.COLOR_BUFFER_BIT),l.enable(l.SCISSOR_TEST),u?(l.enable(l.DEPTH_TEST),l.depthFunc(l.LESS),l.depthMask(!0),l.disable(l.BLEND)):(l.disable(l.DEPTH_TEST),l.enable(l.BLEND),l.blendFunc(l.ONE,l.ONE));const d=[];let f=!1;const v=[],b=r.budget("2d"),y=[],R=r.drawing();let T=[],E=oe;if(R.sets!==void 0){this.sets??=new _e(m,r.client.objects,bo,this.shared.pool);const x=this.sets.take(r.client.objects.drawn(),R.sets);T=x.chunks,f||=x.more}a.forEach(({rect:x,m:g})=>{let _=[],M=1;if(R.chunks!==void 0){const P=Be(h,(I,re)=>ce(g.modelToClip,I,re),g.centre,b,I=>p.arrived(I));d.push(P),v.push(P.want);const k=p.take(P.draw,R.chunks);f||=k.more,_=k.chunks,y.push(..._);const $=h.levels[P.level].chunkShape;M=g.slab>0?Math.min(1,2*g.slab/(($[0]+$[1]+$[2])/3)):1}if(r.held||_.length===0&&T.length===0)return;const F=Math.round((x.left-o.left)*i),O=Math.round((o.bottom-x.bottom)*i),B=Math.round(x.width*i),N=Math.round(x.height*i);l.viewport(F,O,B,N),l.scissor(F,O,B,N);const D=Dt(g.modelToClip,g.centre,[B,N]),j=kt(g.modelToClip,h.bounds.lower,h.bounds.upper,[B,N]),V=(P,k)=>ce(g.modelToClip,P,k),G=Math.min(...h.levels[0].chunkShape)/(2*(h.levels[0].group??1)),L=g.slab>0?Math.min(1,2*g.slab/G):1,q=T.length>0?Lt(T,V,c.detail*1e6/L):oe;E=Math.min(E,q);const Y=T.reduce((P,k)=>{const $=(k.upper[0]-k.lower[0]+k.upper[1]-k.lower[1]+k.upper[2]-k.lower[2])/3,I=g.slab>0&&$>0?Math.min(1,2*g.slab/$):1;return P+Ce([k],D,2*r.halfWidth,j,I*q/oe)},0),H=Ce(_,D,2*r.halfWidth,j,M),J=u?"solid":"accumulate",K=Float32Array.from(g.modelToClip);for(const[P,k,$]of[[_,H+Y,void 0],[T,Y,V]]){if(P.length===0)continue;const I=r.uniforms(K,[B,N],k);I.plane=g.plane,I.slab=g.slab,m.draw(P,J,{color:0},I,$,q)}}),r.reportSamples("2d",E),l.disable(l.SCISSOR_TEST);const S=[],C=new Set;for(let x=0;v.some(g=>x<g.length);++x)for(const g of v){const _=g[x];_!==void 0&&!C.has(_)&&(C.add(_),S.push(_))}if(r.client.want("2d",S),y.length>0&&r.reportShare("2d",It(y)),this.selections=d,d.length>0){const x=d.reduce((g,_)=>g.level<=_.level?g:_);r.reportLevel("2d",{...x,complete:d.every(g=>g.complete)})}if(!u){const x=c.blending==="emission",g=c.bloom>0?A.run(w.texture,e,s,x):void 0;l.bindFramebuffer(l.FRAMEBUFFER,null),l.viewport(0,0,e,s),l.enable(l.BLEND),x?l.blendFunc(l.ONE,l.ONE_MINUS_SRC_ALPHA):l.blendFunc(l.ONE,l.ONE),m.composite(w.texture,{color:0},{toneMap:r.toneIndex,emission:x,origin:[0,0],bloom:g&&{textures:g,amount:c.bloom}}),l.disable(l.BLEND)}this.more=f,f&&this.schedule(),this.full!==this.wasFull&&(this.wasFull=this.full,r.onStatus?.())}paint(t,e){if(!this.visible||!this.shows)return;const s=e.getBoundingClientRect(),o=e.width/Math.max(1,s.width),i=this.overlay.element.getBoundingClientRect();t.save(),t.globalCompositeOperation=this.canvas.style.mixBlendMode==="plus-lighter"?"lighter":"source-over",t.drawImage(this.canvas,(i.left-s.left)*o,(i.top-s.top)*o,i.width*o,i.height*o),t.restore()}disposed=!1;dispose(){this.disposed=!0,this.offScreenshot(),this.offRendered(),this.offRestored(),this.epoch===this.shared.epoch&&!this.shared.lost?(this.chunks?.dispose(),this.sets?.dispose()):(this.chunks?.forget(),this.sets?.forget()),this.chunks=this.sets=void 0,this.overlay.dispose(),this.shared.release()}}const Eo=768*1024*1024,To=512*1024*1024,xt="This GPU cannot add light up in a float target here: drawing solid lines instead.";class xo{constructor(t){this.view=t}renderer;chunks;sets;target;nearest;front;bloom;broken=!1;selection;problem;isReady(){return(this.selection===void 0||this.selection.complete)&&this.view.objectsReady}save(t){const e=[];for(let s=0;s<4;++s)e.push(t.getParameter(t.DRAW_BUFFER0+s));for(;e.length>1&&e[e.length-1]===t.NONE;)e.pop();return{framebuffer:t.getParameter(t.DRAW_FRAMEBUFFER_BINDING),viewport:t.getParameter(t.VIEWPORT),blend:t.isEnabled(t.BLEND),depthTest:t.isEnabled(t.DEPTH_TEST),depthMask:t.getParameter(t.DEPTH_WRITEMASK),depthFunc:t.getParameter(t.DEPTH_FUNC),stencil:t.isEnabled(t.STENCIL_TEST),scissor:t.isEnabled(t.SCISSOR_TEST),drawBuffers:e}}restore(t,e){t.bindFramebuffer(t.FRAMEBUFFER,e.framebuffer),t.drawBuffers(e.drawBuffers),t.viewport(e.viewport[0],e.viewport[1],e.viewport[2],e.viewport[3]),e.blend?t.enable(t.BLEND):t.disable(t.BLEND),e.depthTest?t.enable(t.DEPTH_TEST):t.disable(t.DEPTH_TEST),t.depthMask(e.depthMask),t.depthFunc(e.depthFunc),e.stencil?t.enable(t.STENCIL_TEST):t.disable(t.STENCIL_TEST),e.scissor?t.enable(t.SCISSOR_TEST):t.disable(t.SCISSOR_TEST),t.blendFunc(t.ONE,t.ZERO),t.activeTexture(t.TEXTURE0)}draw(t){if(!(this.failed!==void 0&&this.renderer?.gl===t.gl)){this.failed=void 0;try{this.drawNow(t)}catch(e){this.failed=`The 3-D view could not draw this layer: ${e.message}`,this.problem=this.failed}}}failed;wasFull=!1;drawNow(t){const{gl:e}=t,{view:s}=this;this.renderer?.gl!==e&&(this.dispose(),this.renderer=new Ye(e),this.target=new Je(e,this.renderer.floatTargets),this.nearest=new vt(e),this.front=new vt(e),this.bloom=new et(this.renderer,this.renderer.floatTargets));const o=s.client.info,i=s.transform();if(o===void 0||i===void 0)return;const a=as(i,t.dimensions.names);if(a===void 0){this.problem=`The 3-D view shows ${t.dimensions.names.join(", ")}, which this layer does not have.`;return}this.problem=this.broken?xt:void 0,this.chunks??=new _e(this.renderer,s.client,Eo,Tt),this.sets??=new _e(this.renderer,s.client.objects,To,Tt);const r=this.chunks,l=W(t.viewProjection,a),h=Me(a),c=h?Fe(h,t.position):[0,0,0],u=s.style,m=s.drawing();let w=[],A=!1;if(m.chunks!==void 0){const B=Be(o,(N,D)=>ce(l,N,D),c,s.budget("3d"),N=>r.arrived(N));this.selection=B,s.client.want("3d",B.want),{chunks:w,more:A}=r.take(B.draw,m.chunks),s.reportLevel("3d",B),w.length>0&&s.reportShare("3d",It(w))}else this.selection=void 0,s.client.want("3d",[]);let p=[];if(m.sets!==void 0){const B=this.sets.take(s.client.objects.drawn(),m.sets);p=B.chunks,A||=B.more}if(A&&s.redraw(),this.full!==this.wasFull&&(this.wasFull=this.full,s.onStatus?.()),s.held||w.length===0&&p.length===0)return;const d=this.save(e),f=[d.viewport[2],d.viewport[3]],v=Dt(l,c,f),b=kt(l,o.bounds.lower,o.bounds.upper,f),y=(B,N)=>ce(l,B,N),R=Lt(p,y,u.detail*1e6);s.reportSamples("3d",p.length>0?R:oe);const T=u.blending==="glow"||u.blending==="glow-through",E=[...w,...p].some(B=>B.triangleCount>0),S=T&&E&&u.glowDepth>0,C=Ce(p,v,2*s.halfWidth,b,R/oe,!S),x=Ce(w,v,2*s.halfWidth,b,1,!S),g=Float32Array.from(l),_=s.uniforms(g,f,x+C),M=s.uniforms(g,f,C);_.eye=M.eye=ls(l);const F=this.renderer,O=(B,N,D={})=>{w.length>0&&F.draw(w,B,N,{..._,...D}),p.length>0&&F.draw(p,B,N,{...M,...D},y,R)};try{if(u.blending==="solid"||this.broken){e.disable(e.BLEND),e.enable(e.DEPTH_TEST),e.depthMask(!0),O("solid",t.outputs);return}const B=e.getFramebufferAttachmentParameter(e.DRAW_FRAMEBUFFER,e.DEPTH_STENCIL_ATTACHMENT,e.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME)??null,[,,N,D]=d.viewport;if(!this.target.bind(N,D,B)){this.broken=!0,this.problem=xt;return}const j=S?cs(l):void 0;j!==void 0&&this.front.bind(N,D)&&(e.viewport(0,0,N,D),e.disable(e.STENCIL_TEST),e.disable(e.BLEND),e.enable(e.DEPTH_TEST),e.depthFunc(e.LESS),O("depth",{color:0},{depthNear:!1}),_.front=M.front={texture:this.front.texture,clipToModel:Float32Array.from(j),falloff:hs(o.bounds.lower,o.bounds.upper,u.glowDepth)},this.target.bind(N,D,B)),e.viewport(0,0,N,D),e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT),e.disable(e.STENCIL_TEST),e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE),e.depthMask(!1);const V=u.blending==="glow-through";V?e.disable(e.DEPTH_TEST):(e.enable(e.DEPTH_TEST),e.depthFunc(e.LEQUAL)),O("accumulate",{color:0});const G=this.nearest;G.bind(N,D)&&(e.disable(e.BLEND),e.enable(e.DEPTH_TEST),e.depthFunc(e.LESS),O("depth",{color:0},{depthCut:.05,depthNear:!1}));const L=u.blending==="emission",q=u.bloom>0?this.bloom.run(this.target.texture,N,D,L):void 0;e.enable(e.BLEND),e.bindFramebuffer(e.FRAMEBUFFER,d.framebuffer),e.viewport(d.viewport[0],d.viewport[1],N,D);const Y=H=>d.drawBuffers.map((J,K)=>K===H?J:e.NONE);e.drawBuffers(Y(t.outputs.color)),e.disable(e.DEPTH_TEST),L?e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA):e.blendFuncSeparate(e.ONE,e.ONE,e.ONE,e.ONE_MINUS_SRC_ALPHA),F.composite(this.target.texture,t.outputs,{toneMap:s.toneIndex,emission:L,origin:[d.viewport[0],d.viewport[1]],bloom:q&&{textures:q,amount:u.bloom}}),G.texture!==void 0&&(e.drawBuffers(d.drawBuffers.map((H,J)=>J===t.outputs.color?e.NONE:H)),e.disable(e.BLEND),e.enable(e.DEPTH_TEST),e.depthFunc(e.LESS),e.depthMask(!0),d.stencil&&e.enable(e.STENCIL_TEST),F.composite(this.target.texture,t.outputs,{toneMap:s.toneIndex,emission:L,origin:[d.viewport[0],d.viewport[1]],depth:{texture:G.texture,cut:.15,near:V}}))}finally{this.restore(e,d)}}get full(){return(this.chunks?.refused??!1)||(this.sets?.refused??!1)}dispose(){this.chunks?.dispose(),this.sets?.dispose(),this.sets=void 0,this.target?.release(),this.nearest?.release(),this.nearest=void 0,this.front?.release(),this.front=void 0,this.bloom?.release(),this.bloom=void 0,this.renderer?.dispose(),this.chunks=void 0,this.target=void 0,this.renderer=void 0}}let St=0;const So=100;class z{constructor(t,e,s,o,i={}){this.ctx=t,this.name=e,this.storeUrl=s,this.style=o,this.headers=i.headers??[],this.client=new us(s,{adopt:i.adopt?.client,headers:this.headers}),this.client.setScalar(xe(this.drawnStyle(o),this.look)),this.view3d=new xo(this),this.view2d=new yo(this),this.handle=t.viewer.draw3d(e,{draw:a=>this.view3d.draw(a),isReady:()=>this.view3d.isReady(),afterSections:!0,dispose:()=>this.view3d.dispose()}),this.offs.push(t.viewer.onSegmentsChanged(e,()=>{this.frozen||(this.current=void 0,this.colours.clear(),this.redraw(),this.onStatus?.())})),this.client.onChunk=()=>{this.redraw(),this.statusSoon()},this.client.ready.then(()=>{this.disposed||(this.client.setScalar(xe(this.drawnStyle(this.style),this.look)),this.redraw(),this.onStatus?.())},()=>{this.disposed||this.onStatus?.()})}client;handle;view3d;view2d;levels=new Map;transformCache;offs=[];current;colours=new Map;look;lut;shares=new Map;samples=new Map;onStatus;held=!1;frozen=!1;disposed=!1;headers;chosen;setStyle(t){this.style=t,this.client.setScalar(xe(this.drawnStyle(t),this.look)),this.redraw()}setLook(t){JSON.stringify(t)!==JSON.stringify(this.look)&&(this.look=t,this.style.colourBy==="layer"&&(this.client.setScalar(xe(this.drawnStyle(this.style),t)),this.current=void 0,this.redraw(),this.onStatus?.()))}layerLook(){return this.style.colourBy==="layer"?this.look:void 0}drawnStyle(t){if(t.colourBy!=="attribute"||t.attribute!==void 0)return t;const e=this.client.info?.attributes[0]?.id;return e===void 0?t:{...t,attribute:e}}transform(){const t=performance.now();return(this.transformCache===void 0||t-this.transformCache.at>8)&&(this.transformCache={at:t,value:this.ctx.viewer.layerTransform(this.name)}),this.transformCache.value}redraw(){this.transformCache=void 0,this.handle.redraw(),this.view2d.schedule()}drawing(){const t=this.layerLook(),e=t?.by==="group"?t.group:void 0,s=this.style.colourBy==="segment"||this.style.colourBy==="layer"&&t===void 0,o=this.client.objects.measured(),i=`${s}|${this.style.detail}|${this.client.scalarName}|${this.client.info!==void 0}|${o!==void 0}|${e===void 0?"":JSON.stringify(e)}`;if(this.current!==void 0&&(this.current.key===i||this.frozen))return this.chosen?.drawing===this.current&&(this.chosen.at=performance.now()),this.current;if(e!==void 0){const y=e.shown===void 0?void 0:new Set(e.shown),R=e.colours==="stored"&&e.colorAttribute!==void 0,T={version:++St,all:y===void 0,has:E=>y===void 0||y.has(Number(E)),colour:R?void 0:E=>Qt(Number(E)),slotColours:R,chosenAlpha:1,othersAlpha:0};return this.client.objects.want(void 0,void 0,this.client.scalarName),this.current={key:i,version:T.version,chunks:T,sets:void 0,size:0,plan:void 0,others:0,table:!0},this.current}const a=this.ctx.viewer.visibleSegments(this.name),{ctx:r,name:l,colours:h,client:c}=this,u=y=>{let R=h.get(y);return R===void 0&&(R=r.viewer.segmentColour(l,y)??[1,1,1],h.set(y,R)),R},m=a===void 0||a.all,w=m?0:a.size,A=m?0:Math.min(1,Math.max(0,a.notSelectedAlpha??0)),p=m||c.info===void 0?void 0:ds(c.info,w,c.scalarName,this.style.detail,o),d={version:++St,all:m,has:y=>a===void 0||a.has(y),colour:s?u:void 0},f=p===void 0?{...d,chosenAlpha:1,othersAlpha:A}:A>0?{...d,chosenAlpha:0,othersAlpha:A}:void 0,v=p===void 0?void 0:{...d,chosenAlpha:1,othersAlpha:0},b=p===void 0?void 0:a?.ids();return c.objects.want(b,p,c.scalarName),f===void 0&&this.levels.clear(),this.current={key:i,version:d.version,chunks:f,sets:v,size:w,plan:p,others:A,table:f===void 0||Pt(f)},w>0&&(this.chosen={drawing:this.current,ids:b,at:performance.now()}),this.current}freeze(){const t=this.chosen;this.current?.size===0&&t!==void 0&&performance.now()-t.at<3e3&&(this.current=t.drawing,this.client.objects.want(t.ids,t.drawing.plan,this.client.scalarName),this.levels.clear()),this.frozen=!0,this.redraw()}get objectsShown(){return this.drawing().plan===void 0?void 0:this.client.objects.progress().read}get ready(){if(this.client.info===void 0||!this.objectsReady)return!1;if(this.drawing().chunks===void 0)return!0;const t=[...this.levels.values()];return t.length>0&&t.every(e=>e.complete)}get toneIndex(){return Qe[this.style.toneMap]}get halfWidth(){return this.style.width*(globalThis.devicePixelRatio||1)/2}uniforms(t,e,s){const{style:o}=this,i=this.transform(),a=o.autoBrightness?fs(s):1,r=2**o.exposure*a;let l=o.range??this.client.valueRange??[0,1],h=bt[o.colourBy],c=Ze[o.colormap],u,m=!1;const w=this.layerLook();if(w?.by==="attribute"){const A=w.colormap??"viridis";this.lut?.id!==A&&(this.lut={id:A,table:Float32Array.from((it(A,be)??it("viridis",be)).flat())});const[p,d]=w.range??this.client.valueRange??[0,1];l=[w.low??p,w.high??d],h=bt.attribute,c=$t,u=this.lut.table,m=w.hideOutside===!0}return{modelToClip:t,directions:i?ms(i):new Float32Array([1,0,0,0,1,0,0,0,1]),viewport:e,halfWidth:this.halfWidth,sharpness:o.sharpness,colourBy:h,colour:Ke(o.colour),colormap:c,range:l,lut:u,hideOutside:m,gain:r,absorption:o.blending==="emission"?o.absorption*a:0,plane:[0,0,0,0],slab:0,depthCut:.3,depthNear:!1,objectTable:this.drawing().table,eye:[0,0,1,0]}}budget(t){const e=this.drawing().chunks,s=this.shares.get(t);return Ie(this.style.detail,e===void 0||e.all||s?.version!==e.version?1:s.share)}reportShare(t,e){const{version:s}=this.drawing(),o=this.shares.get(t),i=o?.version===s?o.share:1;e>=i||(this.shares.set(t,{version:s,share:e}),Ie(1,e)>1.01*Ie(1,i)&&this.redraw())}reportSamples(t,e){this.samples.get(t)!==e&&(this.samples.set(t,e),this.onStatus?.())}reportLevel(t,e){const s=this.levels.get(t);this.levels.set(t,e),(s===void 0||s.level!==e.level||s.complete!==e.complete)&&this.onStatus?.()}report(){const{client:t}=this;if(t.error!==void 0&&t.signIn)return{error:"Sign in to read this layer's meshes.",signIn:!0};if(t.error!==void 0&&t.info===void 0)return{error:`Could not open the store: ${t.error}`};if(t.info===void 0)return{progress:"Opening the store…"};const e=this.view3d.problem??this.view2d.problem;if(e!==void 0)return{error:e};if(t.objects.error!==void 0)return{error:`Could not read the chosen objects: ${t.objects.error}`};if(t.error!==void 0)return{error:`Could not read a chunk: ${t.error}`};if(this.view3d.full||this.view2d.full)return{warning:"GPU memory is full: part of this layer is not drawn. Lower its Detail, or switch off another layer."};if(this.drawing().plan!==void 0){const o=t.objects.progress();if(o.pending>0)return{progress:`Reading the chosen objects: ${o.read.toLocaleString("en-GB")} of ${(o.wanted-o.absent).toLocaleString("en-GB")}…`}}return t.pending>0||[...this.levels.values()].some(o=>!o.complete)?{progress:"Reading…"}:{}}get objectsReady(){return this.drawing().plan===void 0||!this.client.objects.busy}setVisible(t){this.view2d.setVisible(t)}statusSoon(){this.statusTimer===void 0&&(this.statusTimer=setTimeout(()=>{this.statusTimer=void 0,this.disposed||this.onStatus?.()},So))}statusTimer;dispose(){clearTimeout(this.statusTimer),this.statusTimer=void 0,this.disposed=!0,this.offs.forEach(t=>t()),this.handle.dispose(),this.view2d.dispose(),this.client.dispose()}}const Ao="auth_token_v2_";function Ro(){let n;try{n=globalThis.localStorage}catch{n=void 0}return{fetch:(t,e)=>fetch(t,e),storage:n}}function _o(n){try{const t=new URL(n.replace(/^middleauth\+/,""));return`${t.origin}${t.pathname}`.replace(/\/+$/,"")}catch{return}}async function At(n,t=Ro()){if(n===void 0||n.kind==="google")return[];try{if(n.kind==="middleauth"){const i=await t.fetch(`${n.app}/auth_info`);if(!i.ok)return[];const a=_o(String((await i.json())?.login_url??"")),r=a===void 0?null:t.storage?.getItem(Ao+a)??null,l=r===null?void 0:JSON.parse(r);return typeof l?.accessToken!="string"?[]:[{prefix:`${n.app}/`,value:`${l.tokenType??"Bearer"} ${l.accessToken}`}]}const e=await t.fetch(`${n.server}/token`,{method:"POST",credentials:"include"});if(!e.ok)return[];const s=await e.text();let o=s.trim();try{const i=JSON.parse(s);typeof i?.token=="string"&&(o=i.token)}catch{}return o===""?[]:[{prefix:`https://storage.googleapis.com/${n.bucket}/`,value:`Bearer ${o}`}]}catch{return[]}}function Co(n,t){const[e,s,o]=t;let i=0,a=0;for(let r=0;r<o;++r)for(let l=0;l<s;++l){const h=(r*s+l)*e;if(r===0||r===o-1||l===0||l===s-1){for(let c=0;c<e;++c)i+=n[h+c];a+=e}else i+=n[h]+n[h+e-1],a+=2}return a===0?255:i/a}function Mo(n){const t=new Float64Array(16);t[15]=1;for(let e=0;e<3;++e){const s=["x","y","z"].indexOf(n.names[e]);if(s===-1)return;const i=n.units[e]==="m"?.001:1;t[4*e+s]=i/n.scales[e]}return t}function Fo(n){return new Worker(new URL(""+new URL("async_worker-DwUM6Gbe.js",import.meta.url).href,import.meta.url),{type:"module",name:As(n)})}const Bo={meter:1e3,m:1e3,centimeter:10,cm:10,millimeter:1,mm:1,micrometer:.001,um:.001,µm:.001,micron:.001,nanometer:1e-6,nm:1e-6,angstrom:1e-7,Å:1e-7,Å:1e-7},Rt=["x","y","z"],Z=n=>typeof n=="string"?n:n?.name;function ae(n,t){const s=Array.from({length:t+1},(o,i)=>Array.from({length:t+1},(a,r)=>i===r?1:0));switch(n.type){case"identity":return s;case"scale":return n.scale.forEach((o,i)=>s[i][i]=o),s;case"translation":return n.translation.forEach((o,i)=>s[i][t]=o),s;case"affine":{const o=Array.isArray(n.affine[0])?n.affine:No(n.affine,t+1);for(let i=0;i<t;++i)for(let a=0;a<=t;++a)s[i][a]=o[i][a];return s}case"sequence":return(n.transformations??[]).reduce((o,i)=>se(ae(i,t),o),s);default:throw new Error(`unsupported coordinate transform "${n.type}"`)}}function No(n,t){const e=[];for(let s=0;s<n.length;s+=t)e.push(n.slice(s,s+t));return e}function se(n,t){return n.map(e=>t[0].map((s,o)=>e.reduce((i,a,r)=>i+a*t[r][o],0)))}function Oo(n,t,e){const s=t?.attributes??t??{},i=(s.ome??s)?.multiscales?.[0];if(i===void 0)throw new Error(`${n}: not an OME-Zarr image (no multiscales)`);const a=i.coordinateSystems??[],r=i.datasets??[];if(r.length===0)throw new Error(`${n}: the image has no datasets`);const l=Z(r[0].coordinateTransformations?.[0]?.output),h=a.find(g=>g.name===l)??a[0],c=h?.axes??i.axes??[],u=c.length;if(u===0)throw new Error(`${n}: the image names no axes`);const m=c.filter(g=>Rt.includes(g.name)),w=c.filter(g=>!Rt.includes(g.name));if(m.length!==3||new Set(m.map(g=>g.name)).size!==3||w.some(g=>g.type==="space"))throw new Error(`${n}: the image's axes are ${c.map(g=>g.name).join(", ")}; a 3-D image (x, y and z) is needed`);const A=i.coordinateTransformations??[],p=A.filter(g=>Z(g.input)!==void 0||Z(g.output)!==void 0),d=A.filter(g=>!p.includes(g));let f=c,v=h?.name??"physical",b=d.reduce((g,_)=>se(ae(_,u),g),ae({type:"identity"},u));const y=g=>p.find(_=>Z(_.input)===v&&Z(_.output)===g&&a.some(M=>M.name===g)),R=(e!==void 0?y(e):void 0)??p.find(g=>Z(g.input)===v&&y(Z(g.output))!==void 0),T=a.find(g=>g.name===Z(R?.output));R!==void 0&&T!==void 0&&T.name!==v&&(b=se(ae(R,u),b),f=T.axes,v=T.name);const E=Array.from({length:4},(g,_)=>Array.from({length:u+1},(M,F)=>_===3&&F===u?1:0));f.forEach((g,_)=>{const M={x:0,y:1,z:2}[g.name];if(M===void 0)return;const F=Bo[g.unit??"millimeter"]??1;E[M][_]=F});const S=Array.from({length:u+1},(g,_)=>Array.from({length:4},(M,F)=>_===u&&F===3?1:0));c.forEach((g,_)=>{const M={x:0,y:1,z:2}[g.name];M!==void 0&&(S[_][M]=1)});const C=r.map(g=>{const _=(g.coordinateTransformations??[]).reduce((B,N)=>se(ae(N,u),B),ae({type:"identity"},u)),M=se(E,se(b,se(_,S))),F=Float64Array.from(M.flat()),O=[0,1,2].map(B=>Math.hypot(F[B],F[4+B],F[8+B]));return{url:n.endsWith("/")?n:`${n}/`,path:g.path,voxelToRas:F,voxelSize:(O[0]+O[1]+O[2])/3,axes:c.map(B=>B.name)}}),x=i.metadata?.description;return{levels:C,space:v,name:String(i.name??n),description:typeof x=="string"?x:void 0}}function Do(n){const t=n.flatMap(s=>s.levels),e=[];for(const s of t)e.some(o=>Math.abs(o.voxelSize-s.voxelSize)<=.02*o.voxelSize)||e.push(s);return e.sort((s,o)=>s.voxelSize-o.voxelSize)}function ko(n,t){const e=t.voxel_offset??[0,0,0],s=t.resolution.map(i=>i*1e-6),o=new Float64Array(16);for(let i=0;i<3;++i)o[5*i]=s[i],o[4*i+3]=(e[i]+.5)*s[i];return o[15]=1,{url:n,path:t.key,voxelToRas:o,voxelSize:(s[0]+s[1]+s[2])/3,axes:["z","y","x"]}}const _t={b1:"bool",i1:"int8",u1:"uint8",i2:"int16",u2:"uint16",i4:"int32",u4:"uint32",i8:"int64",u8:"uint64",f4:"float32",f8:"float64"};function Lo(n){const t=/^([<>|])([biuf]\d)$/.exec(String(n?.dtype??""));if(t===null||_t[t[2]]===void 0)throw new Error(`zarr v2 data type ${JSON.stringify(n?.dtype)} is not read`);const e=n.shape.length,s=Number(t[2].slice(1)),o=[];if(n.order==="F"&&o.push({name:"transpose",configuration:{order:[...Array(e).keys()].reverse()}}),o.push(s===1?{name:"bytes"}:{name:"bytes",configuration:{endian:t[1]===">"?"big":"little"}}),Array.isArray(n.filters)&&n.filters.length>0)throw new Error("zarr v2 filters are not read");const i=n.compressor;if(i!=null)switch(i.id){case"blosc":o.push({name:"blosc",configuration:{cname:i.cname??"lz4",clevel:i.clevel??5,shuffle:["noshuffle","shuffle","bitshuffle"][i.shuffle]??"shuffle",typesize:s,blocksize:i.blocksize??0}});break;case"zlib":o.push({name:"zlib",configuration:{level:i.level??1}});break;case"gzip":o.push({name:"gzip",configuration:{level:i.level??1}});break;case"zstd":o.push({name:"zstd",configuration:{level:i.level??0,checksum:!1}});break;default:throw new Error(`zarr v2 compressor ${JSON.stringify(i.id)} is not read`)}return{zarr_format:3,node_type:"array",shape:n.shape,data_type:_t[t[2]],chunk_grid:{name:"regular",configuration:{chunk_shape:n.chunks}},chunk_key_encoding:{name:"v2",configuration:{separator:n.dimension_separator??"."}},fill_value:n.fill_value??0,codecs:o}}function Io(n){return async(t,e)=>{const s=await n(t,e);if(s!==void 0||!t.endsWith("zarr.json"))return s;const o=await n(`${t.slice(0,-9)}.zarray`,{signal:e.signal});if(o!==void 0)return new TextEncoder().encode(JSON.stringify(Lo(JSON.parse(new TextDecoder().decode(o)))))}}const Uo=32,Kt=128*2**20;function Po(n,t=Kt){return Math.max(1,Math.min(Uo,Math.floor(t/Math.max(1,n))))}const $o=2**30;function Ct(n){return n>=2**30?`${(n/2**30).toFixed(1)} GB`:n>=2**20?`${Math.round(n/2**20)} MB`:n>=2**10?`${Math.round(n/2**10)} KB`:`${n} bytes`}async function ve(n,t,e,s){let o=0,i;const a=async()=>{for(;o<n.length&&!e.aborted&&i===void 0;)try{await s(n[o++])}catch(r){i??={error:r}}};if(await Promise.all(Array.from({length:Math.min(t,n.length)},a)),e.throwIfAborted(),i!==void 0)throw i.error}function zo(n){const{url:t,path:e}=n.info,s=t.endsWith("/")?`${t}${e}`:`${t}/${e}`,o=i=>(a,r)=>i(a,r).catch(l=>{throw l?.name==="AbortError"?l:new Error(`${s}: chunk ${a.join(".")} could not be read: ${l?.message??l}`,{cause:l})});return{...n,readChunk:o(n.readChunk),...n.rawChunk?{rawChunk:o(n.rawChunk)}:{}}}const ie={uint8:Uint8Array,int8:Int8Array,uint16:Uint16Array,int16:Int16Array,uint32:Uint32Array,int32:Int32Array,float32:Float32Array,float64:Float64Array},ye={uint64:"uint32",int64:"int32"};function Xe(n,t){const e=Math.floor(n.byteLength/8),s=new DataView(n.buffer,n.byteOffset,n.byteLength),o=t==="uint64"?new Uint32Array(e):new Int32Array(e);for(let i=0;i<e;++i){const a=s.getUint32(8*i,!0),r=s.getInt32(8*i+4,!0);if(!(t==="uint64"?r===0:r===(a&2147483648?-1:0)))throw new Error(`a label of ${t==="uint64"?s.getBigUint64(8*i,!0):s.getBigInt64(8*i,!0)} is past what 32 bits hold`);o[i]=t==="uint64"?a:a|0}return new Uint8Array(o.buffer)}function jo(n,t){const e=ie[t];if(typeof n=="string"&&/^0x[0-9a-f]+$/i.test(n)){const o=new Uint8Array(8);return new DataView(o.buffer).setBigUint64(0,BigInt.asUintN(64,BigInt(n)),!0),new e(o.buffer,0,1)[0]}const s=n==="NaN"?NaN:n==="Infinity"?1/0:n==="-Infinity"?-1/0:Number(n??0);return new e([s])[0]}function Vo(n,t){const e=n.slice();for(let s=0;s+t<=e.length;s+=t)e.subarray(s,s+t).reverse();return e}function Go(n,t,e,s){const o=new Array(t.length);for(let w=t.length-1,A=s;w>=0;A*=t[w--])o[w]=A;const[i,a,r]=e.map(w=>t[w]),[l,h,c]=e.map(w=>o[w]),u=new Uint8Array(i*a*r*s);let m=0;for(let w=0;w<i;++w)for(let A=0;A<a;++A){const p=w*l+A*h;if(c===s)u.set(n.subarray(p,p+r*s),m),m+=r*s;else for(let d=0;d<r;++d,m+=s)u.set(n.subarray(p+d*c,p+d*c+s),m)}return u}function Xo(n,t){return n==="t"?`${t} time points`:n==="c"?`${t} channels`:`${t} steps along ${n}`}function pe(n,t){const e=ie[t],s=n.slice(0,n.byteLength-n.byteLength%e.BYTES_PER_ELEMENT);return new e(s.buffer)}function Mt(n,[t,e]){const s=new Uint8Array(n.length),o=255/(e-t);for(let i=0;i<n.length;++i){const a=(n[i]-t)*o;s[i]=a<=0||a!==a?0:a>=255?255:a}return s}async function Wo(n,t,e,s){const o=await n(`${t}/zarr.json`,{signal:s});if(o===void 0)return;const i=JSON.parse(new TextDecoder().decode(o)),a=i?.codecs?.find(d=>d?.name==="transpose");if(a===void 0)return;const r=i.shape.length,l=a.configuration?.order,h=Array.isArray(l)?l.map(Number):l==="F"?[...Array(r).keys()].reverse():[...Array(r).keys()],c=i.chunk_grid.configuration.chunk_shape,u={...i,shape:h.map(d=>i.shape[d]),chunk_grid:{...i.chunk_grid,configuration:{...i.chunk_grid.configuration,chunk_shape:h.map(d=>c[d])}},codecs:i.codecs.filter(d=>d!==a),...Array.isArray(i.dimension_names)?{dimension_names:h.map(d=>i.dimension_names[d])}:{}},m=i.chunk_key_encoding?.name==="v2",w=i.chunk_key_encoding?.configuration?.separator??(m?".":"/"),A=m?`${t}/`:`${t}/c${w}`,p=new TextEncoder().encode(JSON.stringify(u));return{axes:h.map(d=>e[d]),read:async(d,f)=>{if(d===`${t}/zarr.json`)return p;if(d.startsWith(A)){const v=d.slice(A.length).split(w);if(v.length===r&&v.every(b=>/^\d+$/.test(b))){const b=new Array(v.length);return h.forEach((y,R)=>b[y]=v[R]),n(A+b.join(w),f)}}return n(d,f)}}}function Ho(n){return Cs(async(t,{signal:e,byteRange:s})=>{const o=os(xs(n,t));let i={signal:e};s!==void 0&&(i={headers:{Range:"suffixLength"in s?`bytes=-${s.suffixLength}`:`bytes=${s.offset}-${s.offset+s.length-1}`},signal:e,cache:"no-store"});let a=await fetch(o,i);for(let c=0;a.status===503&&c<120;++c)await new Promise(u=>setTimeout(u,Math.min(1e4,500*2**c))),e?.throwIfAborted(),a=await fetch(o,i);if(a.status===404||a.status===403)return;if(!a.ok)throw new Error(`${o}: ${a.status} ${a.statusText}`);const r=new Uint8Array(await a.arrayBuffer());if(s===void 0)return r;let l,h;if("suffixLength"in s)h=s.suffixLength,l=r.length-h;else{h=s.length;const c=a.status===206?Number(a.headers.get("Content-Range")?.match(/bytes (\d+)-/)?.[1]??s.offset):0;l=s.offset-c}if(l<0)throw new Error(`${o}: the answer does not hold the bytes asked for`);return l===0&&r.length<=h?r:r.slice(l,l+h)})}function qo(n){if(!/^https?:\/\//i.test(n))return!1;const t=globalThis.location?.origin;return t===void 0||new URL(n).origin!==t}async function Yo(n,t,e){let s=t.get(n.url);s===void 0&&t.set(n.url,s={read:Ho(n.url),shardIndexes:new Rs});const{shardIndexes:o}=s,i=`${n.url}${n.path}`,a=Io(s.read),r=await Wo(a,n.path,n.axes,e),l=r?.read??a,h=r?.axes??n.axes,c=await _s(l,n.path,e);if(c===void 0)throw new Error(`${i}: no array`);const u=c.elementType in ye?c.elementType:void 0;if(!(c.elementType in ie)&&u===void 0)throw new Error(`${i}: ${c.elementType} values cannot be read`);const m=c.shape.length;if(m!==h.length)throw new Error(`${i}: a ${m}-D array, but the image names ${h.length} axes (${h.join(", ")})`);const w=h.flatMap((x,g)=>["x","y","z"].includes(x)?[g]:[]),A=h.findIndex((x,g)=>!w.includes(g)&&c.shape[g]!==1);if(A!==-1)throw new Error(`${i} has ${Xo(h[A],c.shape[A])}; a single 3-D image (one time point, one channel) is needed`);const p=w.map(x=>h[x]),d=w.map(x=>c.shape[x]),f=w.map(x=>c.readChunkShape[x]),v=[0,1,2].map(x=>p.indexOf("xyz"[x])),b=u===void 0?c.elementType:ye[u],y={...n,axes:p,shape:d,chunk:f,size:[d[v[0]],d[v[1]],d[v[2]]],type:b},R=new Ms(c,l,o),T=jo(c.fillValue,b);if(u!==void 0&&T!==Number(c.fillValue??0))throw new Error(`${i}: a fill value of ${c.fillValue} is past what 32 bits hold`);const E=x=>{const g=new Array(m).fill(0);return w.forEach((_,M)=>g[_]=x[M]),g},S=c.readChunkShape.some((x,g)=>!w.includes(g)&&x!==1),C=async x=>{let g=await R.readChunk(E(x));if(g!==void 0)return S&&(g=Go(g,c.readChunkShape,w,c.elementBytes)),c.bigEndian&&c.elementBytes>1&&(g=Vo(g,c.elementBytes)),u===void 0?g:Xe(g,u)};return{info:y,ref:{kind:"ome",level:n,stamp:JSON.stringify([c.shape,c.storedChunkShape,c.readChunkShape,c.elementType,c.bigEndian,c.fillValue,c.codecs,r===void 0])},raw:C,type:b,fill:T,dimOf:v,grid:d.map((x,g)=>Math.ceil(x/f[g])),chunkBytes:c.readChunkShape.reduce((x,g)=>x*g,1)*c.elementBytes}}function Jo(n,t,e,s){const o=e in ye?e:void 0,i=s?"uint32":o!==void 0?ye[o]:e,a=new Bs(n,t,e),[r,l,h]=a.chunk,[c,u,m]=t.size,w={...ko(n,t),shape:[m,u,c],chunk:[h,l,r],size:[c,u,m],type:i},A=s||o!==void 0?8:ie[e].BYTES_PER_ELEMENT,p=s?async([d,f,v])=>{const b=await a.readLabels([v,f,d]);return b&&Xe(new Uint8Array(b.buffer,b.byteOffset,b.byteLength),"uint64")}:async([d,f,v])=>{const b=await a.readValues([v,f,d]);return b&&o!==void 0?Xe(b,o):b};return{info:w,ref:{kind:"precomputed",url:n,scale:t,stored:e,labels:s,stamp:JSON.stringify([t,e,s])},raw:p,type:i,fill:0,dimOf:[2,1,0],grid:[a.grid[2],a.grid[1],a.grid[0]],chunkBytes:r*l*h*A}}class Ko{constructor(t=$o,e=Kt){this.maxReadBytes=t,this.inFlightBytes=e}levels=[];concurrency(t){return Po(t.chunkBytes,this.inFlightBytes)}checkSize(t,e,s,o){const i=e[0]*e[1]*e[2]*s;if(i<=this.maxReadBytes)return;const a=c=>this.levels[c].info.size.map((u,m)=>u/this.levels[t].info.size[m]),r=this.levels.flatMap((c,u)=>{if(u<=t)return[];const m=a(u);return e[0]*m[0]*e[1]*m[1]*e[2]*m[2]*s<=this.maxReadBytes?[u]:[]}),l=o?`A box of ${e.join(" × ")} voxels of level ${t}`:`Level ${t} (${e.join(" × ")} voxels)`,h=r.length>0?`read a coarser level (${r.length>1?`levels ${r.join(", ")}`:`level ${r[0]}`} fit)${o?" or a smaller box":""}`:o?"read a smaller box":"read a box of it";throw new Error(`${l} is ${Ct(i)}, past the ${Ct(this.maxReadBytes)} one read may take: ${h}`)}opened=new Set;adopt(t){const e=Os(),s=Ns(t.ref);(this.opened.has(s)||!qo(t.ref.kind==="ome"?t.ref.level.url:t.ref.url))&&e.forget(t.ref),this.opened.add(s);const{ref:o,raw:i,type:a}=t,r=(l,h=!0)=>e.chunk(o,l,h,i);return zo({info:t.info,readChunk:async l=>{const h=await r(l);return h===void 0||a==="uint8"?h:Mt(pe(h,a),this.window)},rawChunk:r,type:a,fill:t.fill,dimOf:t.dimOf,grid:t.grid,chunkBytes:t.chunkBytes})}async open(t,e,s,o=!1){if(t.length===1&&t[0].startsWith(lt))return this.openPrecomputed(t[0].slice(lt.length),s,o);const i=await Promise.all(t.map(async c=>{const u=c.endsWith("/")?c:`${c}/`,m=await ft(`${u}zarr.json`,s)??await ft(`${u}.zattrs`,s);if(m===void 0)throw new Error(`${u}: no zarr.json or .zattrs`);if((m.attributes??m)?.ngplatform?.rendering==="rgb")throw new Error(`${u}: a colour (RGB) image; the image reader reads one value per voxel`);return Oo(u,m,e)})),a=Do(i),r=new Map,l=await Promise.all(a.map(c=>Yo(c,r,s)));this.levels=l.map(c=>this.adopt(c)),this.window=[0,255];const h=this.levels[this.levels.length-1];return h!==void 0&&h.type!=="uint8"&&(this.window=await this.windowOf(h,s,o)),{levels:this.levels.map(c=>c.info),name:i[0]?.name??"",description:i.find(c=>c.description)?.description,window:this.window}}window=[0,255];async windowOf(t,e,s=!1){const o=[],i=[];for(let c=0;c<t.grid[0];++c)for(let u=0;u<t.grid[1];++u)for(let m=0;m<t.grid[2];++m)i.push([c,u,m]);const a=Math.max(1,Math.floor(i.length/64));for(let c=0;c<i.length;c+=a){e?.throwIfAborted();const u=await t.rawChunk?.(i[c],!1).catch(()=>{});if(u===void 0)continue;const m=pe(u,t.type),w=Math.max(1,Math.floor(m.length/2e4));for(let A=0;A<m.length;A+=w)Number.isFinite(m[A])&&o.push(m[A])}if(o.length===0)return[0,1];o.sort((c,u)=>c-u);const r=c=>o[Math.round(c*(o.length-1))];let l,h;if(s){[l,h]=[o[0],o[o.length-1]];const[c,u]=[r(1e-4),r(.9999)];h-u>.25*(u-l)&&(h=u),c-l>.25*(h-c)&&(l=c),h+=.1*(h-l)}else l=o[Math.floor(.005*(o.length-1))],h=o[Math.ceil(.995*(o.length-1))];return h>l?[l,h]:[l,l+1]}async openPrecomputed(t,e,s=!1){const o=await Fs(t,void 0,e);if(o.type!=="image"&&o.type!=="segmentation")throw new Error(`${t}: a precomputed ${o.type??"source"}, not an image or segmentation`);const i=o.type==="segmentation",a=o.data_type;if(!i&&!(a in ie)&&!(a in ye))throw new Error(`${t}: ${a} values cannot be read`);this.levels=o.scales.map(l=>this.adopt(Jo(t,l,a,i))).sort((l,h)=>l.info.voxelSize-h.info.voxelSize),this.window=[0,255];const r=this.levels[this.levels.length-1];return!i&&r!==void 0&&r.type!=="uint8"&&(this.window=await this.windowOf(r,e,s)),{levels:this.levels.map(l=>l.info),name:t.replace(/\/$/,"").split("/").pop()??"",window:this.window}}shownFill(t){return t.type==="uint8"?t.fill:Mt([t.fill],this.window)[0]}async volume(t,e,s,o){const i=this.levels[t],{chunk:a,shape:r}=i.info,{dimOf:l}=i,h=o?.lo??[0,0,0],c=o?.hi??i.info.size,u=[0,1,2].map(T=>Math.max(0,c[T]-h[T]));this.checkSize(t,u,1,o!==void 0);const m=new Uint8Array(u[0]*u[1]*u[2]).fill(this.shownFill(i)),w=[0,0,0],A=[0,0,0],p=[0,0,0],d=[1,u[0],u[0]*u[1]];for(let T=0;T<3;++T)w[l[T]]=Math.max(0,h[T]),A[l[T]]=Math.min(r[l[T]],c[T]),p[l[T]]=d[T];const f=[0,0,0];for(let T=0;T<3;++T)f[l[T]]=h[T];const v=[0,1,2].map(T=>Math.floor(w[T]/a[T])),b=[0,1,2].map(T=>Math.ceil(A[T]/a[T])-1),y=[];for(let T=v[0];T<=b[0];++T)for(let E=v[1];E<=b[1];++E)for(let S=v[2];S<=b[2];++S)y.push([T,E,S]);let R=0;return await ve(y,this.concurrency(i),e,async T=>{const E=await i.readChunk(T);if(E!==void 0){const S=[0,1,2].map(_=>T[_]*a[_]),C=[0,1,2].map(_=>Math.max(S[_],w[_])),x=[0,1,2].map(_=>Math.min(S[_]+a[_],A[_])),g=x[2]-C[2];for(let _=C[0];_<x[0];++_)for(let M=C[1];M<x[1];++M){let F=((_-S[0])*a[1]+(M-S[1]))*a[2]+(C[2]-S[2]),O=(_-f[0])*p[0]+(M-f[1])*p[1]+(C[2]-f[2])*p[2];if(p[2]===1)m.set(E.subarray(F,F+g),O);else for(let B=0;B<g;++B,++F,O+=p[2])m[O]=E[F]}}s?.(++R,y.length)}),{data:m,size:u}}async rawVolume(t,e,s){const o=this.levels[t],{chunk:i,shape:a,size:r}=o.info,{dimOf:l,type:h}=o,c=ie[h].BYTES_PER_ELEMENT;this.checkSize(t,r,c,!1);const u=new Uint8Array(r[0]*r[1]*r[2]*c);o.fill!==0&&new ie[h](u.buffer).fill(o.fill);const m=[0,0,0],w=[1,r[0],r[0]*r[1]];for(let f=0;f<3;++f)m[l[f]]=w[f];const A=o.rawChunk??o.readChunk,p=[];for(let f=0;f<o.grid[0];++f)for(let v=0;v<o.grid[1];++v)for(let b=0;b<o.grid[2];++b)p.push([f,v,b]);let d=0;return await ve(p,this.concurrency(o),e,async f=>{const v=await A(f,!1);if(v!==void 0){const b=[0,1,2].map(T=>f[T]*i[T]),y=[0,1,2].map(T=>Math.min(b[T]+i[T],a[T])),R=y[2]-b[2];for(let T=b[0];T<y[0];++T)for(let E=b[1];E<y[1];++E){const S=((T-b[0])*i[1]+(E-b[1]))*i[2],C=T*m[0]+E*m[1]+b[2]*m[2];if(m[2]===1)u.set(v.subarray(S*c,(S+R)*c),C*c);else for(let x=0;x<R;++x)u.set(v.subarray((S+x)*c,(S+x+1)*c),(C+x*m[2])*c)}}s?.(++d,p.length)}),{data:u,size:r,type:h,fill:o.fill}}async eachRawChunk(t,e,s,o,i){const a=this.levels[t],{chunk:r,shape:l,size:h}=a.info,{dimOf:c,type:u}=a,m=i?.lo??[0,0,0],w=i?.hi??h,A=[0,0,0],p=[0,0,0];for(let E=0;E<3;++E)A[c[E]]=Math.max(0,m[E]),p[c[E]]=Math.min(l[c[E]],w[E]);if(A.some((E,S)=>E>=p[S]))return;const d=[r[1]*r[2],r[2],1],f=[0,1,2].map(E=>d[c[E]]),v=a.rawChunk??a.readChunk,b=[0,1,2].map(E=>Math.floor(A[E]/r[E])),y=[0,1,2].map(E=>Math.ceil(p[E]/r[E])-1),R=[];for(let E=b[0];E<=y[0];++E)for(let S=b[1];S<=y[1];++S)for(let C=b[2];C<=y[2];++C)R.push([E,S,C]);let T=0;await ve(R,this.concurrency(a),e,async E=>{const S=await v(E,!1);if(S!==void 0&&!e.aborted){const C=pe(S,a.rawChunk?u:"uint8"),x=[0,1,2].map(M=>Math.max(E[M]*r[M],A[M])),g=[0,1,2].map(M=>Math.min((E[M]+1)*r[M],p[M])),_=(x[0]-E[0]*r[0])*d[0]+(x[1]-E[1]*r[1])*d[1]+(x[2]-E[2]*r[2]);s(C,{lo:[0,1,2].map(M=>x[c[M]]),hi:[0,1,2].map(M=>g[c[M]]),start:_,stride:f})}o?.(++T,R.length)})}rawRegion(t,e,s,o){return this.region(t,e,s,o,4,i=>new Float32Array(i))}exactRegion(t,e,s,o){return this.region(t,e,s,o,8,i=>new Float64Array(i))}async region(t,e,s,o,i,a){const r=this.levels[t],{chunk:l,shape:h}=r.info,{dimOf:c,type:u}=r,m=[0,1,2].map(S=>Math.max(0,e.hi[S]-e.lo[S]));this.checkSize(t,m,i,!0);const w=a(m[0]*m[1]*m[2]);w.fill(NaN);const A=[0,0,0],p=[0,0,0],d=[0,0,0],f=[1,m[0],m[0]*m[1]],v=[0,0,0];for(let S=0;S<3;++S)A[c[S]]=Math.max(0,e.lo[S]),p[c[S]]=Math.min(h[c[S]],e.hi[S]),d[c[S]]=f[S],v[c[S]]=e.lo[S];if(A.some((S,C)=>S>=p[C]))return{data:w,size:m};for(let S=A[0];S<p[0];++S)for(let C=A[1];C<p[1];++C)for(let x=A[2];x<p[2];++x)w[(S-v[0])*d[0]+(C-v[1])*d[1]+(x-v[2])*d[2]]=r.fill;const b=r.rawChunk??r.readChunk,y=[0,1,2].map(S=>Math.floor(A[S]/l[S])),R=[0,1,2].map(S=>Math.ceil(p[S]/l[S])-1),T=[];for(let S=y[0];S<=R[0];++S)for(let C=y[1];C<=R[1];++C)for(let x=y[2];x<=R[2];++x)T.push([S,C,x]);let E=0;return await ve(T,this.concurrency(r),s,async S=>{const C=await b(S);if(C!==void 0){const x=pe(C,r.rawChunk?u:"uint8"),g=[0,1,2].map(F=>S[F]*l[F]),_=[0,1,2].map(F=>Math.max(g[F],A[F])),M=[0,1,2].map(F=>Math.min(g[F]+l[F],p[F]));for(let F=_[0];F<M[0];++F)for(let O=_[1];O<M[1];++O){let B=((F-g[0])*l[1]+(O-g[1]))*l[2]+(_[2]-g[2]),N=(F-v[0])*d[0]+(O-v[1])*d[1]+(_[2]-v[2])*d[2];for(let D=_[2];D<M[2];++D,++B,N+=d[2])w[N]=x[B]}}o?.(++E,T.length)}),{data:w,size:m}}async rawPoints(t,e,s,o){const i=this.levels[t],{chunk:a,shape:r,size:l}=i.info,{dimOf:h,type:c}=i,u=e.length/3,m=new Float64Array(u).fill(NaN),w=(y,R,T)=>y+l[0]*(R+l[1]*T),A=(y,R,T)=>y>=0&&R>=0&&T>=0&&y<l[0]&&R<l[1]&&T<l[2],p=new Map,d=s==="nearest"?1:8;for(let y=0;y<u;++y){const R=[e[3*y],e[3*y+1],e[3*y+2]],T=s==="nearest"?R.map(Math.round):R.map(Math.floor);for(let E=0;E<d;++E){const S=T[0]+(E&1),C=T[1]+(E>>1&1),x=T[2]+(E>>2&1);A(S,C,x)&&p.set(w(S,C,x),i.fill)}}const f=new Map;for(const y of p.keys()){const R=[y%l[0],Math.floor(y/l[0])%l[1],Math.floor(y/(l[0]*l[1]))],T=[0,0,0];for(let x=0;x<3;++x)T[h[x]]=R[x];const E=T.map((x,g)=>Math.floor(x/a[g])),S=E.join(".");let C=f.get(S);C===void 0&&f.set(S,C={index:E,voxels:[]}),C.voxels.push(R)}const v=i.rawChunk??i.readChunk;await ve([...f.values()],this.concurrency(i),o,async({index:y,voxels:R})=>{const T=await v(y);if(T===void 0)return;const E=pe(T,i.rawChunk?c:"uint8");for(const S of R){const C=[0,0,0];for(let x=0;x<3;++x)C[h[x]]=S[x];C.some((x,g)=>x>=r[g])||p.set(w(S[0],S[1],S[2]),E[((C[0]-y[0]*a[0])*a[1]+(C[1]-y[1]*a[1]))*a[2]+(C[2]-y[2]*a[2])])}});const b=(y,R,T)=>A(y,R,T)?p.get(w(y,R,T))??NaN:NaN;for(let y=0;y<u;++y){const R=e[3*y],T=e[3*y+1],E=e[3*y+2];if(s==="nearest"){m[y]=b(Math.round(R),Math.round(T),Math.round(E));continue}const S=Math.floor(R),C=Math.floor(T),x=Math.floor(E),g=[R-S,T-C,E-x];let _=0,M=0;for(let F=0;F<8;++F){const O=[F&1,F>>1&1,F>>2&1],B=(O[0]?g[0]:1-g[0])*(O[1]?g[1]:1-g[1])*(O[2]?g[2]:1-g[2]);if(B===0)continue;const N=b(S+O[0],C+O[1],x+O[2]);N===N&&(_+=B*N,M+=B)}m[y]=M>0?_/M:NaN}return m}}const Se=1/12;function Zo(n,t,e,s=.5){const[o,i,a]=t,r=t.map(d=>Math.ceil(d/e)),l=r[0]*r[1]*r[2],h=new Float32Array(3*l),c=new Float32Array(6*l),u=new Float32Array(l),m=new Float32Array(l);let w=0;const A=e*e/12+Se,p=e**3/Math.sqrt((2*Math.PI)**3*A**3);for(let d=0;d<r[2];++d)for(let f=0;f<r[1];++f)for(let v=0;v<r[0];++v){const b=v*e,y=f*e,R=d*e,T=Math.min(o,b+e),E=Math.min(i,y+e),S=Math.min(a,R+e);let C=0,x=0,g=0,_=0,M=0,F=0,O=0,B=0,N=0,D=0;for(let $=R;$<S;++$){const I=$-R;for(let re=y;re<E;++re){const he=re-y;let ot=b+o*(re+i*$);for(let De=b;De<T;++De,++ot){const X=n[ot];if(!(X>0))continue;const ue=De-b;C+=X,x+=X*ue,g+=X*he,_+=X*I,M+=X*ue*ue,F+=X*ue*he,O+=X*ue*I,B+=X*he*he,N+=X*he*I,D+=X*I*I}}}if(C<s)continue;const j=x/C,V=g/C,G=_/C;h[3*w]=b+j,h[3*w+1]=y+V,h[3*w+2]=R+G;const L=6*w;c[L]=M/C-j*j+Se,c[L+1]=F/C-j*V,c[L+2]=O/C-j*G,c[L+3]=B/C-V*V+Se,c[L+4]=N/C-V*G,c[L+5]=D/C-G*G+Se;const[q,Y,H,J,K,P]=c.subarray(L,L+6),k=q*(J*P-K*K)-Y*(Y*P-K*H)+H*(Y*K-J*H);u[w]=Math.min(1,C/Math.sqrt((2*Math.PI)**3*Math.max(k,1e-12))/p),m[w]=C,++w}return{centres:h.slice(0,3*w),covariances:c.slice(0,6*w),weights:u.slice(0,w),masses:m.slice(0,w),count:w}}function Qo(n,t){const e=t,s=new Float32Array(n.centres.length),o=new Float32Array(n.covariances.length);for(let i=0;i<n.count;++i){const a=[n.centres[3*i],n.centres[3*i+1],n.centres[3*i+2]];for(let u=0;u<3;++u)s[3*i+u]=e[4*u]*a[0]+e[4*u+1]*a[1]+e[4*u+2]*a[2]+e[4*u+3];const r=n.covariances.subarray(6*i,6*i+6),l=[[r[0],r[1],r[2]],[r[1],r[3],r[4]],[r[2],r[4],r[5]]],h=[0,1,2].map(u=>[0,1,2].map(m=>e[4*u]*l[0][m]+e[4*u+1]*l[1][m]+e[4*u+2]*l[2][m])),c=(u,m)=>h[u][0]*e[4*m]+h[u][1]*e[4*m+1]+h[u][2]*e[4*m+2];o.set([c(0,0),c(0,1),c(0,2),c(1,1),c(1,2),c(2,2)],6*i)}return{...n,centres:s,covariances:o}}Ss(()=>Fo(["org.ngplatform.zarr-vectors"]));const We=32,tt=4,ei=.08,ti=4,He=new Ko;let Ee,Zt=0,qe=[];const Re=new Set;let ze=0;const le=(n,t=[])=>self.postMessage(n,t);async function si(n){const{levels:t}=await He.open([n],void 0),e=await He.volume(t.length-1,new AbortController().signal),s=Co(e.data,e.size),o=s<128;Zt=(o?s:255-s)/255,Ee={levels:t.map(i=>({size:i.size,voxelToRas:Array.from(i.voxelToRas),voxelSize:i.voxelSize})),darkBackground:o},le({type:"opened",info:Ee}),st()}async function oi(n){const[t,e]=n.split("|"),s=Number(t),o=Ee.levels[s],a=e.split(".").map(Number).map(f=>f*We),r=a.map((f,v)=>Math.min(o.size[v],f+We));if(a.some((f,v)=>f>=r[v]||f<0)){le({type:"empty",key:n});return}const{data:l,size:h}=await He.volume(s,new AbortController().signal,void 0,{lo:a,hi:r}),c=Zt+ei,u=1/Math.max(.001,1-c),m=Ee.darkBackground,w=new Float32Array(l.length);for(let f=0;f<l.length;++f){const v=(m?l[f]:255-l[f])/255;w[f]=v>c?(v-c)*u:0}const A=Zo(w,h,tt);if(A.count===0){le({type:"empty",key:n});return}const p=o.voxelToRas.slice();for(let f=0;f<3;++f)p[4*f+3]+=p[4*f]*a[0]+p[4*f+1]*a[1]+p[4*f+2]*a[2];const d=Qo(A,p);le({type:"splats",key:n,centres:d.centres,covariances:d.covariances,weights:d.weights},[d.centres.buffer,d.covariances.buffer,d.weights.buffer])}function st(){for(;ze<ti&&qe.length>0;){const n=qe.shift();Re.has(n)||(Re.add(n),ze++,oi(n).catch(t=>le({type:"error",key:n,message:t.message})).finally(()=>{Re.delete(n),ze--,st()}))}}self.onmessage=n=>{const t=n.data;t.type==="open"?si(t.store).catch(e=>le({type:"error",message:e.message})):t.type==="want"&&(qe=t.keys.filter(e=>!Re.has(e)),Ee!==void 0&&st())};const Ft=256*1024*1024,ii=3,ri=12/(2*Math.PI)*1.4;class ni{constructor(t){this.view=t,this.overlay=t.ctx.ui.overlay(),this.canvas=document.createElement("canvas"),this.canvas.className="luxar-canvas",this.canvas.style.mixBlendMode="plus-lighter",this.overlay.element.append(this.canvas),this.offRendered=t.ctx.viewer.onRendered(()=>this.schedule()),this.offScreenshot=t.ctx.ui.screenshotOverlay((e,s)=>this.paint(e,s)),this.offRestored=this.shared.onRestored(()=>this.schedule())}overlay;canvas;shared=Oe.acquire();epoch=-1;renderer;shows=!1;offRestored;gpu=new Map;gpuBytes=0;frame=0;visible=!0;queued=!1;offRendered;offScreenshot;selections=[];problem;setVisible(t){this.visible=t,this.canvas.style.display=t?"":"none",this.schedule()}schedule(){this.queued||(this.queued=!0,requestAnimationFrame(()=>{if(this.queued=!1,!this.disposed){this.problem=void 0;try{this.render()}catch(t){this.problem=`2-D views: ${t.message}`}}}))}context(){const t=this.shared.context();if(this.epoch!==this.shared.epoch&&(this.gpu.clear(),this.gpuBytes=0,this.epoch=this.shared.epoch),t===void 0){this.problem=this.shared.lost?void 0:this.shared.problem;return}return this.renderer=t.splats(),t}render(){const t=this.visible?this.view.ctx.viewer.panels().filter(s=>s.kind==="2d"):[],e=this.view.info!==void 0&&t.length>0?this.context():void 0;if(e===void 0){this.shows&&this.canvas.getContext("2d")?.clearRect(0,0,this.canvas.width,this.canvas.height),this.shows=!1,this.view.want("2d",[]);return}try{this.draw(e)}finally{Jt(this.canvas,e.canvas),this.shows=!0}}draw(t){const{gl:e}=t,{view:s}=this,o=s.info,i=this.visible?s.ctx.viewer.panels().filter(x=>x.kind==="2d"):[],a=this.overlay.element.getBoundingClientRect(),r=globalThis.devicePixelRatio||1,l=Math.max(1,Math.round(a.width*r)),h=Math.max(1,Math.round(a.height*r));if((t.canvas.width!==l||t.canvas.height!==h)&&(t.canvas.width=l,t.canvas.height=h),e.bindFramebuffer(e.FRAMEBUFFER,null),e.viewport(0,0,l,h),e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT),o===void 0||i.length===0||this.renderer===void 0){s.want("2d",[]);return}const c=s.ctx.viewer.getState(),u=c.dimensions??{},m=Object.keys(u),w={names:m,scales:m.map(x=>u[x][0]),units:m.map(x=>u[x][1]),position:m.map((x,g)=>c.position?.[g]??0)},A=s.style,p=Ae(o.levels[0].voxelToRas),d=s.storeInfo(o),f=o.levels[0],v=Math.max(Ht(A,f.size.map(x=>x*f.voxelSize))/2,2*tt*f.voxelSize),{target:b}=t;if(!b.bind(l,h,null)){this.problem="This GPU cannot add light up in a float target here.";return}e.viewport(0,0,l,h),e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT),e.enable(e.SCISSOR_TEST),e.disable(e.DEPTH_TEST),e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE),++this.frame;const y=[],R=[];for(const x of i){const g=this.drawPanel(e,x,w,a,r,d,p,v);g!==void 0&&(y.push(g),R.push(g.want))}e.disable(e.SCISSOR_TEST);const T=[],E=new Set;for(let x=0;R.some(g=>x<g.length);++x)for(const g of R){const _=g[x];_!==void 0&&!E.has(_)&&(E.add(_),T.push(_))}s.want("2d",T),this.selections=y,this.evict();const S=s.style.bloom,C=S>0?t.bloom.run(b.texture,l,h,!1):void 0;e.bindFramebuffer(e.FRAMEBUFFER,null),e.viewport(0,0,l,h),e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE),t.renderer.composite(b.texture,{color:0},{toneMap:Qe.clamp,emission:!1,origin:[0,0],bloom:C&&{textures:C,amount:S}}),e.disable(e.BLEND)}drawPanel(t,e,s,o,i,a,r,l){const h=this.view,c=h.info,u=e.element.getBoundingClientRect();if(u.width<2||u.height<2)return;const m=Ot(g=>e.project(g),s.position);if(m===void 0)return;const w=W(vs(s,m),h.placement()),A=ps(w);if(A===void 0)return;const p=g=>{const _=new Float64Array(16);if(_[0]=2/u.width,_[12]=-1,_[5]=-2/u.height,_[13]=1,_[15]=1,g){const M=Math.hypot(w[2],w[6],w[10]);_[10]=.999/(M*l)}return _},d=W(p(!1),w),f=W(W(p(!0),w),r),v=Me(W(w,r)),b=v?Fe(v,[u.width/2,u.height/2,0]).slice(0,3):c.levels[0].size.map(g=>g/2),y=Be(a,(g,_)=>ce(f,g,_),b,h.style.detail*1e6,g=>h.arrived(g)),R=new Map;for(const g of y.draw){const _=this.upload(g);if(_===void 0)continue;const M=Number(g.split("|")[0]);R.set(M,[...R.get(M)??[],_])}const T=Math.round((u.left-o.left)*i),E=Math.round((o.bottom-u.bottom)*i),S=Math.round(u.width*i),C=Math.round(u.height*i);t.viewport(T,E,S,C),t.scissor(T,E,S,C);const x=h.style;for(const g of R.values())this.renderer.draw(g,{modelToClip:Float32Array.from(d),viewport:[S,C],gain:2**x.exposure*ri,widen:ii,absorption:0,colormap:Ze[x.colormap],colour:x.colourBy==="solid"?Ke(x.colour):void 0,plane:A});return y}upload(t){const e=this.gpu.get(t);if(e!==void 0)return e.used=this.frame,e.splats;const s=this.view.blockData(t);if(s===void 0||this.renderer===void 0)return;const o=this.renderer.upload(s.centres,s.covariances,s.weights);return this.gpu.set(t,{splats:o,used:this.frame}),this.gpuBytes+=o.bytes,o}evict(){if(this.gpuBytes<=Ft)return;const t=[...this.gpu.entries()].sort((e,s)=>e[1].used-s[1].used);for(const[e,s]of t){if(this.gpuBytes<=Ft*.8||s.used===this.frame)break;this.renderer.release(s.splats),this.gpuBytes-=s.splats.bytes,this.gpu.delete(e)}}paint(t,e){if(!this.visible||!this.shows)return;const s=e.getBoundingClientRect(),o=e.width/Math.max(1,s.width),i=this.overlay.element.getBoundingClientRect();t.save(),t.globalCompositeOperation="lighter",t.drawImage(this.canvas,(i.left-s.left)*o,(i.top-s.top)*o,i.width*o,i.height*o),t.restore()}disposed=!1;dispose(){if(this.disposed=!0,this.offScreenshot(),this.offRendered(),this.offRestored(),this.epoch===this.shared.epoch&&!this.shared.lost)for(const t of this.gpu.values())this.renderer?.release(t.splats);this.gpu.clear(),this.overlay.dispose(),this.shared.release()}}const Bt=512*1024*1024,ai=15e3,Nt=.5,li=.3,ci=.3;class je{constructor(t,e,s,o){this.ctx=t,this.name=e,this.storeUrl=s,this.style=o,this.worker=Ds(new Worker(new URL(""+new URL("splat_worker-BccGDJir.js",import.meta.url).href,import.meta.url),{type:"module",name:"luxar splats"})),this.worker.onmessage=i=>{const a=i.data;a.type==="opened"?this.info=a.info:a.type==="splats"?(this.blocks.set(a.key,{data:a,used:this.frame}),this.failed.size===0&&(this.error=void 0)):a.type==="empty"?this.empty.add(a.key):a.type==="error"&&(this.error=a.message,a.key!==void 0&&this.failed.set(a.key,performance.now()+ai)),this.handle.redraw(),this.view2d.schedule(),this.onStatus?.()},this.worker.onerror=i=>{i.preventDefault(),this.error=`the splat reader stopped: ${i.message||"it could not start"}`,this.stopped=!0,this.handle?.redraw(),this.onStatus?.()},this.worker.postMessage({type:"open",store:s}),this.handle=t.viewer.draw3d(e,{draw:i=>this.draw(i),isReady:()=>this.stopped||this.failedIn!==void 0||this.selection===void 0||this.selection.complete,afterSections:!0,dispose:()=>this.release()}),this.view2d=new ni(this)}worker;info;error;blocks=new Map;empty=new Set;failed=new Map;wanted=[];wants=new Map;view2d;renderer;composite;target;bloom;gl;gpuBytes=0;frame=0;selection;problem;stopped=!1;handle;offs=[];onStatus;placementCache;placement(){const t=performance.now();return(this.placementCache===void 0||t-this.placementCache.at>8)&&(this.placementCache={at:t,value:gs(this.ctx.viewer.layerTransform?.(this.name))??ws()}),this.placementCache.value}setStyle(t){this.style=t,this.handle.redraw(),this.view2d.schedule()}setVisible(t){this.view2d.setVisible(t)}arrived(t){if(this.blocks.has(t)||this.empty.has(t))return!0;const e=this.failed.get(t);return e===void 0?!1:performance.now()<e?!0:(this.failed.delete(t),!1)}blockData(t){const e=this.blocks.get(t);return e!==void 0&&(e.used=this.frame),e?.data}want(t,e){this.wants.set(t,e.filter(o=>!this.arrived(o)));const s=[...new Set([...this.wants.get("3d")??[],...this.wants.get("2d")??[]])];s.join()!==this.wanted.join()&&(this.wanted=s,this.worker.postMessage({type:"want",keys:s}))}storeInfo(t){const e=t.levels[0],s=(o,i)=>Math.hypot(o[i],o[4+i],o[8+i]);return{bounds:{lower:[0,0,0],upper:e.size.slice()},levels:t.levels.map((o,i)=>({index:i,chunkShape:[0,1,2].map(a=>We*(s(o.voxelToRas,a)/s(e.voxelToRas,a))),vertexCount:Math.round(o.size.reduce((a,r)=>a*Math.ceil(r/tt),1)*ci)}))}}release(){for(const t of this.blocks.values())t.gpu&&this.renderer?.release(t.gpu);for(const t of this.blocks.values())t.gpu=void 0;this.gpuBytes=0,this.target?.release(),this.bloom?.release(),this.renderer?.dispose(),this.composite?.dispose(),this.renderer=this.composite=this.target=this.bloom=void 0,this.gl=void 0}draw(t){if(this.failedIn!==t.gl){this.failedIn=void 0;try{this.drawNow(t)}catch(e){this.failedIn=t.gl,this.problem=`The 3-D view could not draw splats: ${e.message}`,this.release()}}}failedIn;drawNow(t){const{gl:e}=t,s=this.info;if(s===void 0)return;this.gl!==e&&(this.release(),this.gl=e,this.renderer=new Yt(e),this.composite=new Ye(e),this.target=new Je(e,this.composite.floatTargets),this.bloom=new et(this.composite,this.composite.floatTargets));const o=Mo(t.dimensions);if(o===void 0){this.problem=`The 3-D view shows ${t.dimensions.names.join(", ")}; splats need x, y and z.`;return}this.problem=void 0,++this.frame;const i=W(Ae(o),this.placement()),a=W(t.viewProjection,i),r=W(a,Ae(s.levels[0].voxelToRas)),l=Me(W(i,Ae(s.levels[0].voxelToRas))),h=l?Fe(l,t.position).slice(0,3):s.levels[0].size.map(v=>v/2),c=this.storeInfo(s),u=Be(c,(v,b)=>ce(r,v,b),h,this.style.detail*1e6,v=>this.arrived(v));this.selection=u,this.want("3d",u.want);const m=new Map;for(const v of u.draw){const b=this.blocks.get(v);if(b!==void 0&&(b.used=this.frame,b.gpu===void 0&&b.data!==void 0&&(b.gpu=this.renderer.upload(b.data.centres,b.data.covariances,b.data.weights),this.gpuBytes+=b.gpu.bytes),b.gpu)){const y=Number(v.split("|")[0]);m.set(y,[...m.get(y)??[],b.gpu])}}if(this.evict(),this.onStatus?.(),m.size===0)return;const w={framebuffer:e.getParameter(e.DRAW_FRAMEBUFFER_BINDING),viewport:e.getParameter(e.VIEWPORT),drawBuffers:[0,1,2,3].map(v=>e.getParameter(e.DRAW_BUFFER0+v)),blend:e.isEnabled(e.BLEND),depthTest:e.isEnabled(e.DEPTH_TEST),depthMask:e.getParameter(e.DEPTH_WRITEMASK),depthFunc:e.getParameter(e.DEPTH_FUNC),stencil:e.isEnabled(e.STENCIL_TEST),scissor:e.isEnabled(e.SCISSOR_TEST)};for(;w.drawBuffers.length>1&&w.drawBuffers[w.drawBuffers.length-1]===e.NONE;)w.drawBuffers.pop();const[A,p,d,f]=w.viewport;try{const v=e.getFramebufferAttachmentParameter(e.DRAW_FRAMEBUFFER,e.DEPTH_STENCIL_ATTACHMENT,e.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME)??null;if(!this.target.bind(d,f,v)){this.problem="This GPU cannot add light up in a float target here.";return}e.viewport(0,0,d,f),e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT),e.disable(e.STENCIL_TEST),e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE),e.depthMask(!1),e.enable(e.DEPTH_TEST),e.depthFunc(e.LEQUAL);const b=this.style,y=b.blending==="emission";for(const[T,E]of m)this.renderer.draw(E,{modelToClip:Float32Array.from(a),viewport:[d,f],gain:2**b.exposure*Nt*(s.levels[T].voxelSize/s.levels[0].voxelSize)*(y?Math.max(b.absorption,.05):li),absorption:y?b.absorption*Nt*(s.levels[T].voxelSize/s.levels[0].voxelSize):0,colormap:Ze[b.colormap],colour:b.colourBy==="solid"?Ke(b.colour):void 0});const R=b.bloom>0?this.bloom.run(this.target.texture,d,f,y):void 0;e.enable(e.BLEND),e.bindFramebuffer(e.FRAMEBUFFER,w.framebuffer),e.viewport(A,p,d,f),e.drawBuffers(w.drawBuffers.map((T,E)=>E===t.outputs.color?T:e.NONE)),e.disable(e.DEPTH_TEST),y?e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA):e.blendFuncSeparate(e.ONE,e.ONE,e.ONE,e.ONE_MINUS_SRC_ALPHA),this.composite.composite(this.target.texture,t.outputs,{toneMap:Qe[b.toneMap],emission:y,origin:[A,p],bloom:R&&{textures:R,amount:b.bloom}})}finally{e.bindFramebuffer(e.FRAMEBUFFER,w.framebuffer),e.drawBuffers(w.drawBuffers),e.viewport(A,p,d,f),w.blend?e.enable(e.BLEND):e.disable(e.BLEND),w.depthTest?e.enable(e.DEPTH_TEST):e.disable(e.DEPTH_TEST),e.depthMask(w.depthMask),e.depthFunc(w.depthFunc),w.stencil&&e.enable(e.STENCIL_TEST),w.scissor&&e.enable(e.SCISSOR_TEST),e.blendFunc(e.ONE,e.ZERO)}}evict(){if(this.gpuBytes<=Bt)return;const t=[...this.blocks.entries()].filter(([,e])=>e.gpu!==void 0).sort((e,s)=>e[1].used-s[1].used);for(const[e,s]of t){if(this.gpuBytes<=Bt*.8||s.used>=this.frame-1)break;this.renderer.release(s.gpu),this.gpuBytes-=s.gpu.bytes,this.blocks.delete(e)}}report(){if(this.error!==void 0&&this.info===void 0)return{error:`Could not open the image: ${this.error}`};if(this.info===void 0)return{progress:"Opening the image…"};const t=this.problem||this.view2d.problem;if(t)return{error:t};if(this.error)return{error:`Could not read a block: ${this.error}`};const e=this.selection??this.view2d.selections[0];return e!==void 0&&!e.complete?{progress:"Reading…"}:{}}dispose(){this.offs.forEach(t=>t()),this.handle.dispose(),this.view2d.dispose(),this.worker.terminate(),this.blocks.clear()}}function hi(n){if(typeof n!="object"||n===null||n.enableDefaultSubsources!==!1)return!0;const t=n.subsources;return t===null||typeof t!="object"?!1:Object.values(t).some(e=>e===!0||typeof e=="object"&&e!==null)}function ui(n,t){const e=t?.source,s=Array.isArray(e)?e:e===void 0?[]:[e],o=new Set(s.filter(i=>!hi(i)).map(i=>String(typeof i=="object"&&i!==null?i.url:i)));return n.filter(i=>!o.has(i))}const di=3e4,fi=150,mi=3e3,vi=100;function ge(n){return n.type==="image"?is(n.sources[0]):void 0}function pi(n,t){if(!(n.type!=="segmentation"&&n.type!=="auto"))for(const e of ui(n.sources,t)){const s=rs(e);if(s!==void 0)return s}}function gi(n){const t=n.sources[0];if(n.type==="segmentation")return ct(t);if((n.type==="auto"||n.type==="new")&&/^graphene:\/\//i.test(t?.trim()??""))return ct(t)}class wi{constructor(t){this.ctx=t,this.saved=gt(t.state.get()),this.momentum=new $s(t),this.offs.push(t.state.onChanged(()=>{const e=gt(t.state.get());JSON.stringify(e)!==JSON.stringify(this.saved)&&(this.saved=e,this.sync(),this.panelUpdate?.())}),t.viewer.onLayersChanged(()=>{this.sync(),this.panelUpdate?.()}),t.workspace.onChanged(()=>{this.updateCanDraw(),this.panelUpdate?.()}),t.viewer.onStateChanged(()=>{const e=t.viewer.layersGeneration?.();if(!(e!==void 0&&e===this.lookGeneration)){this.lookGeneration=e;for(const[s,o]of this.views)o instanceof z&&o.setLook(this.lookOf(s));this.panelUpdate?.()}})),this.sync()}saved;disposed=!1;views=new Map;outgoing=new Map;drawingHidden=new Set;panelUpdate;statusUpdate;editing;momentum;offs=[];meshVolumes=new Map;settling=new Map;signInPoll;segmentWatch=new Map;opened=new Map;lookGeneration;lookOf(t){return this.ctx.viewer.colourLook?.(t)??es(this.ctx.viewer.layerSpec(t))}updateCanDraw(){if(this.disposed)return;const t=this.ctx.workspace.selectedLayer();this.ctx.context.set(dt,t!==void 0&&this.candidates().some(e=>e.name===t))}candidates(){return this.ctx.viewer.layers().filter(t=>this.storeOf(t)!==void 0||ge(t)!==void 0||this.isMeshLayer(t))}storeOf(t){const e=pi(t,this.ctx.viewer.layerSpec(t.name));if(e!==void 0)return e;const s=this.meshVolumeOf(t);if(s===void 0)return;const o=this.ctx.viewer.visibleSegments(t.name);if(o===void 0||o.all||o.size===0)return;const i=this.views.get(t.name),a=i===void 0?void 0:fe(i.storeUrl);return bs(s,ys(o.ids(),a?.volume===s?a.ids:void 0))}meshVolumeOf(t){const e=this.meshEntry(t);return e?.[1].state==="meshes"?e[0]:void 0}isMeshLayer(t){const e=this.meshEntry(t)?.[1].state;return e==="meshes"||e==="sign-in"}needsSignIn(t){return this.meshEntry(t)?.[1].state==="sign-in"}meshEntry(t){const e=gi(t);if(e===void 0)return;let s=this.meshVolumes.get(e.volume);return s===void 0&&(s={state:void 0,need:e.signIn,headers:[],asking:!1},this.meshVolumes.set(e.volume,s),this.ask(e.volume,s)),[e.volume,s]}async ask(t,e){if(!e.asking){e.asking=!0;try{const s=await At(e.need),o=await Es(t,s);if(this.disposed)return;const i=o!==e.state;if(e.headers=s,e.state=o,!i||o==="none")return;this.sync(),this.panelUpdate?.()}finally{e.asking=!1}}}signIn(){this.ctx.commands.invoke("settings.signIn",{card:"sign-in.other"}),this.signInPoll!==void 0&&clearInterval(this.signInPoll);let t=0;this.signInPoll=setInterval(()=>void this.askAgain(++t>=vi),mi)}async askAgain(t){if(this.disposed)return;let e=!1;for(const[s,o]of this.meshVolumes)o.state==="sign-in"&&(e=!0,this.ask(s,o));for(const[s,o]of this.views){if(!(o instanceof z)||!o.client.signIn)continue;e=!0;const i=this.meshVolumes.get(fe(o.storeUrl)?.volume??"");if(i===void 0)continue;const a=await At(i.need);this.disposed||this.views.get(s)!==o||JSON.stringify(a)===JSON.stringify(o.headers)||(i.headers=a,this.retry(s))}(!e||t)&&this.signInPoll!==void 0&&(clearInterval(this.signInPoll),this.signInPoll=void 0)}write(t){this.disposed||(this.saved=t,this.ctx.state.set(t),this.sync(),this.panelUpdate?.())}styleOf(t){const e=this.saved.layers[t];if(e!==void 0)return e;const s=this.ctx.viewer.layers().find(a=>a.name===t);if(s!==void 0&&ge(s)!==void 0)return{...we,on:!1,blending:"emission",colourBy:"attribute",colormap:"grey",absorption:.3};const o=this.ctx.viewer.layerSpec(t);if(s!==void 0&&this.isMeshLayer(s))return{...we,on:!1,colourBy:"segment"};const i=o?.segmentDefaultColor!==void 0||typeof o?.segmentColors=="object"&&o.segmentColors!==null&&Object.keys(o.segmentColors).length>0;return this.lookOf(t)!==void 0?{...we,on:!1,colourBy:"layer"}:{...we,on:!1,...i?{colourBy:"segment"}:{}}}setStyle(t,e,s=!0){const o=Vt({...this.styleOf(t),...e});s?this.write({...this.saved,layers:{...this.saved.layers,[t]:o}}):(this.saved={...this.saved,layers:{...this.saved.layers,[t]:o}},this.views.get(t)?.setStyle(o))}toggle(t){const e=this.styleOf(t);this.editing=t,this.setStyle(t,{on:!e.on})}handOver(t){const e=this.outgoing.get(t);if(e===void 0)return;const s=this.views.get(t),o=e.view.objectsShown,i=s instanceof z?s.client.info?.levels[0]?.objects:void 0;if(s instanceof z&&s.held&&o!==void 0&&(!s.ready||i!==void 0&&i<o)){clearTimeout(e.timer),e.timer=this.handOverLater(t);return}this.finishHandOver(t)}handOverLater(t){return setTimeout(()=>{this.disposed||this.handOver(t)},di)}finishHandOver(t){const e=this.outgoing.get(t);if(e===void 0)return;this.outgoing.delete(t),clearTimeout(e.timer),e.view.dispose();const s=this.views.get(t);s instanceof z&&s.held&&(s.held=!1,s.redraw())}sync(){if(this.disposed)return;const t=new Map(this.ctx.viewer.layers().map(o=>[o.name,o])),e=new Map;for(const[o,i]of this.views){const a=t.get(o),r=this.saved.layers[o],l=a&&(this.storeOf(a)??ge(a));(a===void 0||r===void 0||!r.on||l!==i.storeUrl)&&(this.views.delete(o),i instanceof z&&!i.held&&r?.on&&a?.visible&&l!==void 0&&this.storeOf(a)!==void 0?(this.finishHandOver(o),i.freeze(),i.setVisible(!0),this.outgoing.set(o,{view:i,timer:this.handOverLater(o)})):i instanceof z&&fe(i.storeUrl)!==void 0&&a!==void 0&&r?.on?e.set(o,i):i.dispose())}for(const o of[...this.outgoing.keys()]){const i=this.saved.layers[o];(!t.has(o)||i===void 0||!i.on)&&this.finishHandOver(o)}for(const[o,i]of Object.entries(this.saved.layers)){const a=t.get(o);if(a===void 0||!i.on)continue;const r=this.storeOf(a),l=r===void 0?ge(a):void 0;if(r===void 0&&l===void 0)continue;let h=this.views.get(o);if(h===void 0){if(l!==void 0)h=new je(this.ctx,o,l,i),h.onStatus=()=>this.statusUpdate?.();else{const u=e.get(o)??this.outgoing.get(o)?.view,m=fe(r)?.volume,w=m===void 0?[]:this.meshVolumes.get(m)?.headers??[],A=u!==void 0&&m!==void 0&&fe(u.storeUrl)?.volume===m&&JSON.stringify(u.headers)===JSON.stringify(w)?u:void 0,p=new z(this.ctx,o,r,i,{adopt:A,headers:w});p.held=this.outgoing.has(o),p.onStatus=()=>{p.held&&p.ready&&this.views.get(o)===p&&this.handOver(o),this.statusUpdate?.()},h=p}this.views.set(o,h)}else h.style!==i&&h.setStyle(i);h.setVisible(a.visible),h instanceof z&&h.setLook(this.lookOf(o));const c=this.outgoing.get(o);c!==void 0&&(c.view.style!==i&&c.view.setStyle(i),c.view.setVisible(a.visible))}for(const o of e.values())o.dispose();for(const o of[...this.drawingHidden])this.views.has(o)||(this.drawingHidden.delete(o),t.has(o)&&this.ctx.viewer.hideLayerDrawing(o,!1));for(const o of this.views.keys())this.drawingHidden.add(o),this.ctx.viewer.hideLayerDrawing(o,!0);for(const[o,i]of[...this.segmentWatch]){const a=t.get(o);a!==void 0&&this.meshVolumeOf(a)!==void 0||(i(),this.segmentWatch.delete(o),clearTimeout(this.settling.get(o)),this.settling.delete(o))}for(const o of t.values())this.segmentWatch.has(o.name)||this.meshVolumeOf(o)===void 0||this.segmentWatch.set(o.name,this.ctx.viewer.onSegmentsChanged(o.name,()=>{const i=this.views.get(o.name),a=this.ctx.viewer.layers().find(r=>r.name===o.name);a!==void 0&&this.saved.layers[o.name]?.on&&(i===void 0||this.storeOf(a)!==i.storeUrl)&&!this.settling.has(o.name)&&this.settling.set(o.name,setTimeout(()=>{this.settling.delete(o.name),this.sync()},fi)),this.panelUpdate?.()}));const s=[...this.views.values()].some(o=>o instanceof je);this.ctx.viewer.setTemporaryBackground(s?[0,0,0]:void 0),this.momentum.set(this.saved.momentum),this.updateCanDraw()}kindOf(t){const e=this.ctx.viewer.layers().find(i=>i.name===t);if(e!==void 0&&ge(e)!==void 0)return"splats";if(e!==void 0&&this.isMeshLayer(e))return"mesh";const s=this.views.get(t),o=s instanceof z?s.client.info?.primitive:void 0;return o==="points"?"points":o==="triangles"?"mesh":"lines"}storeInfoOf(t){const e=this.views.get(t),s=e instanceof z?e.client.info:void 0;return s!==void 0&&this.opened.set(t,s),s??this.opened.get(t)}retry(t){const e=this.views.get(t);e!==void 0&&(this.views.delete(t),e.dispose(),this.sync(),this.panelUpdate?.())}render(t){const{ctx:e}=this,s=ts("Nothing here Luxar can draw.",{label:"Open data…",run:()=>void e.commands.invoke("dataset.add")}),o=new Map,i=de(f=>(o.clear(),f.map(v=>{const b=ke(v,this.styleOf(v).on,R=>{this.editing=v,this.setStyle(v,{on:R})}),y=te("p",{class:"hint",hidden:!0});return o.set(v,{draw:b,cap:y}),te("div",{},b,y)})),{class:"list"});let a;const r=de(f=>f.length<2?a=void 0:(a=Le(f.map(v=>[v,v]),this.editing??f[0],v=>{this.editing=v,A()},"Settings for"),Q("Settings for",a))),l=ss();let h="",c;const u=de(f=>{if(f===null)return c=void 0;const v=this.settingsCards(f[0],f[1]);return c=v.sync,v.cards}),m=ke("Momentum",this.saved.momentum,f=>this.write({...this.saved,momentum:f}),{info:"Keeps the 3-D view turning after a drag, slowing to a stop, as Luxar's camera does."});t.append(ne("luxar.layers","Layers",{open:!0},s,i,r,l),u,ne("luxar.view","3-D view",{},m));const w=()=>{const f=this.editing,v=f===void 0?void 0:this.views.get(f),b=f===void 0?void 0:e.viewer.layers().find(S=>S.name===f),R=v===void 0&&b!==void 0&&this.needsSignIn(b)?{error:"Sign in to read this layer's meshes.",signIn:!0}:v?.report()??{},T=R.progress??(f!==void 0&&this.outgoing.has(f)?"Reading…":void 0),E=JSON.stringify([R.error,T,R.warning]);E!==h&&(h=E,R.error!==void 0&&R.signIn?l.error(R.error,{label:"Sign in…",run:()=>this.signIn()}):R.error!==void 0&&f!==void 0?l.error(R.error,{label:"Retry",run:()=>this.retry(f)}):R.warning!==void 0?l.error(R.warning):T!==void 0?l.progress(T):l.clear())},A=()=>{const f=this.candidates();if(this.editing===void 0||!f.some(b=>b.name===this.editing)){const b=e.workspace.selectedLayer();this.editing=f.find(y=>y.name===b)?.name??f.find(y=>this.saved.layers[y.name]?.on)?.name??f[0]?.name}const v=f.map(b=>b.name);s.hidden=v.length>0,i.update(v);for(const b of f)o.get(b.name).draw.set(this.styleOf(b.name).on);p(f),r.update(v),r.hidden=v.length<2,this.editing!==void 0&&a?.set(this.editing),u.update(this.editing===void 0?null:[this.editing,this.kindOf(this.editing)]),c?.(),m.set(this.saved.momentum),w()},p=f=>{for(const v of f){const b=o.get(v.name);if(b===void 0)continue;const y=this.meshVolumeOf(v)===void 0?void 0:this.ctx.viewer.visibleSegments(v.name),R=y===void 0||y.all?void 0:Ts(y.size),T=this.views.get(v.name),E=[R,...T instanceof z?T.client.warnings:[]].filter(C=>C!==void 0),S=E.join(". ");b.cap.hidden=E.length===0,b.cap.textContent!==S&&(b.cap.textContent=S)}},d=()=>{p(this.candidates()),this.editing!==void 0&&u.update([this.editing,this.kindOf(this.editing)]),c?.(),w()};return A(),this.panelUpdate=A,this.statusUpdate=d,()=>{this.panelUpdate===A&&(this.panelUpdate=void 0),this.statusUpdate===d&&(this.statusUpdate=void 0)}}settingsCards(t,e){const s=()=>this.styleOf(t),o=(p,d=!0)=>this.setStyle(t,p,d),i=[],a=(p,d)=>(i.push(()=>void(p.hidden=!d())),p),r=(p,d,f)=>{const v=f.scale??1,b=at(s()[d]*v,{min:f.min,max:f.max,step:f.step,unit:f.unit,label:p,oninput:y=>o({[d]:y/v},!1),onchange:y=>o({[d]:y/v})});return i.push(()=>b.set(s()[d]*v)),Q(p,b,f.info===void 0?void 0:{info:f.info})},l=(p,d,f,v)=>{const b=Le(d,f(),y=>v(y),p);return i.push(()=>b.set(f())),Q(p,b)},h=p=>{const d=te("input",{type:"color",value:s().colour,"aria-label":p});return d.addEventListener("input",()=>o({colour:d.value},!1)),d.addEventListener("change",()=>o({colour:d.value})),i.push(()=>{d.ownerDocument.activeElement!==d&&d.value!==s().colour&&(d.value=s().colour)}),Q(p,d)},c=e==="splats",u=()=>s().blending==="solid",m=[];if(c)m.push(l("Blending",[["emission","Emission and absorption (looks solid)"],["glow","Glow (light added up)"]],()=>s().blending==="emission"?"emission":"glow",p=>o({blending:p})),l("Colour",[["attribute","By intensity, through a colormap"],["solid","One colour"]],()=>s().colourBy==="solid"?"solid":"attribute",p=>o({colourBy:p})),a(l("Colormap",pt,()=>s().colormap,p=>o({colormap:p})),()=>s().colourBy!=="solid"));else{m.push(l("Blending",io,()=>s().blending,E=>o({blending:E})),l("Colour",ro,()=>s().colourBy,E=>{const S=this.storeInfoOf(t)?.attributes[0]?.id;o({colourBy:E,attribute:E==="attribute"?s().attribute??S:s().attribute})}));let p;const d=de(E=>(p=Le(E.length>0?E:[["","None"]],s().attribute??E[0]?.[0]??"",S=>o({attribute:S,range:void 0}),"Attribute"),p.disabled=E.length===0,Q("Attribute",p))),f=()=>s().colourBy==="attribute",v=()=>{const E=this.views.get(t);return s().range??(E instanceof z?E.client.valueRange:void 0)},b=()=>{const E=Number(y.value),S=Number(R.value);y.value!==""&&R.value!==""&&Number.isFinite(E)&&Number.isFinite(S)&&E!==S&&o({range:[E,S]})},y=rt(NaN,b,{step:"any","aria-label":"Range from"}),R=rt(NaN,b,{step:"any","aria-label":"Range to"});y.value=R.value="";const T=a(nt("Reset",()=>o({range:void 0}),"Back to the range of the data read"),()=>s().range!==void 0);i.push(()=>{const E=this.storeInfoOf(t);d.hidden=!f()||E===void 0,d.update((E?.attributes??[]).map(C=>[C.id,C.name])),E!==void 0&&E.attributes.length>0&&p?.set(s().attribute??E.attributes[0].id);const S=v();S!==void 0&&(y.set(+S[0].toPrecision(4)),R.set(+S[1].toPrecision(4)))}),m.push(d,a(l("Colormap",pt,()=>s().colormap,E=>o({colormap:E})),f),a(Q("Range",te("div",{class:"row"},y,R,T)),f))}if(!c){const p=te("p",{class:"hint"});i.push(()=>{const d=this.lookOf(t);p.textContent=d?.by==="group"&&d.group!==void 0?`By ${d.group.tier}, ${d.group.colours==="stored"?"in the store's colours":"in a palette"}${d.group.shown===void 0?"":`, ${d.group.shown.length} shown`}. Change it in the layer's Display tab (Vertex colour).`:d?.by==="attribute"?`By ${d.attribute} through ${d.colormap??"viridis"}, ${d.low??"?"} to ${d.high??"?"}${d.hideOutside?", outside hidden":""}. Change it in the layer's Display tab (Vertex colour).`:"The layer colours by segment: its segment colours. Colour it by a group or an attribute in its Display tab (Vertex colour)."}),m.push(a(p,()=>s().colourBy==="layer"))}m.push(a(h("Colour"),()=>s().colourBy==="solid"),r("Brightness","exposure",{min:-8,max:8,step:.25,unit:"stops"}),a(r("Absorption","absorption",{min:0,max:8,step:.05}),()=>s().blending==="emission"),a(l("Tone map",no,()=>s().toneMap,p=>o({toneMap:p})),()=>!u()),a(r("Bloom","bloom",{min:0,max:3,step:.05,info:"A glow around bright light: the brightest parts, blurred, added back around them. 0 is off."}),()=>!u()));const w=[ne("luxar.look","Look",{open:!0},...m)];if(!c){const p=e==="mesh";w.push(ne("luxar.lines",p?"Surface":e==="points"?"Points":"Lines",{},e==="points"?r("Point size","width",{min:1.5,max:36,step:.75,unit:"px",scale:3}):r(p?"Outline width":"Width","width",{min:.5,max:12,step:.25,unit:"px",info:p?"Of the outline where a 2-D section cuts the mesh.":void 0}),r("Sharpness","sharpness",{min:0,max:1,step:.05,info:"From a soft glow (0) to a hard edge (1)."}),p?a(r("Glow depth","glowDepth",{min:0,max:20,step:.5,unit:"%",scale:100,info:"How far light from behind the nearest surface still shows, as a share of the layer's size; 0 adds every fold up."}),()=>s().blending==="glow"||s().blending==="glow-through"):null),ne("luxar.slab","2-D sections",{},this.slabField(t,i)))}const A=c?"M splats":"M vertices";return w.push(ne("luxar.detail","Detail",{},r("Detail","detail",{min:.25,max:12,step:.25,unit:A,info:"About how much a view reads and draws: more is finer and slower."}),c?null:this.onOffField(t,i))),{cards:w,sync:()=>i.forEach(p=>p())}}onOffField(t,e){const s=ke("Automatic brightness",this.styleOf(t).autoBrightness,o=>this.setStyle(t,{autoBrightness:o}),{info:"Dims lines where they crowd the view, so a whole brain glows rather than turning white."});return e.push(()=>s.set(this.styleOf(t).autoBrightness)),s}slabField(t,e){let s,o,i;const a=de(r=>{if(i=r??void 0,r===null)return s=o=void 0;const l=h=>h*r.perUnit;return s=at(this.slabMm(t)/r.perUnit,{min:r.min,max:r.max,step:r.step,unit:r.unit,label:"Slab thickness",unbounded:!0,oninput:h=>this.setStyle(t,{slab:l(h)},!1),onchange:h=>this.setStyle(t,{slab:l(h)})}),o=nt("Reset",()=>this.setStyle(t,{slab:void 0}),"Follow the data's size again"),Q("Slab thickness",te("div",{class:"row"},s,o),{info:"In a 2-D view, what is within half this of the section shows, fading away from it. It follows the data's size until you set it."})});return e.push(()=>{const r=this.storeInfoOf(t),l=r===void 0?void 0:Ge(Ve(r));a.update(l!==void 0?wt(l):this.styleOf(t).slab!==void 0?wt(this.styleOf(t).slab):null),o!==void 0&&(o.hidden=this.styleOf(t).slab===void 0);const h=this.slabMm(t);s!==void 0&&i!==void 0&&h!==void 0&&s.set(h/i.perUnit)}),a}slabMm(t){const e=this.styleOf(t),s=this.storeInfoOf(t);return e.slab??(s===void 0?void 0:Ge(Ve(s)))}dispose(){this.disposed=!0,this.panelUpdate=this.statusUpdate=void 0;for(const e of this.settling.values())clearTimeout(e);this.settling.clear(),this.signInPoll!==void 0&&clearInterval(this.signInPoll),this.signInPoll=void 0,this.offs.forEach(e=>e()),this.segmentWatch.forEach(e=>e()),this.segmentWatch.clear();for(const e of[...this.outgoing.keys()])this.finishHandOver(e);for(const e of this.views.values())e.dispose();const t=[...this.views.values()].some(e=>e instanceof je);for(const e of this.drawingHidden)this.ctx.viewer.hideLayerDrawing(e,!1);t&&this.ctx.viewer.setTemporaryBackground(void 0),this.drawingHidden.clear(),this.views.clear(),this.momentum.dispose(),this.ctx.context.set(dt,!1)}}const bi=`
.luxar-canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
`,Di={activate(n){const t=te("style",{},bi);document.head.append(t);const e=new wi(n);n.subscriptions.push(()=>t.remove()),n.subscriptions.push(()=>{e.dispose()}),n.ui.panel(ut,s=>e.render(s)),n.commands.register("luxar.toggle",()=>{const s=n.workspace.selectedLayer(),o=s===void 0?void 0:e.candidates().find(i=>i.name===s);if(o===void 0){n.ui.toast("Select a layer Luxar can draw first.");return}e.toggle(o.name)}),n.commands.register("luxar.show",()=>n.ui.showPanel(ut))}};export{wi as Luxar,fi as SEGMENT_SETTLE_MS,ge as imageOfLayer,Di as plugin,gi as precomputedSegmentationOf,pi as storeOfLayer};
