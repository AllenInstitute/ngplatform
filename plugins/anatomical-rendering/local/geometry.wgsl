// Surfaces for the WebGPU path tracer: the packed blocks (geometry/surfaces.ts) as one storage buffer, and their
// traversal and shading, as the WebGL tracer's (geometry/live_geometry.ts) and the render computer's
// (runner/ngplatform_render/geometry.py: trihit, spherehit, conehit).
//
// gdata: first the numbers G (G_VEC4 vec4u: u32s, floats as bits; G_* below), then the regions of
// geometry/live_geometry.ts geoLayout at width 1: vertices (xyz as float bits, and a normal or radius), primitives
// (three vertices, kind << 30 | object), wide nodes (4 each, geometry/wide.ts), objects (rgb, layer + 1, as float
// bits). The regions' starts in G count from the buffer's start; vertex numbers from the vertices'.

@group(0) @binding(10) var<storage, read> gdata: array<vec4u>;

const GEO_LAYERS: u32 = 4u;
const GEO_CLIPS: u32 = 6u;
const G_N: u32 = 0u;
const G_ROOT: u32 = 1u;
const G_PRIM_AT: u32 = 2u;
const G_NODE_AT: u32 = 3u;
const G_OBJ_AT: u32 = 4u;
const G_NCLIP: u32 = 5u;       // a layer: its cuts' count, + 256 where they are capped
const G_EPS: u32 = 9u;
const G_FROM_WORLD: u32 = 10u; // geometry from world, row-major 3 x 4
const G_MAT: u32 = 22u;        // a layer: roughness, specular, emission, opacity
const G_CROP: u32 = 38u;       // a layer: lo xyz, hi xyz
const G_CLIPS: u32 = 62u;      // a layer: GEO_CLIPS planes of 4
const G_VEC4: u32 = 40u;
fn gu(i: u32) -> u32 { let v = gdata[i >> 2u]; return v[i & 3u]; }

// Rays other than shadow rays meet a layer less than opaque as solid (the caller then takes its opacity, Surface.op);
// shadow rays pass it with the chance it is clear. A clear layer is never met.
var<private> geoSolid: bool = false;

fn gf(i: u32) -> f32 { return bitcast<f32>(gu(i)); }
fn gv3(i: u32) -> vec3f { return vec3f(gf(i), gf(i + 1u), gf(i + 2u)); }
fn geoPoint(w: vec3f) -> vec3f {
  let o = G_FROM_WORLD;
  return vec3f(gf(o) * w.x + gf(o + 1u) * w.y + gf(o + 2u) * w.z + gf(o + 3u),
               gf(o + 4u) * w.x + gf(o + 5u) * w.y + gf(o + 6u) * w.z + gf(o + 7u),
               gf(o + 8u) * w.x + gf(o + 9u) * w.y + gf(o + 10u) * w.z + gf(o + 11u));
}
fn geoDir(d: vec3f) -> vec3f {
  let o = G_FROM_WORLD;
  return vec3f(gf(o) * d.x + gf(o + 1u) * d.y + gf(o + 2u) * d.z,
               gf(o + 4u) * d.x + gf(o + 5u) * d.y + gf(o + 6u) * d.z,
               gf(o + 8u) * d.x + gf(o + 9u) * d.y + gf(o + 10u) * d.z);
}
// A geometry-space normal in the world: by the transpose of world-to-geometry's linear part.
fn geoNormalToWorld(n: vec3f) -> vec3f {
  let o = G_FROM_WORLD;
  return vec3f(gf(o) * n.x + gf(o + 4u) * n.y + gf(o + 8u) * n.z,
               gf(o + 1u) * n.x + gf(o + 5u) * n.y + gf(o + 9u) * n.z,
               gf(o + 2u) * n.x + gf(o + 6u) * n.y + gf(o + 10u) * n.z);
}
fn geoVert(v: u32) -> vec4f { return bitcast<vec4f>(gdata[G_VEC4 + v]); }
fn geoPrim(i: u32) -> vec4u { return gdata[gu(G_PRIM_AT) + i]; }
fn geoObj(o: u32) -> vec4f { return bitcast<vec4f>(gdata[gu(G_OBJ_AT) + o]); }
fn geoMat(li: u32) -> vec4f { let o = G_MAT + 4u * li; return vec4f(gf(o), gf(o + 1u), gf(o + 2u), gf(o + 3u)); }

struct TriHit { t: f32, uv: vec2f }
fn geoTri(a: vec3f, b: vec3f, c: vec3f, o: vec3f, d: vec3f) -> TriHit {
  var r: TriHit;
  r.t = -1.0;
  r.uv = vec2f(0.0);
  let e1 = b - a;
  let e2 = c - a;
  let p = cross(d, e2);
  let det = dot(e1, p);
  if (abs(det) < 1e-30) { return r; }
  let inv = 1.0 / det;
  let s = o - a;
  let u = dot(s, p) * inv;
  if (u < 0.0 || u > 1.0) { return r; }
  let q = cross(s, e1);
  let v = dot(d, q) * inv;
  if (v < 0.0 || u + v > 1.0) { return r; }
  r.uv = vec2f(u, v);
  r.t = dot(e2, q) * inv;
  return r;
}
fn geoSphere(c: vec3f, rad: f32, o: vec3f, d: vec3f) -> f32 {
  let oc = o - c;
  let b = dot(oc, d);
  var h = b * b - (dot(oc, oc) - rad * rad);
  if (h < 0.0) { return -1.0; }
  h = sqrt(h);
  let t = -b - h;
  return select(-b + h, t, t > 0.0);
}
fn geoCone(pa: vec3f, ra: f32, pb: vec3f, rb: f32, o: vec3f, d: vec3f) -> f32 {
  let ba = pb - pa;
  let oa = o - pa;
  let ob = o - pb;
  let rr = ra - rb;
  let m0 = dot(ba, ba);
  let m1 = dot(ba, oa);
  let m2 = dot(ba, d);
  let m3 = dot(d, oa);
  let m5 = dot(oa, oa);
  let m6 = dot(ob, d);
  let m7 = dot(ob, ob);
  let d2 = m0 - rr * rr;
  let k2 = d2 - m2 * m2;
  let k1 = d2 * m3 - m1 * m2 + m2 * rr * ra;
  let k0 = d2 * m5 - m1 * m1 + m1 * rr * ra * 2.0 - m0 * ra * ra;
  let h = k1 * k1 - k0 * k2;
  if (h < 0.0) { return -1.0; }
  let t = (-sqrt(h) - k1) / k2;
  let y = m1 - ra * rr + t * m2;
  if (y > 0.0 && y < d2) { return t; }
  var best = 1e30;
  let h1 = m3 * m3 - m5 + ra * ra;
  let h2 = m6 * m6 - m7 + rb * rb;
  if (h1 > 0.0) { best = -m3 - sqrt(h1); }
  if (h2 > 0.0) { best = min(best, -m6 - sqrt(h2)); }
  return select(-1.0, best, best < 1e29);
}
// Primitive i along (o, d any length): t and barycentrics (a triangle's).
fn geoPrimHit(i: u32, o: vec3f, d: vec3f) -> TriHit {
  let p = geoPrim(i);
  let kind = p.w >> 30u;
  if (kind == 0u) { return geoTri(geoVert(p.x).xyz, geoVert(p.y).xyz, geoVert(p.z).xyz, o, d); }
  let len = max(length(d), 1e-30);
  let u = d / len;
  let a = geoVert(p.x);
  var s: f32;
  if (kind == 2u) { s = geoSphere(a.xyz, a.w, o, u); }
  else { let b = geoVert(p.y); s = geoCone(a.xyz, a.w, b.xyz, b.w, o, u); }
  var r: TriHit;
  r.uv = vec2f(0.0);
  r.t = select(s / len, -1.0, s < 0.0);
  return r;
}
// A number in [0, 1) for the ray (o, d) at primitive i: whether a layer less than opaque stops it there.
fn geoHash(i: u32, o: vec3f, d: vec3f) -> f32 {
  let a = bitcast<vec3u>(o);
  let b = bitcast<vec3u>(d);
  var h = (i * 2654435761u) ^ a.x ^ (a.y * 2246822519u) ^ (a.z * 3266489917u) ^ (b.x * 668265263u) ^ (b.y * 374761393u) ^ (b.z * 1274126177u);
  h ^= h >> 16u;
  h *= 2246822519u;
  h ^= h >> 13u;
  h *= 3266489917u;
  h ^= h >> 16u;
  return f32(h >> 8u) / 16777216.0;
}
// A round cone's signed distance at p (Quilez's sdRoundCone).
fn geoConeDist(p: vec3f, a: vec3f, r1: f32, b: vec3f, r2: f32) -> f32 {
  let ba = b - a;
  let l2 = dot(ba, ba);
  let rr = r1 - r2;
  let a2 = l2 - rr * rr;
  let il2 = 1.0 / l2;
  let pa = p - a;
  let y = dot(pa, ba);
  let z = y - l2;
  let xv = pa * l2 - ba * y;
  let x2 = dot(xv, xv);
  let y2 = y * y * l2;
  let z2 = z * z * l2;
  let k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) { return sqrt(x2 + z2) * il2 - r2; }
  if (sign(y) * a2 * y2 < k) { return sqrt(x2 + y2) * il2 - r1; }
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
// A round cone's gradient at p (its outward normal, not unit), from end a (xyz, radius) to b.
fn geoConeGrad(p: vec3f, a4: vec4f, b4: vec4f) -> vec3f {
  let e = 1e-3 * max(a4.w + b4.w, 1e-12);
  return vec3f(geoConeDist(p + vec3f(e, 0.0, 0.0), a4.xyz, a4.w, b4.xyz, b4.w) - geoConeDist(p - vec3f(e, 0.0, 0.0), a4.xyz, a4.w, b4.xyz, b4.w),
               geoConeDist(p + vec3f(0.0, e, 0.0), a4.xyz, a4.w, b4.xyz, b4.w) - geoConeDist(p - vec3f(0.0, e, 0.0), a4.xyz, a4.w, b4.xyz, b4.w),
               geoConeDist(p + vec3f(0.0, 0.0, e), a4.xyz, a4.w, b4.xyz, b4.w) - geoConeDist(p - vec3f(0.0, 0.0, e), a4.xyz, a4.w, b4.xyz, b4.w));
}
// Kept at world point w (geometry point p) for layer li: inside its crop, cut away by none of its cuts.
fn geoKept(li: u32, w: vec3f, p: vec3f) -> bool {
  let c = G_CROP + 6u * li;
  if (any(p < gv3(c)) || any(p > gv3(c + 3u))) { return false; }
  let n = gu(G_NCLIP + li) & 255u;
  for (var i = 0u; i < n; i++) {
    let o = G_CLIPS + 4u * (GEO_CLIPS * li + i);
    if (dot(gv3(o), w) + gf(o + 3u) < 0.0) { return false; }
  }
  return true;
}
// Whether the ray (geometry d) leaves the solid primitive i bounds at geometry point p: met from inside (its
// outward face away from the ray; meshes are wound outward, geometry/primitives.ts orientOutward).
fn geoLeaves(i: u32, p: vec3f, d: vec3f) -> bool {
  let q = geoPrim(i);
  let kind = q.w >> 30u;
  var n: vec3f;
  if (kind == 0u) {
    let a = geoVert(q.x).xyz;
    n = cross(geoVert(q.y).xyz - a, geoVert(q.z).xyz - a);
  } else if (kind == 2u) {
    n = p - geoVert(q.x).xyz;
  } else {
    n = geoConeGrad(p, geoVert(q.x), geoVert(q.y));
  }
  return dot(n, d) > 0.0;
}
struct GeoEnter { t: f32, face: u32 }
// Where the world ray (ow, dw; geometry o, d) enters layer li's kept part (its crop and cuts, convex): t (-1e30 when
// it starts in it), and the face (a cut k: k; the crop's: GEO_CLIPS + 2 * axis, + 1 for its high side).
fn geoEnter(li: u32, ow: vec3f, dw: vec3f, o: vec3f, d: vec3f) -> GeoEnter {
  var r: GeoEnter;
  r.t = -1e30;
  r.face = 0u;
  let n = gu(G_NCLIP + li) & 255u;
  for (var i = 0u; i < n; i++) {
    let c = G_CLIPS + 4u * (GEO_CLIPS * li + i);
    let s = dot(gv3(c), dw);
    if (s <= 0.0) { continue; }
    let ti = -(dot(gv3(c), ow) + gf(c + 3u)) / s;
    if (ti > r.t) { r.t = ti; r.face = i; }
  }
  let cl = gv3(G_CROP + 6u * li);
  let ch = gv3(G_CROP + 6u * li + 3u);
  for (var a = 0u; a < 3u; a++) {
    if (d[a] > 0.0 && cl[a] > -1e29) {
      let ti = (cl[a] - o[a]) / d[a];
      if (ti > r.t) { r.t = ti; r.face = GEO_CLIPS + 2u * a; }
    } else if (d[a] < 0.0 && ch[a] < 1e29) {
      let ti = (ch[a] - o[a]) / d[a];
      if (ti > r.t) { r.t = ti; r.face = GEO_CLIPS + 2u * a + 1u; }
    }
  }
  return r;
}
// The nearest kept surface the world ray (ow, dw) meets in (tmin, tmax) (t -1: none); anyHit: the first found.
// Where the layer's cuts are capped and the surface met is the inside of a solid the ray entered the kept part
// through a cut (or crop) to reach, the cut face instead: there, uv.x = -1 - the face (geoEnter's).
struct GeoHit { t: f32, prim: u32, uv: vec2f }
fn geoTrace(ow: vec3f, dw: vec3f, tmin: f32, tmax: f32, anyHit: bool) -> GeoHit {
  var hit: GeoHit;
  hit.t = -1.0;
  hit.prim = 0u;
  hit.uv = vec2f(0.0);
  if (gu(G_N) == 0u) { return hit; }
  let o = geoPoint(ow);
  let d = geoDir(dw);
  let inv = 1.0 / select(d, vec3f(1e-20), abs(d) < vec3f(1e-20));
  var best = tmax;
  var stack: array<u32, 64>;
  var sp = 0u;
  stack[0] = gu(G_ROOT);
  sp = 1u;
  for (var it = 0; it < 65536; it++) {
    if (sp == 0u) { break; }
    sp -= 1u;
    let at = gu(G_NODE_AT) + 4u * stack[sp];
    let h = gdata[at];
    let ql = gdata[at + 1u];
    let qh = gdata[at + 2u];
    let ch = gdata[at + 3u];
    let org = bitcast<vec3f>(h.xyz);
    let sc = exp2(vec3f(vec3i(vec3u(h.w & 255u, (h.w >> 8u) & 255u, (h.w >> 16u) & 255u)) - vec3i(127)));
    let count = h.w >> 24u;
    // The nodes met, farthest first.
    var kt: array<f32, 4>;
    var kn: array<u32, 4>;
    var nk = 0u;
    for (var c = 0u; c < 4u; c++) {
      if (c >= count) { break; }
      let sh = 8u * c;
      let lo = org + vec3f((ql.xyz >> vec3u(sh)) & vec3u(255u)) * sc;
      let hi = org + vec3f((qh.xyz >> vec3u(sh)) & vec3u(255u)) * sc;
      let ta = (lo - o) * inv;
      let tb = (hi - o) * inv;
      let tn = min(ta, tb);
      let tf = max(ta, tb);
      let t0 = max(max(tn.x, tn.y), max(tn.z, 0.0));
      let t1 = min(min(tf.x, tf.y), min(tf.z, best));
      if (t0 > t1) { continue; }
      let cref = ch[c];
      if ((cref & 0x80000000u) != 0u) {
        let i = cref & 0x7fffffffu;
        let r = geoPrimHit(i, o, d);
        if (r.t <= tmin || r.t >= best) { continue; }
        let obj = geoPrim(i).w & 0x3fffffffu;
        let layer = geoObj(obj).w;
        if (layer < 0.5) { continue; }
        let li = u32(layer) - 1u;
        let op = geoMat(li).w;
        if ((op < 1.0 && (op <= 0.0 || ((anyHit || !geoSolid) && geoHash(i, ow, dw) >= op))) || !geoKept(li, ow + dw * r.t, o + d * r.t)) { continue; }
        best = r.t;
        hit.t = r.t;
        hit.prim = i;
        hit.uv = r.uv;
        if (anyHit) { return hit; }
        continue;
      }
      var j = nk;
      while (j > 0u && kt[j - 1u] < t0) {
        kt[j] = kt[j - 1u];
        kn[j] = kn[j - 1u];
        j -= 1u;
      }
      kt[j] = t0;
      kn[j] = cref;
      nk += 1u;
    }
    for (var j = 0u; j < nk; j++) {
      if (sp < 64u) { stack[sp] = kn[j]; sp += 1u; }
    }
  }
  if (!anyHit && hit.t >= 0.0) {
    let li = min(u32(max(geoObj(geoPrim(hit.prim).w & 0x3fffffffu).w, 1.0)) - 1u, GEO_LAYERS - 1u);
    if (gu(G_NCLIP + li) >= 256u) {
      let e = geoEnter(li, ow, dw, o, d);
      if (e.t > tmin && e.t < hit.t && geoLeaves(hit.prim, o + d * hit.t, d)) {
        hit.t = e.t;
        hit.uv = vec2f(-1.0 - f32(e.face), 0.0);
      }
    }
  }
  return hit;
}
fn geoAny(ow: vec3f, dw: vec3f, tmin: f32, tmax: f32) -> bool { return geoTrace(ow, dw, tmin, tmax, true).t >= 0.0; }
fn geoOct(p: u32) -> vec3f {
  let e = unpack2x16snorm(p);
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) { n = vec3f((1.0 - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0)), n.z); }
  return normalize(n);
}
struct Surface { n: vec3f, colour: vec3f, rough: f32, spec: f32, emit: f32, op: f32, obj: u32 }
// The surface at a hit of the world ray (ow, dw) at t: its world normal (facing the ray), colour and material.
fn geoSurface(h: GeoHit, ow: vec3f, dw: vec3f) -> Surface {
  var s: Surface;
  let q = geoPrim(h.prim);
  let kind = q.w >> 30u;
  s.obj = q.w & 0x3fffffffu;
  let ob = geoObj(s.obj);
  s.colour = ob.rgb;
  let m = geoMat(min(u32(max(ob.w, 1.0)) - 1u, GEO_LAYERS - 1u));
  s.rough = m.x;
  s.spec = m.y;
  s.emit = m.z;
  s.op = m.w;
  let p = geoPoint(ow + dw * h.t);
  var n: vec3f;
  if (h.uv.x < -0.5) {
    // A capped cut: the cut's plane (world), or the crop's face (geometry).
    let face = u32(-h.uv.x - 0.5);
    let li = min(u32(max(ob.w, 1.0)) - 1u, GEO_LAYERS - 1u);
    if (face < GEO_CLIPS) {
      s.n = normalize(gv3(G_CLIPS + 4u * (GEO_CLIPS * li + face)));
      if (dot(s.n, dw) > 0.0) { s.n = -s.n; }
      return s;
    }
    n = vec3f(0.0);
    n[(face - GEO_CLIPS) / 2u] = 1.0;
  } else if (kind == 0u) {
    let a = gdata[G_VEC4 + q.x];
    let b = gdata[G_VEC4 + q.y];
    let c = gdata[G_VEC4 + q.z];
    if (a.w == 0xffffffffu || b.w == 0xffffffffu || c.w == 0xffffffffu) { n = vec3f(0.0); }
    else { n = geoOct(a.w) * (1.0 - h.uv.x - h.uv.y) + geoOct(b.w) * h.uv.x + geoOct(c.w) * h.uv.y; }
    if (dot(n, n) < 1e-12) { n = cross(bitcast<vec3f>(b.xyz) - bitcast<vec3f>(a.xyz), bitcast<vec3f>(c.xyz) - bitcast<vec3f>(a.xyz)); }
  } else if (kind == 2u) {
    n = p - geoVert(q.x).xyz;
  } else {
    n = geoConeGrad(p, geoVert(q.x), geoVert(q.y));
  }
  s.n = normalize(geoNormalToWorld(n));
  if (dot(s.n, dw) > 0.0) { s.n = -s.n; }
  return s;
}
