// The path tracer in WGSL, for WebGPU in the page: the same method and parameter block as the
// render service's CUDA kernels (runner/ngplatform_render/kernels.py; slots from params.json,
// prepended here as constants P_<NAME>).  Region colours from labels are the service's only.

@group(0) @binding(0) var<storage, read> P: array<f32>;
@group(0) @binding(1) var vol: texture_3d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage, read> tf: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> maj: array<f32>;
@group(0) @binding(5) var<storage, read_write> accum: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> outrgba: array<u32>;
@group(0) @binding(7) var<storage, read_write> depthbuf: array<f32>;
@group(0) @binding(8) var<storage, read> bounds: array<vec2f>;
@group(0) @binding(9) var<uniform> U: vec4u; // width, height, frame, samples so far

var<private> rs: u32;

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn rnd() -> f32 {
  rs = pcg(rs);
  return f32(rs >> 8u) * (1.0 / 16777216.0);
}
fn pv(o: u32) -> vec3f { return vec3f(P[o], P[o + 1u], P[o + 2u]); }
fn mul4(o: u32, p: vec4f) -> vec4f {
  // Column-major 4x4 at slot o.
  return vec4f(
    P[o] * p.x + P[o + 4u] * p.y + P[o + 8u] * p.z + P[o + 12u] * p.w,
    P[o + 1u] * p.x + P[o + 5u] * p.y + P[o + 9u] * p.z + P[o + 13u] * p.w,
    P[o + 2u] * p.x + P[o + 6u] * p.y + P[o + 10u] * p.z + P[o + 14u] * p.w,
    P[o + 3u] * p.x + P[o + 7u] * p.y + P[o + 11u] * p.z + P[o + 15u] * p.w);
}
fn aff(o: u32, p: vec3f) -> vec3f {
  return vec3f(P[o] * p.x + P[o + 1u] * p.y + P[o + 2u] * p.z + P[o + 3u],
               P[o + 4u] * p.x + P[o + 5u] * p.y + P[o + 6u] * p.z + P[o + 7u],
               P[o + 8u] * p.x + P[o + 9u] * p.y + P[o + 10u] * p.z + P[o + 11u]);
}
fn lin(o: u32, d: vec3f) -> vec3f {
  return vec3f(P[o] * d.x + P[o + 1u] * d.y + P[o + 2u] * d.z,
               P[o + 4u] * d.x + P[o + 5u] * d.y + P[o + 6u] * d.z,
               P[o + 8u] * d.x + P[o + 9u] * d.y + P[o + 10u] * d.z);
}
fn lin3(o: u32, d: vec3f) -> vec3f {
  return vec3f(P[o] * d.x + P[o + 1u] * d.y + P[o + 2u] * d.z,
               P[o + 3u] * d.x + P[o + 4u] * d.y + P[o + 5u] * d.z,
               P[o + 6u] * d.x + P[o + 7u] * d.y + P[o + 8u] * d.z);
}

fn texval(v: vec3f) -> f32 {
  let dims = pv(P_DIMS);
  return textureSampleLevel(vol, samp, (v + vec3f(0.5)) / dims, 0.0).r;
}
fn tflookup(t: f32) -> vec4f {
  let f = clamp(t, 0.0, 1.0) * f32(TF_SIZE - 1u);
  let i = min(u32(f), TF_SIZE - 2u);
  let w = f - f32(i);
  return mix(tf[i], tf[i + 1u], w);
}
fn cut(w: vec3f, v: vec3f) -> bool {
  if (any(v < pv(P_CROP_LO)) || any(v > pv(P_CROP_HI))) { return true; }
  let n = u32(P[P_NCLIP]);
  for (var i = 0u; i < n; i++) {
    let o = P_CLIPS + 4u * i;
    if (P[o] * w.x + P[o + 1u] * w.y + P[o + 2u] * w.z + P[o + 3u] < 0.0) { return true; }
  }
  return false;
}
struct Med { sigma: f32, col: vec3f }
fn medium(w: vec3f, v: vec3f) -> Med {
  let c = tflookup(texval(v));
  var m: Med;
  m.sigma = select(P[P_DENSITY] * c.w, 0.0, cut(w, v));
  m.col = c.rgb;
  return m;
}
fn boxhit(ov: vec3f, dv: vec3f) -> vec2f {
  var lo = 0.0;
  var hi = 1e30;
  for (var a = 0u; a < 3u; a++) {
    let bmin = max(-0.5, P[P_CROP_LO + a] - 0.5);
    let bmax = min(P[P_DIMS + a] - 0.5, P[P_CROP_HI + a] + 0.5);
    if (abs(dv[a]) < 1e-12) {
      if (ov[a] < bmin || ov[a] > bmax) { return vec2f(1.0, 0.0); }
      continue;
    }
    let inv = 1.0 / dv[a];
    var ta = (bmin - ov[a]) * inv;
    var tb = (bmax - ov[a]) * inv;
    if (ta > tb) { let s = ta; ta = tb; tb = s; }
    lo = max(lo, ta);
    hi = min(hi, tb);
  }
  return vec2f(lo, hi);
}

// mode 0: delta tracking (the collision distance, or -1); mode 1: ratio tracking (the transmittance).
fn track(ow: vec3f, dw: vec3f, ov: vec3f, dv: vec3f, t0: f32, t1: f32, mode: u32) -> f32 {
  let B = P[P_BRICK];
  let g = vec3i(i32(P[P_MGRID]), i32(P[P_MGRID + 1u]), i32(P[P_MGRID + 2u]));
  var T = 1.0;
  var t = t0;
  let p = ov + dv * (t + 1e-4);
  var c = clamp(vec3i(floor((p + vec3f(0.5)) / B)), vec3i(0), g - vec3i(1));
  var stp = vec3i(0);
  var tnext = vec3f(1e30);
  var tdelta = vec3f(1e30);
  for (var a = 0u; a < 3u; a++) {
    if (dv[a] > 0.0) { stp[a] = 1; tnext[a] = (f32(c[a] + 1) * B - 0.5 - ov[a]) / dv[a]; tdelta[a] = B / dv[a]; }
    else if (dv[a] < 0.0) { stp[a] = -1; tnext[a] = (f32(c[a]) * B - 0.5 - ov[a]) / dv[a]; tdelta[a] = -B / dv[a]; }
  }
  for (var guard = 0; guard < 4096 && t < t1; guard++) {
    var ax = 0u;
    if (tnext.y < tnext[ax]) { ax = 1u; }
    if (tnext.z < tnext[ax]) { ax = 2u; }
    let tend = min(tnext[ax], t1);
    let mj = maj[(u32(c.z) * u32(g.y) + u32(c.y)) * u32(g.x) + u32(c.x)];
    if (mj > 0.0) {
      for (var k = 0; k < 1024; k++) {
        t -= log(1.0 - rnd()) / mj;
        if (t >= tend) { break; }
        let s = medium(ow + dw * t, ov + dv * t).sigma;
        if (mode == 0u) {
          if (rnd() * mj < s) { return t; }
        } else {
          T *= max(0.0, 1.0 - s / mj);
          if (T < 0.05) {
            if (rnd() < 0.5) { return 0.0; }
            T *= 2.0;
          }
        }
      }
    }
    t = tend;
    if (t >= t1) { break; }
    c[ax] += stp[ax];
    if (c[ax] < 0 || c[ax] >= g[ax]) { break; }
    tnext[ax] += tdelta[ax];
  }
  return select(T, -1.0, mode == 0u);
}

fn envlight(d: vec3f) -> vec3f {
  let u = dot(d, pv(P_ENV_UP));
  let top = pv(P_ENV_TOP);
  let hor = pv(P_ENV_HORIZON);
  let bot = pv(P_ENV_BOTTOM);
  let c = select(hor * (1.0 + u) + bot * (-u), hor * (1.0 - u) + top * u, u > 0.0);
  return c * P[P_ENV_SCALE];
}
fn basis(n: vec3f) -> mat2x3f {
  let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.9);
  let t = normalize(cross(a, n));
  return mat2x3f(t, cross(n, t));
}
fn cosdir(n: vec3f) -> vec3f {
  let u1 = rnd();
  let u2 = rnd();
  let r = sqrt(u1);
  let ph = 6.2831853 * u2;
  let b = basis(n);
  return normalize(b[0] * (r * cos(ph)) + b[1] * (r * sin(ph)) + n * sqrt(max(0.0, 1.0 - u1)));
}
fn hg(c: f32, g: f32) -> f32 {
  let d = 1.0 + g * g - 2.0 * g * c;
  return (1.0 - g * g) / (12.566371 * d * sqrt(d));
}
fn hgdir(w: vec3f, g: f32) -> vec3f {
  let u1 = rnd();
  let u2 = rnd();
  var c: f32;
  if (abs(g) < 1e-3) { c = 1.0 - 2.0 * u1; }
  else { let s = (1.0 - g * g) / (1.0 - g + 2.0 * g * u1); c = (1.0 + g * g - s * s) / (2.0 * g); }
  let sn = sqrt(max(0.0, 1.0 - c * c));
  let ph = 6.2831853 * u2;
  let b = basis(w);
  return normalize(b[0] * (sn * cos(ph)) + b[1] * (sn * sin(ph)) + w * c);
}
fn phong_exp(r: f32) -> f32 { return max(1.0, 2.0 / max(r * r, 1e-4) - 2.0); }
fn brdf_cos(n: vec3f, wo: vec3f, wl: vec3f, albedo: vec3f, spec: f32, rough: f32) -> vec3f {
  let cl = dot(n, wl);
  if (cl <= 0.0) { return vec3f(0.0); }
  let h = normalize(wo + wl);
  let e = phong_exp(rough);
  let s = spec * (e + 8.0) / 25.132741 * pow(max(dot(n, h), 0.0), e);
  return (albedo * ((1.0 - spec) * 0.31830989) + vec3f(s)) * cl;
}

struct Ray { o: vec3f, d: vec3f }
fn makeray(x: u32, y: u32, jx: f32, jy: f32, lens: bool) -> Ray {
  let W = f32(U.x);
  let H = f32(U.y);
  let nx = ((f32(x) + jx) / W) * 2.0 - 1.0;
  let ny = 1.0 - ((f32(y) + jy) / H) * 2.0;
  let a = mul4(P_INVVP, vec4f(nx, ny, -1.0, 1.0));
  let b = mul4(P_INVVP, vec4f(nx, ny, 1.0, 1.0));
  var r: Ray;
  r.o = a.xyz / a.w;
  r.d = normalize(b.xyz / b.w - r.o);
  if (lens && P[P_APERTURE] > 0.0) {
    let e = mul4(P_INVVP, vec4f(0.0, 0.0, 1.0, 0.0));
    let eye = select(r.o, e.xyz / e.w, abs(e.w) > 1e-12);
    let c = mul4(P_INVVP, vec4f(0.0, 0.0, 1.0, 1.0));
    let fwd = normalize(c.xyz / c.w - eye);
    let focus = eye + r.d * (P[P_FOCUS] / max(dot(r.d, fwd), 1e-3));
    let bs = basis(fwd);
    let rr = P[P_APERTURE] * sqrt(rnd());
    let ph = 6.2831853 * rnd();
    r.o = eye + bs[0] * (rr * cos(ph)) + bs[1] * (rr * sin(ph));
    r.d = normalize(focus - r.o);
  }
  return r;
}

@compute @workgroup_size(8, 8)
fn trace(@builtin(global_invocation_id) gid: vec3u) {
  let x = gid.x;
  let y = gid.y;
  if (x >= U.x || y >= U.y) { return; }
  rs = pcg((y * U.x + x) ^ pcg(U.z * 9781u + 1u));
  var ray = makeray(x, y, rnd(), rnd(), true);
  var ow = ray.o;
  var dw = ray.d;
  var L = vec3f(0.0);
  var thr = vec3f(1.0);
  var alpha = 0.0;
  let maxb = u32(P[P_MAX_BOUNCES]);
  let ldir = pv(P_LIGHT_DIR);
  let lrgb = pv(P_LIGHT_RGB);
  for (var bounce = 0u; bounce <= maxb; bounce++) {
    let ov = aff(P_VOX_FROM_WORLD, ow);
    let dv = lin(P_VOX_FROM_WORLD, dw);
    let iv = boxhit(ov, dv);
    var tc = -1.0;
    if (iv.y > iv.x) { tc = track(ow, dw, ov, dv, iv.x, iv.y, 0u); }
    if (tc < 0.0) {
      if (bounce == 0u) {
        L = pv(P_BG) * P[P_BG + 3u];
        alpha = P[P_BG + 3u];
      } else {
        L += thr * envlight(dw);
      }
      break;
    }
    if (bounce == 0u) { alpha = 1.0; }
    let w = ow + dw * tc;
    let v = ov + dv * tc;
    var albedo = medium(w, v).col * P[P_ALBEDO];
    let gv = vec3f(texval(v + vec3f(1.0, 0.0, 0.0)) - texval(v - vec3f(1.0, 0.0, 0.0)),
                   texval(v + vec3f(0.0, 1.0, 0.0)) - texval(v - vec3f(0.0, 1.0, 0.0)),
                   texval(v + vec3f(0.0, 0.0, 1.0)) - texval(v - vec3f(0.0, 0.0, 1.0))) * 0.5;
    let gm = length(gv);
    if (P[P_INSET] > 0.0 && gm > 1e-6) {
      // The colour a little way along the gradient, on the more opaque side: the tissue beneath a surface.
      let d = gv * (P[P_INSET] / gm);
      let ca = tflookup(texval(v + d));
      let cb = tflookup(texval(v - d));
      let c = select(cb, ca, ca.w >= cb.w);
      albedo = c.rgb * P[P_ALBEDO];
    }
    let psurf = P[P_SHADE_MIX] * (1.0 - exp(-P[P_GRAD_SCALE] * length(gv)));
    let wo = -dw;
    let lvo = aff(P_VOX_FROM_WORLD, w);
    let lvd = lin(P_VOX_FROM_WORLD, ldir);
    let li = boxhit(lvo, lvd);
    var Tl = 1.0;
    if (li.y > li.x) { Tl = track(w, ldir, lvo, lvd, max(li.x, 0.0), li.y, 1u); }
    if (rnd() < psurf) {
      var n = -normalize(lin3(P_WORLD_NORMAL, gv));
      if (dot(n, wo) < 0.0) { n = -n; }
      let spec = P[P_SPECULAR];
      let rough = P[P_ROUGHNESS];
      if (Tl > 0.0) { L += thr * brdf_cos(n, wo, ldir, albedo, spec, rough) * lrgb * Tl; }
      var nd: vec3f;
      if (rnd() < spec) {
        let r = normalize(n * (2.0 * dot(n, wo)) - wo);
        let e = phong_exp(rough);
        let ct = pow(rnd(), 1.0 / (e + 1.0));
        let st = sqrt(max(0.0, 1.0 - ct * ct));
        let ph = 6.2831853 * rnd();
        let b = basis(r);
        nd = normalize(b[0] * (st * cos(ph)) + b[1] * (st * sin(ph)) + r * ct);
        if (dot(nd, n) <= 0.0) { break; }
      } else {
        nd = cosdir(n);
        thr *= albedo;
      }
      dw = nd;
    } else {
      let g = P[P_PHASE_G];
      if (Tl > 0.0) { L += thr * albedo * lrgb * (hg(dot(dw, ldir), g) * Tl); }
      thr *= albedo;
      dw = hgdir(dw, g);
    }
    ow = w;
    if (bounce >= 2u) {
      let q = min(0.95, max(thr.x, max(thr.y, thr.z)));
      if (rnd() > q) { break; }
      thr *= 1.0 / q;
    }
  }
  let i = y * U.x + x;
  accum[i] += vec4f(L, alpha);
}

@compute @workgroup_size(8, 8)
fn firsthit(@builtin(global_invocation_id) gid: vec3u) {
  let x = gid.x;
  let y = gid.y;
  if (x >= U.x || y >= U.y) { return; }
  rs = 1u;
  let ray = makeray(x, y, 0.5, 0.5, false);
  let ov = aff(P_VOX_FROM_WORLD, ray.o);
  let dv = lin(P_VOX_FROM_WORLD, ray.d);
  let iv = boxhit(ov, dv);
  var out = 1.0;
  if (iv.y > iv.x) {
    let dt = P[P_STEP] / max(length(dv), 1e-12);
    var acc = 0.0;
    var t = iv.x;
    for (var k = 0; k < 8192 && t < iv.y; k++) {
      let w = ray.o + ray.d * t;
      let s = medium(w, ov + dv * t).sigma;
      acc = 1.0 - (1.0 - acc) * exp(-s * dt);
      if (acc >= P[P_OPAQUE_LIMIT]) {
        let c = mul4(P_VP, vec4f(w, 1.0));
        out = clamp((c.z / c.w) * 0.5 + 0.5, 0.0, 1.0);
        break;
      }
      t += dt;
    }
  }
  depthbuf[y * U.x + x] = out;
}

@compute @workgroup_size(64)
fn majorant(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&bounds)) { return; }
  let b = clamp(bounds[i], vec2f(0.0), vec2f(1.0));
  let a = u32(floor(b.x * f32(TF_SIZE - 1u)));
  let e = min(TF_SIZE - 1u, u32(ceil(b.y * f32(TF_SIZE - 1u))));
  var m = 0.0;
  for (var k = a; k <= e; k++) { m = max(m, tf[k].w); }
  maj[i] = P[P_DENSITY] * m;
}

@compute @workgroup_size(8, 8)
fn tonemap(@builtin(global_invocation_id) gid: vec3u) {
  let x = gid.x;
  let y = gid.y;
  if (x >= U.x || y >= U.y) { return; }
  let a = accum[y * U.x + x];
  let inv = 1.0 / f32(max(U.w, 1u));
  var c = a.rgb * inv * P[P_EXPOSURE];
  c = (c * (2.51 * c + vec3f(0.03))) / (c * (2.43 * c + vec3f(0.59)) + vec3f(0.14));
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  c = select(1.055 * pow(c, vec3f(1.0 / 2.4)) - vec3f(0.055), 12.92 * c, c <= vec3f(0.0031308));
  let al = clamp(a.w * inv, 0.0, 1.0);
  let q = vec4u(vec4f(c, al) * 255.0 + vec4f(0.5));
  outrgba[y * U.x + x] = q.x | (q.y << 8u) | (q.z << 16u) | (q.w << 24u);
}
