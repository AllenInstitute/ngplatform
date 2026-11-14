function s(t,e){const o=e.split(",").map(a=>a.trim().split(/\s+/).map(Number)),r=o.length,i=o.map(a=>`vec3(${a.map(n=>g(n)).join(", ")})`).join(`,
    `);return`vec3 ${t}(float x) {
  const vec3 nodes[${r}] = vec3[${r}](
    ${i});
  float s = clamp(x, 0.0, 1.0) * ${g(r-1)};
  int i = int(min(floor(s), ${g(r-2)}));
  return mix(nodes[i], nodes[i + 1], s - float(i));
}`}function g(t){const e=String(Number(t.toFixed(3)));return e.includes(".")?e:`${e}.0`}const R=t=>[1,3,5].map(e=>(parseInt(t.slice(e,e+2),16)/255).toFixed(3)).join(" ");function l(t,e,o){return{id:t,label:e,definition:o,shader:r=>`${r}
// Colour map: ${t}
${o}
void main() {
  emitRGB(colormap(normalized()));
}
`}}const p={viridis:"0.267 0.005 0.329, 0.277 0.050 0.376, 0.282 0.095 0.417, 0.283 0.135 0.453, 0.279 0.175 0.483, 0.271 0.213 0.507, 0.259 0.251 0.524, 0.245 0.287 0.537, 0.230 0.321 0.545, 0.215 0.354 0.551, 0.200 0.386 0.555, 0.186 0.417 0.557, 0.173 0.447 0.558, 0.161 0.477 0.558, 0.150 0.506 0.557, 0.138 0.536 0.555, 0.128 0.565 0.551, 0.121 0.594 0.544, 0.120 0.624 0.534, 0.131 0.653 0.521, 0.155 0.682 0.503, 0.193 0.710 0.481, 0.241 0.737 0.455, 0.299 0.762 0.423, 0.363 0.787 0.387, 0.433 0.809 0.345, 0.508 0.829 0.299, 0.587 0.847 0.249, 0.669 0.862 0.195, 0.753 0.875 0.143, 0.836 0.886 0.102, 0.917 0.896 0.101, 0.993 0.906 0.144",magma:"0.001 0.000 0.014, 0.014 0.012 0.068, 0.039 0.031 0.133, 0.074 0.052 0.202, 0.112 0.065 0.276, 0.158 0.068 0.351, 0.210 0.062 0.417, 0.264 0.060 0.461, 0.315 0.071 0.485, 0.364 0.090 0.498, 0.413 0.110 0.504, 0.461 0.129 0.508, 0.511 0.147 0.508, 0.560 0.165 0.505, 0.611 0.181 0.499, 0.662 0.197 0.490, 0.713 0.214 0.476, 0.764 0.232 0.459, 0.814 0.254 0.438, 0.860 0.281 0.414, 0.901 0.316 0.390, 0.935 0.361 0.370, 0.959 0.414 0.360, 0.976 0.471 0.363, 0.986 0.530 0.380, 0.992 0.589 0.407, 0.996 0.648 0.442, 0.997 0.706 0.483, 0.997 0.763 0.530, 0.995 0.821 0.580, 0.993 0.878 0.634, 0.990 0.935 0.690, 0.987 0.991 0.750",inferno:"0.001 0.000 0.014, 0.014 0.011 0.072, 0.042 0.028 0.141, 0.081 0.043 0.214, 0.128 0.047 0.290, 0.182 0.040 0.354, 0.237 0.037 0.396, 0.289 0.045 0.418, 0.340 0.062 0.429, 0.390 0.080 0.433, 0.439 0.099 0.432, 0.489 0.116 0.426, 0.539 0.134 0.416, 0.588 0.152 0.401, 0.637 0.170 0.382, 0.686 0.191 0.359, 0.733 0.214 0.332, 0.778 0.241 0.302, 0.820 0.273 0.269, 0.858 0.309 0.233, 0.892 0.350 0.197, 0.921 0.395 0.158, 0.945 0.445 0.119, 0.964 0.497 0.078, 0.977 0.553 0.038, 0.985 0.610 0.025, 0.988 0.669 0.060, 0.985 0.730 0.122, 0.976 0.791 0.197, 0.962 0.852 0.287, 0.949 0.911 0.396, 0.952 0.961 0.525, 0.988 0.998 0.645",plasma:"0.050 0.030 0.528, 0.132 0.022 0.563, 0.193 0.018 0.590, 0.247 0.014 0.613, 0.299 0.010 0.631, 0.349 0.004 0.646, 0.398 0.001 0.656, 0.446 0.002 0.660, 0.493 0.012 0.658, 0.539 0.034 0.649, 0.583 0.067 0.634, 0.624 0.102 0.612, 0.663 0.137 0.587, 0.700 0.172 0.559, 0.734 0.208 0.530, 0.766 0.243 0.500, 0.796 0.278 0.471, 0.825 0.313 0.443, 0.851 0.349 0.416, 0.877 0.385 0.389, 0.900 0.422 0.362, 0.922 0.460 0.335, 0.941 0.499 0.308, 0.958 0.540 0.281, 0.972 0.582 0.254, 0.983 0.625 0.227, 0.991 0.671 0.201, 0.994 0.718 0.177, 0.993 0.766 0.157, 0.988 0.817 0.144, 0.976 0.868 0.143, 0.959 0.922 0.152, 0.940 0.975 0.131",cividis:"0.000 0.135 0.305, 0.000 0.158 0.357, 0.000 0.179 0.414, 0.017 0.198 0.441, 0.102 0.220 0.436, 0.153 0.242 0.430, 0.194 0.264 0.426, 0.230 0.286 0.424, 0.263 0.307 0.423, 0.294 0.329 0.424, 0.323 0.350 0.426, 0.352 0.372 0.430, 0.380 0.394 0.435, 0.407 0.416 0.442, 0.434 0.439 0.451, 0.460 0.461 0.461, 0.487 0.484 0.471, 0.516 0.507 0.473, 0.546 0.530 0.472, 0.576 0.554 0.469, 0.607 0.578 0.464, 0.638 0.602 0.457, 0.669 0.627 0.449, 0.701 0.652 0.438, 0.733 0.678 0.425, 0.766 0.704 0.410, 0.799 0.731 0.392, 0.833 0.759 0.371, 0.867 0.786 0.346, 0.902 0.815 0.317, 0.937 0.844 0.281, 0.973 0.874 0.234, 0.996 0.909 0.218",turbo:"0.190 0.072 0.232, 0.225 0.163 0.450, 0.251 0.252 0.632, 0.268 0.337 0.779, 0.276 0.420 0.890, 0.276 0.500 0.965, 0.259 0.578 0.999, 0.215 0.657 0.981, 0.160 0.733 0.925, 0.113 0.803 0.848, 0.093 0.863 0.765, 0.118 0.910 0.690, 0.192 0.947 0.599, 0.299 0.976 0.495, 0.421 0.994 0.391, 0.540 0.999 0.300, 0.638 0.991 0.236, 0.721 0.967 0.207, 0.799 0.928 0.204, 0.870 0.877 0.215, 0.929 0.817 0.226, 0.971 0.752 0.226, 0.992 0.681 0.206, 0.996 0.595 0.172, 0.985 0.502 0.132, 0.961 0.408 0.092, 0.925 0.323 0.058, 0.880 0.252 0.035, 0.823 0.191 0.019, 0.755 0.137 0.009, 0.675 0.089 0.004, 0.583 0.049 0.005, 0.480 0.016 0.011"},A=["#053061","#2166ac","#4393c3","#92c5de","#d1e5f0","#f7f7f7","#fddbc7","#f4a582","#d6604d","#b2182b","#67001f"].map(R).join(", "),f={...p,ge:"0 0 0, 0 0.471 0.471, 0.490 0 0.980, 1 0.502 0, 1 1 1",nih:"0 0 0, 0.333 0 0.550, 0 0 0.900, 0 0.750 0.250, 0.900 0.900 0, 1 0.500 0, 1 0 0",pet:"0 0 0, 0 0 0.500, 0.500 0 0.500, 1 0 0, 1 0.650 0, 1 1 1",redblue:A},d=[{id:"grayscale",label:"Grayscale",shader:t=>`${t}
void main() {
  emitGrayscale(normalized());
}
`},{id:"heat",label:"Heat (min, mid, max)",shader:(t,{signed:e})=>{const o=e?`float raw = float(toRaw(getDataValue()));
  float t = normalized(abs(toRaw(getDataValue())));`:`float raw = 1.0;
  float t = normalized();`;return`${_(t)}
#uicontrol float mid slider(min=0, max=1, default=0.5, step=0.01)
#uicontrol bool opaque checkbox(default=false)
// Colour map: heat
vec3 heat(float t, bool negative) {
  float m = clamp(mid, 0.01, 0.99);
  vec3 low = negative ? vec3(0.0, 0.0, 0.5) : vec3(0.5, 0.0, 0.0);
  vec3 full = negative ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 high = negative ? vec3(0.0, 1.0, 1.0) : vec3(1.0, 1.0, 0.0);
  if (t < m) return mix(low, full, t / m);
  return mix(full, high, clamp((t - m) / (1.0 - m), 0.0, 1.0));
}
void main() {
  ${o}
  // Below min: nothing, so the image underneath shows (as an overlay in Freeview).
  if (t < 0.0) {
    if (opaque) emitRGB(vec3(0.0));
    else emitTransparent();
    return;
  }
  // From min to mid the colour fades in over the image, as Freeview blends it.
  float alpha = opaque ? 1.0 : clamp(t / clamp(mid, 0.01, 0.99), 0.0, 1.0);
  emitRGBA(vec4(heat(t, raw < 0.0), alpha));
}
`}},l("jet","Jet",`vec3 colormap(float x) {
  x = clamp(x, 0.0, 1.0);
  return clamp(vec3(1.5) - abs(4.0 * x - vec3(3.0, 2.0, 1.0)), 0.0, 1.0);
}`),l("ge","GE colour",s("colormap",f.ge)),l("nih","NIH",s("colormap",f.nih)),l("pet","PET",s("colormap",f.pet)),{id:"binary",label:"Binary colour",shader:t=>`${t}
#uicontrol vec3 colour color(default="#ff3030")
#uicontrol bool shade checkbox(default=false)
// Colour map: binary
void main() {
  // Above the contrast's minimum: one colour (shaded by the value if asked); below it, nothing.
  float t = normalized();
  if (t <= 0.0) {
    emitTransparent();
    return;
  }
  emitRGB(shade ? colour * clamp(t, 0.0, 1.0) : colour);
}
`},l("hot","Hot",`vec3 colormap(float x) {
  x = clamp(x, 0.0, 1.0);
  return clamp(vec3(3.0 * x, 3.0 * x - 1.0, 3.0 * x - 2.0), 0.0, 1.0);
}`),l("cool","Cool",`vec3 colormap(float x) {
  x = clamp(x, 0.0, 1.0);
  return vec3(x, 1.0 - x, 1.0);
}`),l("viridis","Viridis",s("colormap",p.viridis)),l("magma","Magma",s("colormap",p.magma)),l("inferno","Inferno",s("colormap",p.inferno)),l("plasma","Plasma",s("colormap",p.plasma)),l("cividis","Cividis",s("colormap",p.cividis)),l("turbo","Turbo",s("colormap",p.turbo)),l("cubehelix","Cubehelix",`vec3 colormap(float x) {
  // Green (2011): start 0.5, rotations -1.5, hue 1, gamma 1.
  x = clamp(x, 0.0, 1.0);
  float angle = 6.2831853 * (0.5 / 3.0 + 1.0 - 1.5 * x);
  float amp = x * (1.0 - x) / 2.0;
  float c = cos(angle);
  float s = sin(angle);
  return clamp(x + amp * vec3(-0.14861 * c + 1.78277 * s, -0.29227 * c - 0.90649 * s, 1.97294 * c), 0.0, 1.0);
}`),l("redblue","Red-blue (diverging)",s("colormap",f.redblue))],S="#uicontrol invlerp normalized",$=/^#uicontrol\s+invlerp\s+normalized\b.*$/m;function w(t){return $.exec(t)?.[0].trim()??S}function _(t){return/\bclamp\s*=/.test(t)?t.replace(/\bclamp\s*=\s*\w+/,"clamp=false"):/\(.*\)\s*$/.test(t)?t.replace(/\)\s*$/,", clamp=false)").replace("(, ","("):`${t}(clamp=false)`}function y(t){return t.replace(/,?\s*clamp\s*=\s*false/,"").replace(/\(\s*\)$/,"").replace(/\(\s*,\s*/,"(")}function C(t,e,o={}){return d.find(i=>i.id===t)?.shader(y(w(e)),o)}const x=t=>t.replace($,"").replace(/\s+/g," ").trim();function G(t,e={}){const o=x(t);for(const r of d){const i=r.shader(y(w(t)),e);if(x(i)===o)return r.id}}const z={grayscale:t=>[t,t,t],jet:t=>[0,1,2].map(e=>u(1.5-Math.abs(4*t-(3-e)))),hot:t=>[u(3*t),u(3*t-1),u(3*t-2)],cool:t=>[t,1-t,1],cubehelix:t=>{const e=6.2831853*(1.1666666666666667-1.5*t),o=t*(1-t)/2,r=Math.cos(e),i=Math.sin(e);return[u(t+o*(-.14861*r+1.78277*i)),u(t+o*(-.29227*r-.90649*i)),u(t+o*(1.97294*r))]}};function u(t){return Math.min(1,Math.max(0,t))}function P(t,e=32){const o=f[t],r=Array.from({length:e},(a,n)=>e===1?0:n/(e-1));if(o!==void 0){const a=o.split(",").map(n=>n.trim().split(/\s+/).map(Number));return r.map(n=>{const h=u(n)*(a.length-1),c=Math.min(Math.floor(h),a.length-2),M=h-c;return[0,1,2].map(v=>a[c][v]+(a[c+1][v]-a[c][v])*M)})}const i=z[t];return i===void 0?void 0:r.map(a=>i(a))}const b="// Colour by: ",j=d.filter(t=>t.definition!==void 0).map(t=>({id:t.id,label:t.label}));function m(t){const e=String(Number(t.toPrecision(6)));return/[.e]/.test(e)?e:`${e}.0`}function N(t){const e=[...new Set(t.filter(r=>Number.isInteger(r)&&r>=0))].sort((r,i)=>r-i),o=[];for(const r of e){const i=o[o.length-1];i!==void 0&&r===i[1]+1?i[1]=r:o.push([r,r])}return o}const O=256;function E(t){const e=[`${b}${JSON.stringify(t)}`],o=[];if(t.by==="group"&&t.group!==void 0){const r=t.group;o.push(`  float group = prop_${r.attribute}();`);const i=r.shown===void 0?void 0:N(r.shown);i!==void 0&&i.length<=O&&(e.push("bool zvShown(float group) {","  int k = int(floor(group + 0.5));",...i.map(([a,n])=>a===n?`  if (k == ${a}) return true;`:`  if (k >= ${a} && k <= ${n}) return true;`),"  return false;","}"),o.push("  if (!zvShown(group)) discard;")),r.colours==="stored"&&r.colorAttribute!==void 0?(e.push("vec3 zvPacked(float packed) {","  // 0xRRGGBB, exact as a float up to 2^24.","  float v = floor(packed + 0.5);","  return vec3(floor(v / 65536.0), mod(floor(v / 256.0), 256.0), mod(v, 256.0)) / 255.0;","}"),o.push(`  emitRGB(zvPacked(prop_${r.colorAttribute}()));`)):(e.push("vec3 zvPalette(float group) {","  // A colour per group: hues spread by the golden angle, two lightnesses alternating.","  float k = floor(group + 0.5);","  float h = fract(k * 0.61803398875);","  vec3 c = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);","  return mix(vec3(1.0), c, mod(k, 2.0) < 1.0 ? 0.75 : 0.55) * (mod(floor(k / 2.0), 2.0) < 1.0 ? 1.0 : 0.8);","}"),o.push("  emitRGB(zvPalette(group));"))}else if(t.by==="attribute"&&t.attribute!==void 0){const[r,i]=t.range??[0,1],a=i-r||1,n=m(Math.abs(a)/1e3);e.push(`#uicontrol float low slider(min=${m(r)}, max=${m(i)}, step=${n}, default=${m(t.low??r)})`,`#uicontrol float high slider(min=${m(r)}, max=${m(i)}, step=${n}, default=${m(t.high??i)})`);const h=d.find(c=>c.id===(t.colormap??"viridis"))?.definition??d.find(c=>c.definition!==void 0)?.definition??"";e.push(h),o.push(`  float value = prop_${t.attribute}();`),t.hideOutside&&o.push("  if (!(value >= low && value <= high)) discard;"),o.push("  emitRGB(colormap(clamp((value - low) / max(high - low, 1e-12), 0.0, 1.0)));")}else o.push("  emitDefault();");return`${e.join(`
`)}
void main() {
${o.join(`
`)}
}
`}function B(t){const e=t.split(`
`,1)[0];if(e.startsWith(b))try{const o=JSON.parse(e.slice(b.length));return o!==null&&typeof o=="object"&&typeof o.by=="string"?o:void 0}catch{return}}function L(t){const e=[];for(let a=0;a<t.length;++a)Number.isFinite(t[a])&&e.push(t[a]);if(e.length===0)return{range:[0,1],low:0,high:1};e.sort((a,n)=>a-n);const o=a=>e[Math.min(e.length-1,Math.floor(a*(e.length-1)))],r=e[0],i=e[e.length-1]===r?r+1:e[e.length-1];return{range:[r,i],low:o(.02),high:Math.max(o(.98),o(.02))}}function I(t){t.startsWith("obj:")&&(t=`obj_${t.slice(4)}`);let e=t.replace(/[^a-zA-Z0-9_]/g,"_");return/^[a-z]/.test(e)||(e=`a_${e}`),e.replace(/__+/g,"_")}function F(t){const e=t?.skeletonRendering,o=typeof e?.shader=="string"?B(e.shader):void 0;if(o===void 0||o.by==="segment")return;if(o.by==="group")return o.group===void 0?void 0:o;if(o.attribute===void 0)return;const r=i=>{const a=e?.shaderControls?.[i];return typeof a=="number"&&Number.isFinite(a)?a:void 0};return{...o,low:r("low")??o.low,high:r("high")??o.high}}function D(t){return t?.by==="group"&&t.group!==void 0?[t.group.attribute,...t.group.colours==="stored"&&t.group.colorAttribute?[t.group.colorAttribute]:[]]:t?.by==="attribute"&&t.attribute!==void 0?[t.attribute]:[]}function T(t){const e=Math.floor(t+.5),o=(e*.61803398875%1+1)%1,r=(e%2+2)%2<1?.75:.55,i=(Math.floor(e/2)%2+2)%2<1?1:.8;return[0,4,2].map(a=>(1+(Math.min(1,Math.max(0,Math.abs(((o*6+a)%6+6)%6-3)-1))-1)*r)*i)}export{d as C,O as M,G as a,L as b,C as c,I as d,j as e,E as f,B as g,P as h,T as i,D as j,F as l};
