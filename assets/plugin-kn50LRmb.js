import{e as b,n as L,h as pe,l as ce,t as cs,j as Js,d as ls,r as se,m as Q,a as Z,f as R,p as I,c as le,i as we,o as Fs}from"./dom-CEvR2cwn.js";import{W as Zs}from"./worker_rpc-BGQIcfWl.js";import{w as Qs}from"./chunk_host-nd9vUssm.js";import{R as ei,u as hs,v as Is,o as V,a as ds,b as ti,m as si,c as ii,d as oi,s as ni,e as us,f as ai,g as ps,l as fs,h as ri,L as vs}from"./view-Bbn7e6Vr.js";import"./shared_chunks-BvbSDm9W.js";function ci(a,e,t){return{base:`${e.replace(/\/+$/,"")}/svc/render`,token:"",viaRunner:!0,hostFetch:t,label:a}}function he(a,e,t={},s=!1){if(a.hostFetch){const i=new Headers(t.headers);return s&&i.set("Content-Type","application/json"),a.hostFetch(`render${e}`,{...t,headers:i})}return fetch(`${a.base}${e}`,{...t,headers:{...li(a,s),...t.headers}})}function li(a,e){const t={};return a.token&&(a.viaRunner?t.Authorization=`Bearer ${a.token}`:t["X-NGP-Service-Token"]=a.token),e&&(t["Content-Type"]="application/json"),t}class Y extends Error{constructor(e,t=0,s={},i){super(e),this.status=t,this.detail=s,this.retryAfter=i}}function hi(a){return a<1024?`${Math.round(a)} MB`:`${(a/1024).toFixed(a<10240?1:0)} GB`}function Fe(a){if(!(a instanceof Y))return;const e=a.detail,t=s=>typeof e[s]=="number"?hi(e[s]):void 0;if(e.reason==="gpu-budget"||a.status===503&&e.need_mb!==void 0){const s=t("need_mb"),i=t("free_mb");return{text:`The render computer's GPU is busy${s&&i?` (needs ${s}, ${i} free)`:""}. Retry, or close another view.`,retry:!0}}if(e.reason==="queue-full"||a.status===429)return{text:"Too many jobs waiting on the render computer. Retry when one has finished.",retry:!0};if(e.reason==="disk"||a.status===507){const s=t("need_mb"),i=t("free_mb");return{text:`The render computer's disk is nearly full${s?` (needs ${s}${i?`, ${i} free`:""})`:""}. Free some space there, then Retry.`,retry:!0}}if(a.status===400&&typeof e.error=="string")return{text:e.error,retry:!1}}async function N(a,e,t,s,i,o={}){const n=await he(a,t,{...o,method:e,body:s===void 0?void 0:JSON.stringify(s),signal:i},s!==void 0),r=await n.text();let h;try{h=r?JSON.parse(r):void 0}catch{h=r}if(!n.ok){const l=h&&typeof h=="object"?h:{},u=typeof l.error=="string"?l.error:`${n.status} ${n.statusText}`,d=Number(n.headers.get("Retry-After")),f=Number.isFinite(d)&&d>0?d:void 0,v=Fe(new Y("",n.status,l));throw new Y(v?v.text:`${e} ${t}: ${u}`,n.status,l,f)}return h}function di(a){const e=a.gpu;if(e.backend!=="cuda")return`No GPU: ${e.error??""}`;const t=o=>(o/1024).toFixed(o<102400?1:0).replace(/\.0$/,""),s=[e.name??"GPU"];a.budget?s.push(`GPU: ${t(a.budget.used_mb)} of ${t(a.budget.total_mb)} GB in use`):s.push(`${Math.round((e.free_mb??0)/1024)} of ${Math.round((e.total_mb??0)/1024)} GB free`);const i=a.queue;if(i&&(i.running||i.waiting.length>0)){const o=i.waiting.length;s.push([i.running?"1 job running":"",o?`${o} waiting`:""].filter(Boolean).join(", "))}return s.join(" · ")}class ui{constructor(e){this.link=e}info(e){return N(this.link,"GET","/info",void 0,e)}resolve(e,t,s={}){return N(this.link,"POST",`/sessions/${e}/resolve`,{preset:t,overrides:s})}presets(){return N(this.link,"GET","/presets")}open(e,t){return N(this.link,"POST","/sessions",{volume:e,labels:t})}session(e){return N(this.link,"GET",`/sessions/${e}`)}close(e,t=!1){return N(this.link,"DELETE",`/sessions/${e}`,void 0,void 0,t?{keepalive:!0}:{})}setView(e,t){return N(this.link,"PUT",`/sessions/${e}/view`,t)}still(e,t){return N(this.link,"POST",`/sessions/${e}/stills`,t)}stillInfo(e){return N(this.link,"GET",`/stills/${e}`)}cancelStill(e){return N(this.link,"DELETE",`/stills/${e}`)}async stillFile(e){const t=await he(this.link,`/stills/${e}/file`);if(!t.ok)throw new Y(`still file: ${t.status}`,t.status);return t.blob()}movie(e,t){return N(this.link,"POST",`/sessions/${e}/movies`,t)}movieInfo(e){return N(this.link,"GET",`/movies/${e}`)}cancelMovie(e){return N(this.link,"DELETE",`/movies/${e}`)}splat(e,t){return N(this.link,"POST",`/sessions/${e}/splats`,t)}splatInfo(e){return N(this.link,"GET",`/splats/${e}`)}cancelSplat(e){return N(this.link,"DELETE",`/splats/${e}`)}async splatFile(e,t){const s=await he(this.link,`/splats/${e}/file/${t}`);if(!s.ok)throw new Y(`splat file: ${s.status}`);return s.arrayBuffer()}async movieFile(e){const t=await he(this.link,`/movies/${e}/file`);if(!t.ok)throw new Y(`movie file: ${t.status}`);return t.blob()}async frame(e,t,s,i=-1){const o=await he(this.link,`/sessions/${e}/frame?after=${t}&timeout=20&have=${i}`,{signal:s});if(o.status===204)return;if(!o.ok){const m=(await o.json().catch(()=>({}))).error;throw new Y(`frame: ${m??o.status}`,o.status)}let n=await o.blob();const r=m=>Number(o.headers.get(m)??0),h=r("X-Version"),l=r("X-Distance-Offset");let u;if(l&&o.headers.get("X-Distance-Format")==="float16-zlib"){const m=n.slice(l);n=n.slice(0,l);const T=r("X-Distance-Width"),y=r("X-Distance-Height"),S=r("X-Distance-Scale");u=new Response(m.stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer().then(E=>({version:h,width:T,height:y,data:pi(new Uint16Array(E),S)}))}const d=r("X-Alpha-Offset"),[f,v,w]=await Promise.all([createImageBitmap(d?n.slice(0,d,"image/jpeg"):n,{premultiplyAlpha:"none"}),d?new Response(n.slice(d).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer().then(m=>new Uint8Array(m)):void 0,u]);return{bitmap:f,alpha:v,detail:o.headers.get("X-Detail")??void 0,number:r("X-Frame"),samples:r("X-Samples"),version:h,width:r("X-Width"),height:r("X-Height"),msPerPass:r("X-Ms-Per-Pass"),distance:w}}async distance(e){const t=await he(this.link,`/sessions/${e}/depth?channel=distance`);if(t.status===204||!t.ok||t.headers.get("X-Format")!=="float32-zlib")return;const s=Number(t.headers.get("X-Width")),i=Number(t.headers.get("X-Height")),o=Number(t.headers.get("X-Version")),n=await new Response(t.body.pipeThrough(new DecompressionStream("deflate"))).arrayBuffer();return{version:o,width:s,height:i,data:new Float32Array(n)}}async depth(e){const t=await he(this.link,`/sessions/${e}/depth`);if(t.status===204||!t.ok)return;const s=Number(t.headers.get("X-Width")),i=Number(t.headers.get("X-Height")),o=Number(t.headers.get("X-Version")),n=t.body.pipeThrough(new DecompressionStream("deflate")),r=new Uint8Array(await new Response(n).arrayBuffer());return{version:o,width:s,height:i,data:zs(new Uint16Array(r.buffer,r.byteOffset,r.byteLength>>1))}}}function pi(a,e){const t=zs(a);for(let s=0;s<t.length;++s)t[s]=t[s]<0?-1:t[s]*e;return t}function zs(a){const e=new Float32Array(a.length);for(let t=0;t<a.length;++t){const s=a[t],i=s&32768?-1:1,o=s>>10&31,n=s&1023;e[t]=o===0?i*n*2**-24:o===31?n?NaN:i*(1/0):i*(1+n/1024)*2**(o-15)}return e}const ye=250,Os=`
uniform sampler2D uColor;
uniform sampler2D uAlpha;
uniform float uHasAlpha;
uniform sampler2D uPrevColor;
uniform sampler2D uPrevAlpha;
uniform float uPrevHasAlpha;
uniform float uMix;
uniform float uSplit;
// The pixels the picture takes from the live image as it comes in over it (live.ts draws the others).
bool liveHere() { return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) < uSplit; }
vec4 premul(sampler2D col, sampler2D al, float hasAlpha, vec2 uv) {
  vec4 c = texture(col, uv);
  if (hasAlpha > 0.5) { float a = texture(al, uv).r; c = vec4(c.rgb * a, a); }
  return c;
}
vec4 picture(vec2 uv) {
  vec4 c = premul(uColor, uAlpha, uHasAlpha, uv);
  return uMix < 1.0 ? mix(premul(uPrevColor, uPrevAlpha, uPrevHasAlpha, uv), c, uMix) : c;
}`,fi=`#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`,vi=a=>`#version 300 es
precision highp float;
uniform highp sampler2D uDepth;
uniform vec4 uViewport;
uniform float uHasDepth;
${Os}
layout(location = ${a.color}) out vec4 out_color;
layout(location = ${a.z}) out highp vec4 out_z;
layout(location = ${a.pick}) out highp vec4 out_pickId;
void main() {
  if (liveHere()) discard;
  vec2 uv = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw;
  uv.y = 1.0 - uv.y;
  vec4 c = picture(uv);
  if (c.a < 0.5) discard;
  float d = uHasDepth > 0.5 ? texture(uDepth, uv).r : 0.5;
  d = clamp(d, 0.0, 0.99999);
  gl_FragDepth = d;
  out_color = vec4(c.rgb / max(c.a, 1e-3), 1.0);
  out_z = vec4(1.0 - d);
  out_pickId = vec4(0.0);
}`,mi=`#version 300 es
precision highp float;
uniform highp sampler2D uDist;
uniform mat4 uOldInv;
uniform mat4 uNewVP;
uniform ivec2 uSize;
uniform int uStep;
uniform int uCols;
uniform float uJump;
out vec2 vUv;
out float vValid;
float dist(ivec2 p) { return texelFetch(uDist, clamp(p, ivec2(0), uSize - 1), 0).r; }
void main() {
  ivec2 cell = ivec2(gl_VertexID % uCols, gl_VertexID / uCols);
  ivec2 px = min(cell * uStep, uSize - 1);
  float d = dist(px), dr = dist(px + ivec2(uStep, 0)), dd = dist(px + ivec2(0, uStep));
  vec2 uv = (vec2(px) + 0.5) / vec2(uSize);
  vec2 ndc = vec2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  vec4 a = uOldInv * vec4(ndc, -1.0, 1.0);
  vec4 b = uOldInv * vec4(ndc, 1.0, 1.0);
  vec3 n = a.xyz / a.w;
  vec3 dir = normalize(b.xyz / b.w - n);
  gl_Position = uNewVP * vec4(n + dir * max(d, 0.0), 1.0);
  float jump = max(abs(dr - d), abs(dd - d)) / max(d, 1e-6);
  vValid = (d >= 0.0 && dr >= 0.0 && dd >= 0.0 && jump < uJump) ? 1.0 : 0.0;
  vUv = uv;
}`,gi=a=>`#version 300 es
precision highp float;
${Os}
in vec2 vUv;
in float vValid;
layout(location = ${a.color}) out vec4 out_color;
layout(location = ${a.z}) out highp vec4 out_z;
layout(location = ${a.pick}) out highp vec4 out_pickId;
void main() {
  if (vValid < 0.999 || liveHere()) discard;
  vec4 c = picture(vUv);
  if (c.a < 0.5) discard;
  out_color = vec4(c.rgb / max(c.a, 1e-3), 1.0);
  out_z = vec4(1.0 - gl_FragCoord.z);
  out_pickId = vec4(0.0);
}`;function Ns(a){const e=Array.from(a),t=new Array(16).fill(0);t[0]=e[5]*e[10]*e[15]-e[5]*e[11]*e[14]-e[9]*e[6]*e[15]+e[9]*e[7]*e[14]+e[13]*e[6]*e[11]-e[13]*e[7]*e[10],t[4]=-e[4]*e[10]*e[15]+e[4]*e[11]*e[14]+e[8]*e[6]*e[15]-e[8]*e[7]*e[14]-e[12]*e[6]*e[11]+e[12]*e[7]*e[10],t[8]=e[4]*e[9]*e[15]-e[4]*e[11]*e[13]-e[8]*e[5]*e[15]+e[8]*e[7]*e[13]+e[12]*e[5]*e[11]-e[12]*e[7]*e[9],t[12]=-e[4]*e[9]*e[14]+e[4]*e[10]*e[13]+e[8]*e[5]*e[14]-e[8]*e[6]*e[13]-e[12]*e[5]*e[10]+e[12]*e[6]*e[9],t[1]=-e[1]*e[10]*e[15]+e[1]*e[11]*e[14]+e[9]*e[2]*e[15]-e[9]*e[3]*e[14]-e[13]*e[2]*e[11]+e[13]*e[3]*e[10],t[5]=e[0]*e[10]*e[15]-e[0]*e[11]*e[14]-e[8]*e[2]*e[15]+e[8]*e[3]*e[14]+e[12]*e[2]*e[11]-e[12]*e[3]*e[10],t[9]=-e[0]*e[9]*e[15]+e[0]*e[11]*e[13]+e[8]*e[1]*e[15]-e[8]*e[3]*e[13]-e[12]*e[1]*e[11]+e[12]*e[3]*e[9],t[13]=e[0]*e[9]*e[14]-e[0]*e[10]*e[13]-e[8]*e[1]*e[14]+e[8]*e[2]*e[13]+e[12]*e[1]*e[10]-e[12]*e[2]*e[9],t[2]=e[1]*e[6]*e[15]-e[1]*e[7]*e[14]-e[5]*e[2]*e[15]+e[5]*e[3]*e[14]+e[13]*e[2]*e[7]-e[13]*e[3]*e[6],t[6]=-e[0]*e[6]*e[15]+e[0]*e[7]*e[14]+e[4]*e[2]*e[15]-e[4]*e[3]*e[14]-e[12]*e[2]*e[7]+e[12]*e[3]*e[6],t[10]=e[0]*e[5]*e[15]-e[0]*e[7]*e[13]-e[4]*e[1]*e[15]+e[4]*e[3]*e[13]+e[12]*e[1]*e[7]-e[12]*e[3]*e[5],t[14]=-e[0]*e[5]*e[14]+e[0]*e[6]*e[13]+e[4]*e[1]*e[14]-e[4]*e[2]*e[13]-e[12]*e[1]*e[6]+e[12]*e[2]*e[5],t[3]=-e[1]*e[6]*e[11]+e[1]*e[7]*e[10]+e[5]*e[2]*e[11]-e[5]*e[3]*e[10]-e[9]*e[2]*e[7]+e[9]*e[3]*e[6],t[7]=e[0]*e[6]*e[11]-e[0]*e[7]*e[10]-e[4]*e[2]*e[11]+e[4]*e[3]*e[10]+e[8]*e[2]*e[7]-e[8]*e[3]*e[6],t[11]=-e[0]*e[5]*e[11]+e[0]*e[7]*e[9]+e[4]*e[1]*e[11]-e[4]*e[3]*e[9]-e[8]*e[1]*e[7]+e[8]*e[3]*e[5],t[15]=e[0]*e[5]*e[10]-e[0]*e[6]*e[9]-e[4]*e[1]*e[10]+e[4]*e[2]*e[9]+e[8]*e[1]*e[6]-e[8]*e[2]*e[5];const s=e[0]*t[0]+e[1]*t[4]+e[2]*t[8]+e[3]*t[12];return Float32Array.from(t.map(i=>i/(s||1)))}const wi=.08;function Ye(a,e){let t=0;for(let s=0;s<16;++s)t=Math.max(t,Math.abs(a[s]));for(let s=0;s<16;++s)if(Math.abs(a[s]-e[s])>1e-5*Math.max(t,1e-12))return!1;return!0}function yi(a,e){return a===void 0?!1:a.view===void 0||e.view===void 0?a.view===e.view&&a.bitmap.width===e.bitmap.width&&a.bitmap.height===e.bitmap.height:Ye(a.view.invViewProjection,e.view.invViewProjection)}class bi{onFrame;onFading;live;look="";pictureAtRest=!0;liveAlone=!1;coverStart;split=0;prevColor;prevAlpha;prevHasAlpha=!1;fadeStart;picture;uploaded;uploadedDepth;uploadedAlpha;gl;program;programFor="";vao;color;depth;alpha;dist;uploadedDist;mesh;meshFor="";grid;set(e){const t=this.picture;this.picture=e,t!==void 0&&t!==e&&t!==this.uploaded&&t.bitmap.close?.()}placed(){return this.picture?.view?.invViewProjection}stats={placed:0,flat:0,flatMoving:0,live:0};isOf(e,t){return e.camera!==void 0&&Ye(e.camera,t.invViewProjection)&&(e.look===void 0||e.look===this.look)}isReady(){return this.picture!==void 0}draw(e){this.onFrame?.(e);const t=this.picture,s=this.live?.ready()?this.live:void 0;if(s!==void 0&&(!this.pictureAtRest||t===void 0||!this.isOf(t,e))&&s.draw(e,1)){this.stats.live++,this.liveAlone=!0,this.coverStart=void 0;return}if(t===void 0)return;this.liveAlone&&(this.liveAlone=!1,this.coverStart=s!==void 0?performance.now():void 0);const i=this.coverStart===void 0?1:Math.min(1,(performance.now()-this.coverStart)/ye),o=1-i*i*(3-2*i);this.split=o>0&&s!==void 0&&s.draw(e,o)?o:0;const n=e.gl;this.gl!==n&&this.reset(n);const r=this.compile(n,e.outputs);if(r===void 0)return;if(this.uploaded!==t){yi(this.uploaded,t)?((this.fadeStart===void 0||performance.now()-this.fadeStart>=ye)&&([this.prevColor,this.color]=[this.color,this.prevColor],[this.prevAlpha,this.alpha]=[this.alpha,this.prevAlpha],this.prevHasAlpha=this.uploaded.alpha!==void 0,this.fadeStart=performance.now()),this.uploadedAlpha=void 0):this.fadeStart=void 0,n.activeTexture(n.TEXTURE0),n.bindTexture(n.TEXTURE_2D,this.color),n.pixelStorei(n.UNPACK_FLIP_Y_WEBGL,!1),n.pixelStorei(n.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),n.texImage2D(n.TEXTURE_2D,0,n.RGBA8,n.RGBA,n.UNSIGNED_BYTE,t.bitmap);const l=this.uploaded;this.uploaded=t,l!==void 0&&l!==this.picture&&l.bitmap.close?.()}if(t.depth!==void 0&&this.uploadedDepth!==t.depth&&(n.activeTexture(n.TEXTURE1),n.bindTexture(n.TEXTURE_2D,this.depth),n.pixelStorei(n.UNPACK_ALIGNMENT,4),n.texImage2D(n.TEXTURE_2D,0,n.R32F,t.depth.width,t.depth.height,0,n.RED,n.FLOAT,t.depth.data),this.uploadedDepth=t.depth),t.alpha!==void 0&&this.uploadedAlpha!==t.alpha&&(n.activeTexture(n.TEXTURE2),n.bindTexture(n.TEXTURE_2D,this.alpha),n.pixelStorei(n.UNPACK_ALIGNMENT,1),n.texImage2D(n.TEXTURE_2D,0,n.R8,t.alpha.width,t.alpha.height,0,n.RED,n.UNSIGNED_BYTE,t.alpha.data),n.pixelStorei(n.UNPACK_ALIGNMENT,4),this.uploadedAlpha=t.alpha),t.view!==void 0&&this.drawMesh(n,e,t)){this.stats.placed++,this.fadeOn();return}this.stats.flat++,e.moving&&this.stats.flatMoving++,n.useProgram(r),this.bindMix(n,r);const h=n.getParameter(n.VIEWPORT);n.uniform4f(n.getUniformLocation(r,"uViewport"),h[0],h[1],h[2],h[3]),n.uniform1f(n.getUniformLocation(r,"uHasDepth"),t.depth!==void 0?1:0),n.uniform1f(n.getUniformLocation(r,"uHasAlpha"),t.alpha!==void 0?1:0),n.activeTexture(n.TEXTURE0),n.bindTexture(n.TEXTURE_2D,this.color),n.uniform1i(n.getUniformLocation(r,"uColor"),0),n.activeTexture(n.TEXTURE1),n.bindTexture(n.TEXTURE_2D,this.depth),n.uniform1i(n.getUniformLocation(r,"uDepth"),1),n.activeTexture(n.TEXTURE2),n.bindTexture(n.TEXTURE_2D,this.alpha),n.uniform1i(n.getUniformLocation(r,"uAlpha"),2),n.bindVertexArray(this.vao),n.drawArrays(n.TRIANGLES,0,3),n.bindVertexArray(null),n.activeTexture(n.TEXTURE0),this.fadeOn()}bindMix(e,t){const s=this.fadeStart===void 0?1:Math.min(1,(performance.now()-this.fadeStart)/ye);e.uniform1f(e.getUniformLocation(t,"uMix"),s*s*(3-2*s)),e.uniform1f(e.getUniformLocation(t,"uSplit"),this.split),e.uniform1f(e.getUniformLocation(t,"uPrevHasAlpha"),this.prevHasAlpha?1:0),e.activeTexture(e.TEXTURE4),e.bindTexture(e.TEXTURE_2D,this.prevColor),e.uniform1i(e.getUniformLocation(t,"uPrevColor"),4),e.activeTexture(e.TEXTURE5),e.bindTexture(e.TEXTURE_2D,this.prevAlpha),e.uniform1i(e.getUniformLocation(t,"uPrevAlpha"),5)}fadeOn(){const e=performance.now();this.fadeStart!==void 0&&e-this.fadeStart>=ye&&(this.fadeStart=void 0),this.coverStart!==void 0&&e-this.coverStart>=ye&&(this.coverStart=void 0),(this.fadeStart!==void 0||this.coverStart!==void 0)&&requestAnimationFrame(()=>this.onFading?.())}drawMesh(e,t,s){const i=s.view,o=i.distance.width,n=i.distance.height,r=JSON.stringify(t.outputs);if(this.mesh===void 0||this.meshFor!==r)try{this.mesh&&e.deleteProgram(this.mesh),this.mesh=void 0,this.mesh=this.link(e,mi,gi(t.outputs)),this.meshFor=r}catch{return!1}this.uploadedDist!==i&&(e.activeTexture(e.TEXTURE3),e.bindTexture(e.TEXTURE_2D,this.dist),e.pixelStorei(e.UNPACK_ALIGNMENT,4),e.texImage2D(e.TEXTURE_2D,0,e.R32F,o,n,0,e.RED,e.FLOAT,i.distance.data),this.uploadedDist=i);const h=o*n>4e5?2:1,l=Math.floor((o-1)/h)+1,u=Math.floor((n-1)/h)+1,d=`${l}x${u}`;if(this.grid?.key!==d){const w=new Uint32Array((l-1)*(u-1)*6);let m=0;for(let y=0;y<u-1;++y)for(let S=0;S<l-1;++S){const E=y*l+S;w.set([E,E+1,E+l,E+1,E+l+1,E+l],m),m+=6}const T=this.grid?.buffer??e.createBuffer();e.bindVertexArray(this.vao),e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,T),e.bufferData(e.ELEMENT_ARRAY_BUFFER,w,e.STATIC_DRAW),e.bindVertexArray(null),this.grid={key:d,buffer:T,count:w.length,cols:l,step:h}}const f=this.mesh;e.useProgram(f),this.bindMix(e,f);const v=w=>e.getUniformLocation(f,w);return e.uniformMatrix4fv(v("uOldInv"),!1,Float32Array.from(i.invViewProjection)),e.uniformMatrix4fv(v("uNewVP"),!1,Ns(t.invViewProjection)),e.uniform2i(v("uSize"),o,n),e.uniform1i(v("uStep"),h),e.uniform1i(v("uCols"),l),e.uniform1f(v("uJump"),Ye(i.invViewProjection,t.invViewProjection)?1e9:wi),e.uniform1f(v("uHasAlpha"),s.alpha!==void 0?1:0),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.color),e.uniform1i(v("uColor"),0),e.activeTexture(e.TEXTURE2),e.bindTexture(e.TEXTURE_2D,this.alpha),e.uniform1i(v("uAlpha"),2),e.activeTexture(e.TEXTURE3),e.bindTexture(e.TEXTURE_2D,this.dist),e.uniform1i(v("uDist"),3),e.bindVertexArray(this.vao),e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,this.grid.buffer),e.drawElements(e.TRIANGLES,this.grid.count,e.UNSIGNED_INT,0),e.bindVertexArray(null),e.activeTexture(e.TEXTURE0),!0}link(e,t,s){const i=(r,h)=>{const l=e.createShader(r);if(e.shaderSource(l,h),e.compileShader(l),!e.getShaderParameter(l,e.COMPILE_STATUS))throw new Error(e.getShaderInfoLog(l)??"shader");return l},o=e.createProgram(),n=[i(e.VERTEX_SHADER,t),i(e.FRAGMENT_SHADER,s)];for(const r of n)e.attachShader(o,r);e.linkProgram(o);for(const r of n)e.deleteShader(r);if(!e.getProgramParameter(o,e.LINK_STATUS)){const r=e.getProgramInfoLog(o);throw e.deleteProgram(o),new Error(r??"link")}return o}reset(e){this.gl=e,this.program=void 0,this.programFor="",this.uploaded=void 0,this.uploadedDepth=void 0,this.uploadedAlpha=void 0,this.uploadedDist=void 0,this.mesh=void 0,this.meshFor="",this.grid=void 0,this.vao=e.createVertexArray();const t=s=>{const i=e.createTexture();return e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,s),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,s),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),i};this.color=t(e.LINEAR),this.depth=t(e.NEAREST),this.alpha=t(e.LINEAR),this.prevColor=t(e.LINEAR),this.prevAlpha=t(e.LINEAR),this.fadeStart=void 0,this.dist=t(e.NEAREST)}compile(e,t){const s=JSON.stringify(t);return this.program!==void 0&&this.programFor===s?this.program:(this.program!==void 0&&e.deleteProgram(this.program),this.program=void 0,this.program=this.link(e,fi,vi(t)),this.programFor=s,this.program)}dispose(){for(const t of[this.picture,this.uploaded])t?.bitmap.close?.();this.picture=void 0,this.uploaded=void 0;const e=this.gl;if(e!==void 0){this.program&&e.deleteProgram(this.program);for(const t of[this.color,this.depth,this.alpha,this.dist,this.prevColor,this.prevAlpha])t&&e.deleteTexture(t);this.mesh&&e.deleteProgram(this.mesh),this.vao&&e.deleteVertexArray(this.vao),this.grid&&e.deleteBuffer(this.grid.buffer),this.grid=void 0,this.gl=void 0}}}const $s=12,xi=["still","movie","splat"],Ti=["queued","running","done","failed","cancelled","gone"];function Ee(a){return a!=="queued"&&a!=="running"}function Ei(a){return Array.isArray(a)?a.filter(e=>!!e&&typeof e=="object"&&xi.includes(e.kind)&&typeof e.id=="string"&&typeof e.host=="string").map(e=>({kind:e.kind,id:e.id,host:e.host,name:typeof e.name=="string"?e.name:e.kind,status:Ti.includes(e.status)?e.status:"gone",progress:typeof e.progress=="number"&&Number.isFinite(e.progress)?e.progress:0,message:typeof e.message=="string"?e.message:"",...typeof e.error=="string"?{error:e.error}:{},...Array.isArray(e.files)?{files:e.files.filter(t=>typeof t=="string")}:{},...typeof e.ahead=="number"&&Number.isFinite(e.ahead)?{ahead:e.ahead}:{},started:typeof e.started=="number"?e.started:0})).slice(-$s):[]}function Si(a,e){const t=i=>i.kind===e.kind&&i.id===e.id&&i.host===e.host,s=a.some(t)?a.map(i=>t(i)?e:i):[...a,e];for(;s.length>$s;){const i=s.findIndex(o=>Ee(o.status));s.splice(i>=0?i:0,1)}return s}function Pi(a,e){return a.filter(t=>!(t.kind===e.kind&&t.id===e.id&&t.host===e.host))}function Je(a){return a.status==="queued"?a.ahead!==void 0?a.ahead>0?`waiting, ${a.ahead} job${a.ahead===1?"":"s"} ahead`:"waiting, next to start":a.message?/^waiting/i.test(a.message)?a.message:`waiting, ${a.message}`:"waiting":/^waiting for GPU memory/i.test(a.message)?a.message:`${Math.round(a.progress*100)}%${a.message?`, ${a.message}`:""}`}function _i(a){switch(a.status){case"queued":case"running":return`${a.name}: ${Je(a)}`;case"done":return`${a.name}: done`;case"failed":return`${a.name}: failed${a.error?` (${a.error})`:""}`;case"cancelled":return`${a.name}: cancelled`;case"gone":return`${a.name}: no longer on ${a.host}`}}const $={minSide:8,maxSide:8192,maxSamples:4096,maxFps:120,maxBoxes:8,stillWork:8192*8192*256};function oe(a,e,t){return Number.isFinite(a)?Math.min(t,Math.max(e,Math.round(a))):e}function fe(a){const e=oe(a,$.minSide,$.maxSide);return e-e%2}function Xe(a){return{...a,fps:oe(a.fps,1,$.maxFps),width:fe(a.width),height:fe(a.height),samples:oe(a.samples,1,$.maxSamples)}}function Ai(a,e,t){if(!(a*e*t<=$.stillWork))return`A ${a} × ${e} still at ${t} samples is too large: use fewer samples or a smaller size.`}function Ri(a,e,t){const s=e-a,i=t!==void 0&&t.startsWith("float");if(!(s>0)||!Number.isFinite(s))return i?.001:1;const o=s/1e3,n=10**Math.floor(Math.log10(o)),r=[1,2,5,10].map(h=>h*n).find(h=>h>=o*.999)??o;return i?r:Math.max(1,Math.round(r))}const ms=[1e3,2e3,4e3,8e3,15e3,3e4];function ki(a){return a>=1&&a<=ms.length?ms[a-1]:void 0}const He=.28209479177387814;function Bs(a,e){const t=Math.hypot(e[0],e[1],e[2],e[3])||1,s=e[0]/t,i=e[1]/t,o=e[2]/t,n=e[3]/t,r=[1-2*(o*o+n*n),2*(i*o-s*n),2*(i*n+s*o),2*(i*o+s*n),1-2*(i*i+n*n),2*(o*n-s*i),2*(i*n-s*o),2*(o*n+s*i),1-2*(i*i+o*o)],h=[0,1,2].flatMap(u=>[0,1,2].map(d=>r[u*3+d]*a[d])),l=(u,d)=>h[u*3]*h[d*3]+h[u*3+1]*h[d*3+1]+h[u*3+2]*h[d*3+2];return[l(0,0),l(0,1),l(0,2),l(1,1),l(1,2),l(2,2)]}function gs(a){const e=Math.floor(a.byteLength/32),t=new Float32Array(a,0,e*8),s=new Uint8Array(a,0,e*32),i=Vs(e);for(let o=0;o<e;++o){i.positions.set(t.subarray(o*8,o*8+3),o*3);const n=[0,1,2,3].map(r=>(s[o*32+28+r]-128)/128);i.covariances.set(Bs(t.subarray(o*8+3,o*8+6),n),o*6),i.colors.set(s.subarray(o*32+24,o*32+28),o*4)}return i}function Mi(a){const e=new Uint8Array(a),t=new TextEncoder().encode(`end_header
`);let s=-1;for(let f=0;f+t.length<=Math.min(e.length,65536);++f)if(t.every((v,w)=>e[f+w]===v)){s=f+t.length;break}if(s<0)throw new Error("not a PLY file (no end_header)");const i=new TextDecoder().decode(e.subarray(0,s));if(!/format binary_little_endian/.test(i))throw new Error("only binary little-endian PLY files are read");const o=Number(/element vertex (\d+)/.exec(i)?.[1]??NaN),n=[...i.matchAll(/^property (\w+) (\w+)$/gm)].map(f=>({type:f[1],name:f[2]}));if(!Number.isFinite(o)||n.some(f=>f.type!=="float"))throw new Error("a splat PLY has only float properties");const r=Object.fromEntries(n.map((f,v)=>[f.name,v]));for(const f of["x","y","z","f_dc_0","f_dc_1","f_dc_2","opacity","scale_0","scale_1","scale_2","rot_0","rot_1","rot_2","rot_3"])if(!(f in r))throw new Error(`the PLY has no ${f}: not a Gaussian splat`);const h=n.length,l=new Float32Array(a.slice(s,s+o*h*4)),u=Vs(o),d=f=>Math.max(0,Math.min(255,Math.round(f*255)));for(let f=0;f<o;++f){const v=w=>l[f*h+r[w]];u.positions.set([v("x"),v("y"),v("z")],f*3),u.covariances.set(Bs([Math.exp(v("scale_0")),Math.exp(v("scale_1")),Math.exp(v("scale_2"))],[v("rot_0"),v("rot_1"),v("rot_2"),v("rot_3")]),f*6),u.colors.set([d(.5+He*v("f_dc_0")),d(.5+He*v("f_dc_1")),d(.5+He*v("f_dc_2")),d(1/(1+Math.exp(-v("opacity"))))],f*4)}return u}function Vs(a){return{count:a,positions:new Float32Array(a*3),covariances:new Float32Array(a*6),colors:new Uint8Array(a*4)}}function Li(a,e,t,s=new Uint32Array(e)){const i=new Float32Array(e);let o=1/0,n=-1/0;for(let d=0;d<e;++d){const f=t[2]*a[d*3]+t[6]*a[d*3+1]+t[10]*a[d*3+2]+t[14];i[d]=f,f<o&&(o=f),f>n&&(n=f)}const r=65536,h=n>o?(r-1)/(n-o):0,l=new Uint16Array(e),u=new Uint32Array(r);for(let d=0;d<e;++d)l[d]=(i[d]-o)*h,u[l[d]]++;for(let d=1;d<r;++d)u[d]+=u[d-1];for(let d=e-1;d>=0;--d)s[--u[l[d]]]=d;return s}function Ui(a,e,t){const s=ie(Se(e,a)),i=ie(_e(s,t)),o=_e(i,s),n=[i,o.map(h=>-h),s],r=new Float32Array(16);for(let h=0;h<3;++h){for(let l=0;l<3;++l)r[l*4+h]=n[h][l];r[12+h]=-(n[h][0]*a[0]+n[h][1]*a[1]+n[h][2]*a[2])}return r[15]=1,r}const Se=(a,e)=>[a[0]-e[0],a[1]-e[1],a[2]-e[2]],ee=(a,e)=>[a[0]+e[0],a[1]+e[1],a[2]+e[2]],K=(a,e)=>[a[0]*e,a[1]*e,a[2]*e],Gs=(a,e)=>a[0]*e[0]+a[1]*e[1]+a[2]*e[2],_e=(a,e)=>[a[1]*e[2]-a[2]*e[1],a[2]*e[0]-a[0]*e[2],a[0]*e[1]-a[1]*e[0]],ie=a=>K(a,1/(Math.hypot(a[0],a[1],a[2])||1)),We=(a,e,t)=>{const s=Math.cos(t),i=Math.sin(t);return ee(ee(K(a,s),K(_e(e,a),i)),K(e,Gs(e,a)*(1-s)))},Ci=`#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uPos;
uniform highp sampler2D uCovA;
uniform highp sampler2D uCovB;
uniform lowp sampler2D uColor;
uniform mat4 uView;
uniform vec2 uFocal;
uniform vec2 uViewport;
in vec2 aCorner;
in uint aIndex;
out vec4 vColor;
out vec2 vPos;
void main() {
  ivec2 t = ivec2(int(aIndex & 2047u), int(aIndex >> 11));
  vec4 cam = uView * vec4(texelFetch(uPos, t, 0).xyz, 1.0);
  float z = cam.z;
  if (z < 1e-3 || abs(cam.x / z) * uFocal.x > uViewport.x * 0.65 + 64.0 || abs(cam.y / z) * uFocal.y > uViewport.y * 0.65 + 64.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec4 a = texelFetch(uCovA, t, 0), b = texelFetch(uCovB, t, 0);
  mat3 V = mat3(a.x, a.y, a.z, a.y, a.w, b.x, a.z, b.x, b.y);
  mat3 J = mat3(uFocal.x / z, 0.0, 0.0, 0.0, uFocal.y / z, 0.0, -uFocal.x * cam.x / (z * z), -uFocal.y * cam.y / (z * z), 0.0);
  mat3 T = J * mat3(uView);
  mat3 C = T * V * transpose(T);
  float p = C[0][0] + 0.3, q = C[0][1], r = C[1][1] + 0.3;
  float mid = 0.5 * (p + r), rad = length(vec2(0.5 * (p - r), q));
  float l1 = mid + rad, l2 = max(mid - rad, 0.1);
  vec2 d = abs(q) > 1e-7 ? normalize(vec2(q, l1 - p)) : (p >= r ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 major = min(sqrt(2.0 * l1), 1024.0) * d;
  vec2 minor = min(sqrt(2.0 * l2), 1024.0) * vec2(d.y, -d.x);
  vec2 px = vec2(uFocal.x * cam.x / z, uFocal.y * cam.y / z) + 0.5 * uViewport + aCorner.x * major + aCorner.y * minor;
  gl_Position = vec4(px.x / uViewport.x * 2.0 - 1.0, 1.0 - px.y / uViewport.y * 2.0, 0.0, 1.0);
  vColor = texelFetch(uColor, t, 0);
  vPos = aCorner;
}`,Di=`#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vPos;
out vec4 fragColor;
void main() {
  float A = -dot(vPos, vPos);
  if (A < -4.0) discard;
  float B = exp(A) * vColor.a;
  fragColor = vec4(B * vColor.rgb, B);
}`;class Fi{constructor(e,t){this.splats=e,this.canvas=document.createElement("canvas"),this.canvas.className="ar-splat-canvas";const s=this.canvas.getContext("webgl2",{antialias:!1,premultipliedAlpha:!0});if(!s)throw new Error("this browser has no WebGL 2");this.gl=s,this.program=Ii(s,Ci,Di),this.order=new Uint32Array(e.count),this.upload();const i=s.createBuffer();s.bindBuffer(s.ARRAY_BUFFER,i),s.bufferData(s.ARRAY_BUFFER,new Float32Array([-2,-2,2,-2,-2,2,2,2]),s.STATIC_DRAW);const o=s.createVertexArray();s.bindVertexArray(o);const n=s.getAttribLocation(this.program,"aCorner");s.enableVertexAttribArray(n),s.vertexAttribPointer(n,2,s.FLOAT,!1,0,0),this.indexBuffer=s.createBuffer(),s.bindBuffer(s.ARRAY_BUFFER,this.indexBuffer),s.bufferData(s.ARRAY_BUFFER,this.order,s.DYNAMIC_DRAW);const r=s.getAttribLocation(this.program,"aIndex");s.enableVertexAttribArray(r),s.vertexAttribIPointer(r,1,s.UNSIGNED_INT,0,0),s.vertexAttribDivisor(r,1),this.start=t??this.framing(),this.reset(),this.controls()}canvas;gl;program;order;indexBuffer;eye=[0,0,1];target=[0,0,0];up=[0,-1,0];fovy=30;start;frame=0;sortedFor="";offs=[];reset(){const e=this.start,t=e.c2w;this.eye=[t[0][3],t[1][3],t[2][3]];const s=[t[0][2],t[1][2],t[2][2]],i=Math.max(1e-6,Gs(Se(e.centre,this.eye),s));this.target=ee(this.eye,K(s,i)),this.up=[-t[0][1],-t[1][1],-t[2][1]],this.fovy=e.fovy,this.redraw()}framing(){const e=this.splats.positions,t=[1/0,1/0,1/0],s=[-1/0,-1/0,-1/0];for(let r=0;r<this.splats.count;++r)for(let h=0;h<3;++h)t[h]=Math.min(t[h],e[r*3+h]),s[h]=Math.max(s[h],e[r*3+h]);const i=K(ee(t,s),.5),n=Math.max(.001,Math.hypot(...Se(s,t))/2)/Math.sin(30*Math.PI/360)*1.1;return{c2w:[[1,0,0,i[0]],[0,0,1,i[1]-n],[0,-1,0,i[2]],[0,0,0,1]],fovy:30,centre:i}}upload(){const e=this.gl,t=this.splats.count,s=2048,i=Math.max(1,Math.ceil(t/s)),o=new Float32Array(s*i*4),n=new Float32Array(s*i*4),r=new Float32Array(s*i*4),h=new Uint8Array(s*i*4),{positions:l,covariances:u,colors:d}=this.splats;for(let v=0;v<t;++v)o[v*4]=l[v*3],o[v*4+1]=l[v*3+1],o[v*4+2]=l[v*3+2],n[v*4]=u[v*6],n[v*4+1]=u[v*6+1],n[v*4+2]=u[v*6+2],n[v*4+3]=u[v*6+3],r[v*4]=u[v*6+4],r[v*4+1]=u[v*6+5];h.set(d),e.useProgram(this.program),[["uPos",e.RGBA32F,e.RGBA,e.FLOAT,o],["uCovA",e.RGBA32F,e.RGBA,e.FLOAT,n],["uCovB",e.RGBA32F,e.RGBA,e.FLOAT,r],["uColor",e.RGBA8,e.RGBA,e.UNSIGNED_BYTE,h]].forEach(([v,w,m,T,y],S)=>{const E=e.createTexture();e.activeTexture(e.TEXTURE0+S),e.bindTexture(e.TEXTURE_2D,E),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texImage2D(e.TEXTURE_2D,0,w,s,i,0,m,T,y),e.uniform1i(e.getUniformLocation(this.program,v),S)})}controls(){const e=this.canvas;let t;const s=l=>{t={x:l.clientX,y:l.clientY,pan:l.button===2||l.shiftKey},e.setPointerCapture(l.pointerId),e.classList.add("grabbing")},i=l=>{if(!t)return;const u=l.clientX-t.x,d=l.clientY-t.y;t={...t,x:l.clientX,y:l.clientY};const f=Se(this.eye,this.target),v=ie(K(f,-1)),w=ie(_e(v,this.up));if(t.pan){const m=Math.hypot(...f)*2*Math.tan(this.fovy*Math.PI/360)/Math.max(1,e.clientHeight),T=ee(K(w,-u*m),K(this.up,d*m));this.eye=ee(this.eye,T),this.target=ee(this.target,T)}else{let m=We(f,ie(this.up),-u*.006);const T=ie(_e(ie(K(m,-1)),this.up));m=We(m,T,-d*.006),this.up=ie(We(this.up,T,-d*.006)),this.eye=ee(this.target,m)}this.redraw()},o=l=>{t=void 0,e.releasePointerCapture(l.pointerId),e.classList.remove("grabbing")},n=l=>{l.preventDefault();const u=Se(this.eye,this.target);this.eye=ee(this.target,K(u,Math.exp(Math.max(-1,Math.min(1,l.deltaY*.0015))))),this.redraw()},r=l=>l.preventDefault();e.addEventListener("pointerdown",s),e.addEventListener("pointermove",i),e.addEventListener("pointerup",o),e.addEventListener("wheel",n,{passive:!1}),e.addEventListener("contextmenu",r);const h=new ResizeObserver(()=>this.redraw());h.observe(e),this.offs.push(()=>h.disconnect())}redraw(){this.frame||(this.frame=requestAnimationFrame(()=>{this.frame=0,this.draw()}))}draw(){const e=this.gl,t=this.canvas,s=Math.min(2,window.devicePixelRatio||1),i=Math.max(1,Math.round(t.clientWidth*s)),o=Math.max(1,Math.round(t.clientHeight*s));(t.width!==i||t.height!==o)&&(t.width=i,t.height=o);const n=Ui(this.eye,this.target,this.up),r=Array.from(n,l=>l.toFixed(4)).join();r!==this.sortedFor&&(Li(this.splats.positions,this.splats.count,n,this.order),e.bindBuffer(e.ARRAY_BUFFER,this.indexBuffer),e.bufferSubData(e.ARRAY_BUFFER,0,this.order),this.sortedFor=r);const h=o/2/Math.tan(this.fovy*Math.PI/360);e.viewport(0,0,i,o),e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT),e.useProgram(this.program),e.uniformMatrix4fv(e.getUniformLocation(this.program,"uView"),!1,n),e.uniform2f(e.getUniformLocation(this.program,"uFocal"),h,h),e.uniform2f(e.getUniformLocation(this.program,"uViewport"),i,o),e.enable(e.BLEND),e.blendFuncSeparate(e.ONE_MINUS_DST_ALPHA,e.ONE,e.ONE_MINUS_DST_ALPHA,e.ONE),e.disable(e.DEPTH_TEST),e.drawArraysInstanced(e.TRIANGLE_STRIP,0,4,this.splats.count)}dispose(){this.frame&&cancelAnimationFrame(this.frame);for(const e of this.offs)e();this.gl.getExtension("WEBGL_lose_context")?.loseContext()}}function Ii(a,e,t){const s=(o,n)=>{const r=a.createShader(o);if(a.shaderSource(r,n),a.compileShader(r),!a.getShaderParameter(r,a.COMPILE_STATUS))throw new Error(`splat shader: ${a.getShaderInfoLog(r)}`);return r},i=a.createProgram();if(a.attachShader(i,s(a.VERTEX_SHADER,e)),a.attachShader(i,s(a.FRAGMENT_SHADER,t)),a.linkProgram(i),!a.getProgramParameter(i,a.LINK_STATUS))throw new Error(`splat program: ${a.getProgramInfoLog(i)}`);return i}function ws(a,e,t,s,i=[]){return a(e,o=>{let n;const r=b("div",{class:"ar-splat"});o.append(b("div",{class:"row"},b("span",{class:"readout spacer"},`${t.count.toLocaleString()} Gaussians`),pe("Drag to turn, right or Shift drag to move, the wheel to come closer.","About moving the view"),L("Reset view",()=>n?.reset()),...i.map(([h,l])=>L(h,l))),r);try{n=new Fi(t,s),r.append(n.canvas)}catch(h){r.append(b("p",{class:"empty error"},h.message))}return()=>n?.dispose()},{wide:!0})}function Ze(a,e){if(!e||e.length===0)return a;const t=[...e].sort((i,o)=>i.from-o.from);if(a<=t[0].from)return t[0].to+(a-t[0].from);for(let i=1;i<t.length;++i)if(a<=t[i].from)return t[i-1].to+(a-t[i-1].from)*(t[i].to-t[i-1].to)/(t[i].from-t[i-1].from||1);const s=t[t.length-1];return s.to+(a-s.from)}function zi(a,e){return Ze(a,e?.map(t=>({from:t.to,to:t.from})))}function Oi(a,e,t,s=[.1,.3,.5,.7,.9]){const i=a.counts.length,o=(a.hi-a.lo)/i,n=a.counts.map((d,f)=>({v:a.lo+(f+.5)*o,c:d})).filter(d=>d.v>=e&&d.v<=t),r=n.reduce((d,f)=>d+f.c,0);if(!r)return s.map(d=>e+d*(t-e));let h=0,l=0;const u=[];for(const d of n)for(h+=d.c;l<s.length&&h/r>=s[l];)u.push(d.v),++l;for(;u.length<s.length;)u.push(t);return u.map((d,f)=>f>0&&d<=u[f-1]?u[f-1]+(t-e)*.001:d)}function Ni(a,e=14){if(a.length<=e)return a.map((i,o)=>o);const t=new Set([0,a.length-1]);for(let i=1;i<a.length;++i)if(a[i].tissue!==a[i-1].tissue&&(t.add(i-1),t.add(i)),i<a.length-1){const o=a[i].opacity-a[i-1].opacity,n=a[i+1].opacity-a[i].opacity;Math.abs(o-n)>.15&&t.add(i)}let s=[...t].sort((i,o)=>i-o);for(;s.length>e;){let i=1,o=1/0;for(let n=1;n<s.length-1;++n){const r=a[s[n+1]].value-a[s[n-1]].value;r<o&&([i,o]=[n,r])}s.splice(i,1)}if(s.length<Math.min(e,6)){const i=(a.length-1)/(Math.min(e,6)-1);s=[...new Set([...s,...Array.from({length:Math.min(e,6)},(o,n)=>Math.round(n*i))])].sort((o,n)=>o-n)}return s}function $i(a,e,t,s){const i=e.indexOf(t),o=i>0?a[e[i-1]].value:-1/0,n=i<e.length-1?a[e[i+1]].value:1/0,r=Math.min(Math.max(s,o+1e-6),n-1e-6),h=a[t].value;return a.map((l,u)=>u===t?{...l,value:r}:i>0&&u>e[i-1]&&u<t?{...l,value:o+(l.value-o)*(r-o)/(h-o||1)}:i<e.length-1&&u>t&&u<e[i+1]?{...l,value:n-(n-l.value)*(n-r)/(n-h||1)}:i===0&&u<t?{...l,value:l.value+(r-h)}:i===e.length-1&&u>t?{...l,value:l.value+(r-h)}:l)}function ys(a,e,t,s){const i=e.indexOf(t),o=i>0?e[i-1]:t,n=i<e.length-1?e[i+1]:t,r=a[t];return a.map((h,l)=>{if(l<o||l>n)return h;const u=l===t?1:l<t?(h.value-a[o].value)/(r.value-a[o].value||1):(a[n].value-h.value)/(a[n].value-r.value||1),d={...h};return s.opacity!==void 0&&(d.opacity=Math.min(1,Math.max(0,h.opacity+u*(s.opacity-r.opacity)))),s.color&&(d.color=h.color.map((f,v)=>Math.min(1,Math.max(0,f+u*(s.color[v]-r.color[v]))))),d})}function Bi(a,e,t,s){return e===0&&t===1?a:a.map(i=>({...i,value:s+(i.value-s)*t+e}))}function be(a,e,t){return(typeof getComputedStyle=="function"?getComputedStyle(a).getPropertyValue(e).trim():"")||t}const je=a=>"#"+a.map(e=>Math.round(Math.min(1,Math.max(0,e))*255).toString(16).padStart(2,"0")).join(""),Vi=a=>[1,3,5].map(e=>parseInt(a.slice(e,e+2),16)/255);class Gi{constructor(e,t=()=>{}){this.onChange=e,this.onWarp=t,this.canvas=b("canvas",{class:"ar-editor",width:"420",height:"150","aria-label":"Colourmap over the image's histogram"}),this.element=this.canvas,this.canvas.addEventListener("pointerdown",s=>this.down(s)),this.canvas.addEventListener("pointermove",s=>this.move(s)),this.canvas.addEventListener("pointerup",()=>{this.drag=void 0,this.warpDrag=void 0}),this.canvas.addEventListener("dblclick",s=>this.recolour(s)),this.canvas.addEventListener("contextmenu",s=>this.remove(s))}element;canvas;stops=[];points=[];range=[0,1];counts=[];hlo=0;hhi=1;drag;warp=[];warpDrag;get dragging(){return this.drag!==void 0||this.warpDrag!==void 0}set(e,t,s=[]){if(this.dragging)return;this.warp=s.map(h=>({...h})),this.stops=t.map(h=>({...h})),this.points=Ni(this.stops),e&&([this.counts,this.hlo,this.hhi]=[e.counts,e.lo,e.hi]);const o=(this.stops.filter(h=>h.opacity>.01)[0]??this.stops[0])?.value??this.hlo,n=this.stops[this.stops.length-1]?.value??this.hhi,r=(n-o)*.12||1;this.range=[o-r,n+r],this.draw()}x(e){return(e-this.range[0])/(this.range[1]-this.range[0])*this.canvas.width}v(e){return this.range[0]+e/this.canvas.width*(this.range[1]-this.range[0])}y(e){return 10+(1-e)*(this.canvas.height-40)}draw(){const e=this.canvas.getContext("2d"),t=this.canvas.width,s=this.canvas.height,i=this.canvas;if(e.fillStyle=be(i,"--ink-1","#0c0c0c"),e.fillRect(0,0,t,s),this.counts.length){const o=this.counts.length,n=Math.log1p(Math.max(...this.counts));e.fillStyle=be(i,"--plot","#777");for(let r=0;r<o;++r){const h=this.hlo+(this.hhi-this.hlo)*r/o,l=this.hlo+(this.hhi-this.hlo)*(r+1)/o,u=this.x(Ze(h,this.warp)),d=this.x(Ze(l,this.warp));if(d<0||u>t)continue;const f=Math.log1p(this.counts[r])/n*(s-40);e.fillRect(u,s-30-f,Math.max(1,d-u),f)}}for(let o=0;o<t;++o){const n=this.at(this.v(o));e.fillStyle=je(n.color.map(r=>Math.min(1,r*1.6))),e.fillRect(o,s-24,1,18)}e.strokeStyle=be(i,"--text","#dedede"),e.lineWidth=1.5,e.beginPath(),this.stops.forEach((o,n)=>n?e.lineTo(this.x(o.value),this.y(o.opacity)):e.moveTo(this.x(o.value),this.y(o.opacity))),e.stroke(),e.fillStyle=be(i,"--dec-z","#4f88dc");for(const o of this.warp){const n=this.x(o.to),r=s-30;e.beginPath(),e.moveTo(n,r-7),e.lineTo(n-5,r+2),e.lineTo(n+5,r+2),e.closePath(),e.fill()}for(const o of this.points){const n=this.stops[o];e.fillStyle=je(n.color.map(r=>Math.min(1,r*1.6))),e.strokeStyle=be(i,"--text-strong","#fff"),e.beginPath(),e.arc(this.x(n.value),this.y(n.opacity),5,0,Math.PI*2),e.fill(),e.stroke()}}at(e){const t=this.stops;if(!t.length)return{color:[0,0,0],opacity:0};if(e<=t[0].value)return{color:t[0].color,opacity:t[0].opacity};for(let i=1;i<t.length;++i)if(e<=t[i].value){const o=(e-t[i-1].value)/(t[i].value-t[i-1].value||1);return{color:t[i].color.map((n,r)=>t[i-1].color[r]+o*(n-t[i-1].color[r])),opacity:t[i-1].opacity+o*(t[i].opacity-t[i-1].opacity)}}const s=t[t.length-1];return{color:s.color,opacity:s.opacity}}pos(e){const t=this.canvas.getBoundingClientRect();return[(e.clientX-t.left)/t.width*this.canvas.width,(e.clientY-t.top)/t.height*this.canvas.height]}near(e){const[t,s]=this.pos(e);let i,o=9;for(const n of this.points){const r=Math.hypot(this.x(this.stops[n].value)-t,this.y(this.stops[n].opacity)-s);r<o&&([i,o]=[n,r])}return i}down(e){if(e.button!==0)return;const[t,s]=this.pos(e);if(s>this.canvas.height-40){let o=-1,n=9;if(this.warp.forEach((r,h)=>{const l=Math.abs(this.x(r.to)-t);l<n&&([o,n]=[h,l])}),o>=0){this.warpDrag=o,this.canvas.setPointerCapture(e.pointerId);return}}const i=this.near(e);if(i!==void 0){this.drag=i,this.canvas.setPointerCapture(e.pointerId);return}if(e.ctrlKey||e.metaKey){const[o]=this.pos(e),n=this.v(o),r=this.at(n),h=this.stops.findIndex(d=>d.value>n),l=h<0?this.stops.length:h,u=this.stops[Math.min(l,this.stops.length-1)];this.stops.splice(l,0,{...u,value:n,color:r.color,opacity:r.opacity}),this.points=[...new Set([...this.points.map(d=>d>=l?d+1:d),l])].sort((d,f)=>d-f),this.changed()}}move(e){if(this.warpDrag!==void 0){const[n]=this.pos(e),r=this.warpDrag,h=this.warp,l=r>0?h[r-1].to:-1/0,u=r<h.length-1?h[r+1].to:1/0,d=this.range[1]-this.range[0];h[r]={...h[r],to:Math.min(Math.max(this.v(n),l+d*.001),u-d*.001)},this.draw(),this.onWarp(this.warp.map(f=>({...f})));return}if(this.drag===void 0)return;const[t,s]=this.pos(e),i=this.drag;this.stops=$i(this.stops,this.points,i,this.v(t));const o=Math.min(1,Math.max(0,1-(s-10)/(this.canvas.height-40)));this.stops=ys(this.stops,this.points,i,{opacity:o}),this.changed()}recolour(e){const t=this.near(e);if(t===void 0)return;const s=b("input",{type:"color",value:je(this.stops[t].color)});s.oninput=()=>{this.stops=ys(this.stops,this.points,t,{color:Vi(s.value)}),this.changed()},s.click()}remove(e){const t=this.near(e);t!==void 0&&(e.preventDefault(),!(this.stops.length<=2)&&(this.stops.splice(t,1),this.points=this.points.filter(s=>s!==t).map(s=>s>t?s-1:s),this.changed()))}changed(){this.draw(),this.onChange(this.stops.map(e=>({...e})))}}class Xs{rpc=new Zs(()=>Qs(new Worker(new URL(""+new URL("volume_worker-Be8XgPid.js",import.meta.url).href,import.meta.url),{type:"module",name:"volume view"})),{stopped:e=>`the volume reader stopped: ${e}. Reload the page to try again`});request(e,t={}){const{progress:s,signal:i}=t;return this.rpc.request(e,{signal:i,progress:o=>o.type==="progress"&&s?.(o.done,o.total)})}open(e,t){return this.request({type:"open",stores:e,space:t})}volume(e,t,s,i){return this.request({type:"volume",level:e,region:i},{progress:t,signal:s})}dispose(){this.rpc.dispose()}}const Xi=[{name:"MR T1 brain",modality:"MR",description:"A T1-weighted brain: the cortex's surface in warm grey, white matter paler beneath it.",domain:"percentile",stops:[{value:0,color:[.55,.42,.38],opacity:0},{value:20,color:[.62,.45,.4],opacity:0},{value:40,color:[.8,.62,.55],opacity:.35},{value:70,color:[.9,.78,.7],opacity:.8},{value:99.5,color:[.98,.95,.9],opacity:1}],density:40,shade_mix:.85,gradient_scale:30,roughness:.5,specular:.12,albedo:.95},{name:"HiP-CT brain",modality:"HiP-CT",description:"A HiP-CT brain in fixative: tissue in ivory, vessels and dense structure brighter.",domain:"percentile",stops:[{value:0,color:[.75,.7,.62],opacity:0},{value:10,color:[.8,.74,.66],opacity:0},{value:30,color:[.88,.8,.7],opacity:.4},{value:70,color:[.95,.88,.78],opacity:.8},{value:99.9,color:[1,.97,.92],opacity:1}],density:40,shade_mix:.85,gradient_scale:30,roughness:.45,specular:.15,albedo:.95},{name:"Histology (BigBrain)",modality:"histology",description:"Merker-stained sections: tissue in stain blue-grey, darker where cells are dense.",domain:"percentile",stops:[{value:0,color:[.55,.58,.72],opacity:0},{value:10,color:[.55,.58,.72],opacity:0},{value:35,color:[.62,.64,.78],opacity:.5},{value:80,color:[.8,.8,.88],opacity:.85},{value:99.9,color:[.95,.95,.98],opacity:1}],density:40,shade_mix:.85,gradient_scale:30,roughness:.5,specular:.1,albedo:.95},{name:"Translucent tissue",modality:"",description:"Any volume as a translucent, scattering solid: deep structure shows through the surface.",domain:"percentile",stops:[{value:0,color:[.9,.75,.65],opacity:0},{value:15,color:[.9,.75,.65],opacity:0},{value:50,color:[.95,.8,.7],opacity:.05},{value:95,color:[1,.92,.85],opacity:.4},{value:99.9,color:[1,1,1],opacity:.8}],density:12,shade_mix:.3,gradient_scale:30,roughness:.6,specular:.05,phase_g:.3,albedo:.98},{name:"Regions (labels)",modality:"labels",description:"Each region of a co-registered segmentation in its own colour, on the image's tissue.",domain:"percentile",stops:[{value:0,color:[1,1,1],opacity:0},{value:15,color:[1,1,1],opacity:0},{value:40,color:[1,1,1],opacity:.6},{value:99.9,color:[1,1,1],opacity:1}],density:40,shade_mix:.85,gradient_scale:30,roughness:.5,specular:.1,albedo:.95}],Hi=[{name:"INVVP",size:16,about:"clip -> display (world) coordinates, column-major"},{name:"VP",size:16,about:"world -> clip, column-major"},{name:"VOX_FROM_WORLD",size:12,about:"3x4 row-major: voxel index coordinates (x fastest) from world"},{name:"WORLD_NORMAL",size:9,about:"3x3 row-major: the transpose of VOX_FROM_WORLD's linear part"},{name:"DIMS",size:3,about:"volume size in voxels, x, y, z"},{name:"BRICK",size:1,about:"majorant brick size in voxels"},{name:"MGRID",size:3,about:"majorant grid size, x, y, z"},{name:"DENSITY",size:1,about:"extinction per display unit at opacity 1"},{name:"SHADE_MIX",size:1,about:"0: volume scattering only .. 1: surfaces where gradients are strong"},{name:"GRAD_SCALE",size:1,about:"how quickly the gradient's magnitude makes a surface (per texture unit per voxel)"},{name:"ROUGHNESS",size:1,about:""},{name:"SPECULAR",size:1,about:""},{name:"PHASE_G",size:1,about:""},{name:"ALBEDO",size:1,about:"scales the transfer function's colour"},{name:"LIGHT_DIR",size:3,about:"direction towards the key light, world, unit"},{name:"LIGHT_RGB",size:3,about:"key light radiance (irradiance at normal incidence)"},{name:"ENV_TOP",size:3,about:'environment: colour above (world "up")'},{name:"ENV_HORIZON",size:3,about:""},{name:"ENV_BOTTOM",size:3,about:""},{name:"ENV_UP",size:3,about:"world up for the environment, unit"},{name:"ENV_SCALE",size:1,about:""},{name:"BG",size:4,about:"background shown where primary rays leave (alpha 0: transparent)"},{name:"EXPOSURE",size:1,about:""},{name:"MAX_BOUNCES",size:1,about:""},{name:"NCLIP",size:1,about:""},{name:"CLIPS",size:24,about:"up to 6 planes, (nx, ny, nz, d) in world: kept where n.x + d >= 0"},{name:"CROP_LO",size:3,about:"crop box in voxel coordinates (inclusive), x, y, z"},{name:"CROP_HI",size:3,about:""},{name:"HAS_LABELS",size:1,about:""},{name:"LABEL_FROM_WORLD",size:12,about:"3x4 row-major: label voxel coordinates from world"},{name:"LDIMS",size:3,about:""},{name:"NLUT",size:1,about:""},{name:"LABEL_MIX",size:1,about:"0: the transfer function's colour .. 1: the label's colour"},{name:"STEP",size:1,about:"depth pass: step in voxels"},{name:"FRAME",size:1,about:"pass number, for the random sequence"},{name:"APERTURE",size:1,about:"thin lens: aperture radius in display units (0: pinhole)"},{name:"FOCUS",size:1,about:"thin lens: focal distance in display units"},{name:"OPAQUE_LIMIT",size:1,about:"depth pass: accumulated opacity where the surface is"},{name:"ENVMAP",size:1,about:"1: the environment is a light map (a texture), 0: the three colours"},{name:"ENV_RIGHT",size:3,about:"light map frame: right (world, unit)"},{name:"ENV_BACK",size:3,about:"light map frame: back (world, unit); up is ENV_UP"},{name:"ENV_ROT",size:1,about:"light map turned about up, radians"},{name:"INSET",size:1,about:"voxels along the gradient at which a collision takes its colour, on the more opaque side (0: where it is), so a surface shows the tissue beneath it, not the values between it and the medium"},{name:"FAST",size:1,about:"1: frames while the camera moves; through dense bricks the tracking steps a voxel at a time, summing optical depth (approximate, its cost bounded by the voxels crossed, not the density), 0: exact delta and ratio tracking"},{name:"DETAIL",size:1,about:"1 when a finer level's region (the detail) is held beside the coarse level"},{name:"DETAIL_FROM_WORLD",size:12,about:"3x4 row-major: the detail's voxel index coordinates from world"},{name:"DETAIL_NORMAL",size:9,about:"3x3 row-major: the transpose of DETAIL_FROM_WORLD's linear part"},{name:"DETAIL_DIMS",size:3,about:"the detail's size in voxels, x, y, z"},{name:"DETAIL_MGRID",size:3,about:"the detail's majorant grid size, x, y, z"},{name:"DETAIL_GSCALE",size:1,about:"coarse voxel size over detail voxel size: gradients per detail voxel to per coarse voxel"},{name:"NBOX",size:1,about:"how many crops (up to 8)"},{name:"BOXES",size:56,about:"8 crops x (lo x, y, z; hi x, y, z, voxel coordinates; mode: 1 keeps the inside, -1 cuts it out)"}],Wi={fields:Hi},ji=`// The path tracer in WGSL, for WebGPU in the page: the same method and parameter block as the
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
`,Ie=globalThis,z=new Proxy({},{get:(a,e)=>Ie.GPUBufferUsage[e]}),bs=new Proxy({},{get:(a,e)=>Ie.GPUTextureUsage[e]}),Ki=new Proxy({},{get:(a,e)=>Ie.GPUShaderStage[e]}),xs=new Proxy({},{get:(a,e)=>Ie.GPUMapMode[e]}),X=1024,xe=4,Qe={},Ts=(()=>{let a=0;for(const e of Wi.fields)Qe[e.name]=a,a+=e.size;return a})(),ve=Xi,qi={top:[.85,.9,1],horizon:[.55,.55,.6],bottom:[.12,.11,.1],scale:.6};function Yi(a){const e=new Float64Array(256);for(let d=0;d<a.length;++d)e[a[d]]++;let t=0;for(let d=1;d<25;++d)e[d]>e[t]&&(t=d);let s=t;for(;s+1<256&&e[s+1]<=e[s];)s++;const i=Float64Array.from(e);for(let d=0;d<=s;++d)i[d]=0;let o=i.reduce((d,f)=>d+f,0);const n=o>0?i:e;o===0&&(o=e.reduce((d,f)=>d+f,0));const r=new Map,h=[.5,1,2,5,10,20,30,40,50,60,70,80,90,95,98,99,99.5,99.9];let l=0,u=0;for(let d=0;d<256&&u<h.length;++d)for(l+=n[d];u<h.length&&l/o>=h[u]/100;)r.set(h[u++],d);for(;u<h.length;)r.set(h[u++],255);return r.set(0,s+1),r}function Ji(a,e,t,s){if(Math.min(e,t,s)<8)return;const i=new Float64Array(256),o=new Float64Array(256);for(let w=0;w<t;w+=2)for(let m=0;m<e;m+=2){const T=Math.hypot((w-(t-1)/2)/(t/2),(m-(e-1)/2)/(e/2));if(T>=.9)continue;const y=T>.75;for(let S=0;S<s;S+=2){const E=a[(S*t+w)*e+m];o[E]++,y&&i[E]++}}i[0]=0,o[0]=0;const n=i.map((w,m)=>{let T=0;for(let y=m-2;y<=m+2;++y)y>=0&&y<256&&(T+=i[y]);return T/5});let r=0;for(let w=1;w<256;++w)n[w]>n[r]&&(r=w);if(n[r]===0)return;let h=r;for(;h>0&&n[h]>.2*n[r];)h--;let l=r;for(;l<255&&n[l]>.2*n[r];)l++;const u=Math.max(r-h,l-r,1);let d=0,f=0;for(let w=r+u;w<256;++w)d+=o[w];for(let w=0;w<r-u;++w)f+=o[w];const v=w=>{let m=-1;for(let A=0;A<w.length;++A)w[A]>0&&(m=A);if(m<0)return 1;const T=Math.max(5,Math.floor((m+1)/40))|1,y=new Float64Array(w.length);for(let A=0;A<w.length;++A){let W=0;for(let M=A-(T>>1);M<=A+(T>>1);++M)M>=0&&M<w.length&&(W+=w[M]);y[A]=W/T}const S=Math.max(...y);let E=-1,F=1/0;for(let A=0;A<T-(T>>1)-1;++A)F=Math.min(F,y[A]);for(let A=T;A<y.length-1;++A)F=Math.min(F,y[A-(T>>1)-1]),y[A]>=y[A-1]&&y[A]>y[A+1]&&y[A]>1.3*F&&y[A]>.05*S&&(E<0||y[A]>y[E])&&(E=A);if(E<0){const A=w.reduce((M,j)=>M+j,0);let W=0;E=w.length-1;for(let M=0;M<w.length;++M)if((W+=w[M])/A>=.99){E=M;break}E=Math.floor(E/2)}return Math.max(E,1)};if(d>=f&&d>0)return[r+u,r+u+2*v(o.slice(r+u))];if(f>0){const w=Math.max(0,r-u);return[w-2*v(o.slice(0,w).reverse()),w]}}function Ke(a,e,t){if(a<=e[0])return t[0];for(let s=1;s<e.length;++s)if(a<=e[s])return t[s-1]+(t[s]-t[s-1])*(a-e[s-1])/(e[s]-e[s-1]||1);return t[t.length-1]}function et(a,e,t){const s=[...e.keys()].sort((l,u)=>l-u),i=t??[0,255],o=l=>(a.domain==="percentile"?Ke(l,s,s.map(u=>e.get(u))):a.domain==="window"?i[0]+l*(i[1]-i[0]):l)/255,n=a.stops.map(l=>({x:o(l.value),c:l.color,a:l.opacity})).sort((l,u)=>l.x-u.x),r=n.map(l=>l.x),h=new Float32Array(X*4);for(let l=0;l<X;++l){const u=l/(X-1);for(let d=0;d<3;++d)h[4*l+d]=Ke(u,r,n.map(f=>f.c[d]));h[4*l+3]=Ke(u,r,n.map(d=>d.a))}return h}const tt=(a,e)=>{const t=new Array(16).fill(0);for(let s=0;s<4;++s)for(let i=0;i<4;++i)for(let o=0;o<4;++o)t[4*s+i]+=a[4*s+o]*e[4*o+i];return t};function st(a){const e=a.slice(),t=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];for(let s=0;s<4;++s){let i=s;for(let n=s+1;n<4;++n)Math.abs(e[4*n+s])>Math.abs(e[4*i+s])&&(i=n);for(let n=0;n<4;++n)[e[4*s+n],e[4*i+n]]=[e[4*i+n],e[4*s+n]],[t[4*s+n],t[4*i+n]]=[t[4*i+n],t[4*s+n]];const o=e[4*s+s];for(let n=0;n<4;++n)e[4*s+n]/=o,t[4*s+n]/=o;for(let n=0;n<4;++n){if(n===s)continue;const r=e[4*n+s];for(let h=0;h<4;++h)e[4*n+h]-=r*e[4*s+h],t[4*n+h]-=r*t[4*s+h]}}return t}const Ae=a=>{const e=new Array(16);for(let t=0;t<4;++t)for(let s=0;s<4;++s)e[4*t+s]=a[4*s+t];return e};function it(a){const e=(l,u,d)=>{const f=[0,1,2,3].map(v=>a[4*v]*l+a[4*v+1]*u+a[4*v+2]*d+a[4*v+3]);return[f[0]/f[3],f[1]/f[3],f[2]/f[3]]},t=(l,u)=>l.map((d,f)=>d-u[f]),s=l=>{const u=Math.hypot(...l);return l.map(d=>d/u)},i=(l,u)=>l[0]*u[0]+l[1]*u[1]+l[2]*u[2],o=e(0,0,-1),n=s(t(e(0,0,1),o));let r=t(e(1,0,-1),o);r=s(r.map((l,u)=>l-n[u]*i(r,n)));const h=[r[1]*n[2]-r[2]*n[1],r[2]*n[0]-r[0]*n[2],r[0]*n[1]-r[1]*n[0]];return[r,h,n.map(l=>-l)]}async function Hs(a,e,t,s,i){const{levels:o,window:n}=await a.open([e.endsWith("/")?e:`${e}/`],void 0),r=o.filter(f=>f.size[0]*f.size[1]*f.size[2]<=t&&Math.max(...f.size)<=s),h=r.length?o.indexOf(r[0]):o.length-1,l=o[h];i?.(`reading level ${l.path} (${l.size.join(" × ")})`);const{data:u,size:d}=await a.volume(h,(f,v)=>i?.(`reading level ${l.path}: ${f}/${v} chunks`));return{data:u,size:d,voxelToRas:Array.from(l.voxelToRas),range:n??[0,255],pct:Yi(u),window:Ji(u,d[0],d[1],d[2]),path:l.path}}async function Zi(){const a=navigator.gpu;if(a!==void 0)return await a.requestAdapter({powerPreference:"high-performance"})??void 0}async function Ws(a,e,t,s=()=>!1){const[i,o,n]=e,r=[Math.ceil(i/t),Math.ceil(o/t),Math.ceil(n/t)],h=r[0]*r[1]*r[2],l=new Float32Array(h*2);for(let d=0;d<h;++d)l[2*d]=1,l[2*d+1]=0;const u=Math.max(1,Math.floor(4e6/Math.max(1,i*o)));for(let d=0;d<n;d+=u){if(d>0&&await new Promise(f=>setTimeout(f,0)),s())return l;for(let f=d;f<Math.min(n,d+u);++f){const v=Math.floor(Math.max(0,f-1)/t),w=Math.floor(Math.min(n-1,f+1)/t);for(let m=0;m<o;++m){const T=Math.floor(Math.max(0,m-1)/t),y=Math.floor(Math.min(o-1,m+1)/t),S=(f*o+m)*i;for(let E=0;E<i;++E){const F=a[S+E]/255,A=Math.floor(Math.max(0,E-1)/t),W=Math.floor(Math.min(i-1,E+1)/t);for(let M=v;M<=w;++M)for(let j=T;j<=y;++j)for(let q=A;q<=W;++q){const H=(M*r[1]+j)*r[0]+q;F<l[2*H]&&(l[2*H]=F),F>l[2*H+1]&&(l[2*H+1]=F)}}}}}return l}class Qi{onFrame;status="";device;pipelines={};layout;tex;sampler;bounds;maj;nbricks=0;grid=[1,1,1];size=[1,1,1];voxelToRas=[];pct=new Map;window;params;tf;accum;out;depth;uni;W=0;H=0;bind;view;tag="";appliedView={camera:[],tag:""};version=0;applied=-1;samples=0;frameNo=0;maxSamples=256;running=!1;disposed=!1;ready=!1;client;adapterName="";level;async load(e,t,s){const i=await Zi();if(i===void 0)throw new Error("This browser has no WebGPU adapter.");const o=i.info;this.adapterName=[o?.vendor,o?.architecture,o?.description].filter(Boolean).join(" ")||"WebGPU";const n=i.limits,r=await i.requestDevice({requiredLimits:{maxStorageBufferBindingSize:Math.min(n.maxStorageBufferBindingSize,1<<30),maxBufferSize:Math.min(n.maxBufferSize,1<<30)}});this.device=r,this.client?.dispose(),this.client=new Xs;const h=await Hs(this.client,e,t,r.limits.maxTextureDimension3D,s),{data:l,size:u}=h;this.level=h,this.size=u,this.voxelToRas=h.voxelToRas,this.pct=h.pct,this.window=h.window;const[d,f,v]=u;this.tex=r.createTexture({size:[d,f,v],dimension:"3d",format:"r8unorm",usage:bs.TEXTURE_BINDING|bs.COPY_DST});const w=Math.ceil(d/256)*256;if(w===d)r.queue.writeTexture({texture:this.tex},l,{bytesPerRow:d,rowsPerImage:f},[d,f,v]);else{const y=new Uint8Array(w*f*v);for(let S=0;S<v;++S)for(let E=0;E<f;++E)y.set(l.subarray((S*f+E)*d,(S*f+E+1)*d),(S*f+E)*w);r.queue.writeTexture({texture:this.tex},y,{bytesPerRow:w,rowsPerImage:f},[d,f,v])}this.sampler=r.createSampler({magFilter:"linear",minFilter:"linear",addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge",addressModeW:"clamp-to-edge"});const m=[Math.ceil(d/xe),Math.ceil(f/xe),Math.ceil(v/xe)];this.grid=m,this.nbricks=m[0]*m[1]*m[2],s?.("finding empty space");const T=await Ws(l,u,xe,()=>this.disposed);if(this.disposed)throw new Error("closed");return this.bounds=r.createBuffer({size:T.byteLength,usage:z.STORAGE|z.COPY_DST}),r.queue.writeBuffer(this.bounds,0,T),this.maj=r.createBuffer({size:this.nbricks*4,usage:z.STORAGE}),this.params=r.createBuffer({size:Ts*4,usage:z.STORAGE|z.COPY_DST}),this.tf=r.createBuffer({size:X*16,usage:z.STORAGE|z.COPY_DST}),this.uni=r.createBuffer({size:16,usage:z.UNIFORM|z.COPY_DST}),this.compile(r),this.applied=-1,this.ready=!0,`level ${h.path} (${u.join(" × ")}) on ${this.adapterName}`}compile(e){const t=`const TF_SIZE: u32 = ${X}u;
`+Object.entries(Qe).map(([n,r])=>`const P_${n}: u32 = ${r}u;`).join(`
`)+`
`,s=e.createShaderModule({code:t+ji}),i=Ki.COMPUTE;this.layout=e.createBindGroupLayout({entries:[{binding:0,visibility:i,buffer:{type:"read-only-storage"}},{binding:1,visibility:i,texture:{sampleType:"float",viewDimension:"3d"}},{binding:2,visibility:i,sampler:{type:"filtering"}},{binding:3,visibility:i,buffer:{type:"read-only-storage"}},{binding:4,visibility:i,buffer:{type:"storage"}},{binding:5,visibility:i,buffer:{type:"storage"}},{binding:6,visibility:i,buffer:{type:"storage"}},{binding:7,visibility:i,buffer:{type:"storage"}},{binding:8,visibility:i,buffer:{type:"read-only-storage"}},{binding:9,visibility:i,buffer:{type:"uniform"}}]});const o=e.createPipelineLayout({bindGroupLayouts:[this.layout]});for(const n of["trace","firsthit","majorant","tonemap"])this.pipelines[n]=e.createComputePipeline({layout:o,compute:{module:s,entryPoint:n}})}resize(e,t){const s=this.device;e===this.W&&t===this.H&&this.accum||(this.accum?.destroy(),this.out?.destroy(),this.depth?.destroy(),this.W=e,this.H=t,this.accum=s.createBuffer({size:e*t*16,usage:z.STORAGE|z.COPY_DST}),this.out=s.createBuffer({size:e*t*4,usage:z.STORAGE|z.COPY_SRC}),this.depth=s.createBuffer({size:e*t*4,usage:z.STORAGE|z.COPY_SRC}),this.bind=s.createBindGroup({layout:this.layout,entries:[{binding:0,resource:{buffer:this.params}},{binding:1,resource:this.tex.createView({dimension:"3d"})},{binding:2,resource:this.sampler},{binding:3,resource:{buffer:this.tf}},{binding:4,resource:{buffer:this.maj}},{binding:5,resource:{buffer:this.accum}},{binding:6,resource:{buffer:this.out}},{binding:7,resource:{buffer:this.depth}},{binding:8,resource:{buffer:this.bounds}},{binding:9,resource:{buffer:this.uni}}]}))}setView(e,t=""){this.view=e,this.tag=t,this.version++,this.maxSamples=e.max_samples??256,this.running||this.loop()}pack(e,t,s){const i=Qe,o=new Float32Array(Ts),n=Ae(e.inv_view_projection),r=st(n),h=(U,G)=>o.set(Array.from(G),i[U]),l=U=>{const G=new Array(16);for(let ne=0;ne<4;++ne)for(let ae=0;ae<4;++ae)G[4*ae+ne]=U[4*ne+ae];return G};h("INVVP",l(n)),h("VP",l(r));const u=e.world_from_physical?Ae(e.world_from_physical):[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],d=tt(u,this.voxelToRas),f=st(d);h("VOX_FROM_WORLD",f.slice(0,12)),h("WORLD_NORMAL",[f[0],f[4],f[8],f[1],f[5],f[9],f[2],f[6],f[10]]),h("DIMS",this.size),o[i.BRICK]=xe,h("MGRID",this.grid);const v=typeof e.preset=="string"?e.preset:String(e.preset.name??""),m={...(typeof e.preset=="object"?e.preset:ve.find(U=>U.name===v))??ve[0],...e.overrides??{}};o[i.DENSITY]=m.density*(e.unit_mm??1),o[i.SHADE_MIX]=m.shade_mix??.8,o[i.GRAD_SCALE]=m.gradient_scale??40,o[i.ROUGHNESS]=m.roughness??.45,o[i.SPECULAR]=m.specular??.15,o[i.PHASE_G]=m.phase_g??0,o[i.ALBEDO]=m.albedo??.9,o[i.INSET]=m.surface_inset??0;const[T,y,S]=it(n),E=e.light?.direction??[.4,.7,.6];let F=e.light?.camera_space===!1?E:[0,1,2].map(U=>E[0]*T[U]+E[1]*y[U]+E[2]*S[U]);const A=Math.hypot(...F);F=F.map(U=>U/A),h("LIGHT_DIR",F);const W=m.light_scale??1;h("LIGHT_RGB",(e.light?.rgb??[3.2,3,2.8]).map(U=>U*W));const M={...qi,...m.environment??{}};h("ENV_TOP",M.top),h("ENV_HORIZON",M.horizon),h("ENV_BOTTOM",M.bottom),h("ENV_UP",y),o[i.ENV_SCALE]=M.scale??1,h("BG",e.background??[0,0,0,0]),o[i.EXPOSURE]=m.exposure??1,o[i.MAX_BOUNCES]=e.max_bounces??4;const j=(e.clips??[]).slice(0,6);o[i.NCLIP]=j.length,j.forEach((U,G)=>o.set(U,i.CLIPS+4*G));const q=e.boxes?.find(U=>U.keep),H=e.crop_fraction??(q?[q.lo,q.hi]:void 0);return h("CROP_LO",H?H[0].map((U,G)=>U*this.size[G]-.5):[-1e9,-1e9,-1e9]),h("CROP_HI",H?H[1].map((U,G)=>U*this.size[G]-.5):[1e9,1e9,1e9]),o[i.STEP]=.5,o[i.APERTURE]=e.aperture??0,o[i.FOCUS]=e.focus??0,o[i.OPAQUE_LIMIT]=.5,{P:o,preset:m}}async loop(){this.running=!0;const e=this.device;let t=0,s;try{for(;!this.disposed;){const i=this.view;if(i===void 0||this.applied===this.version&&this.samples>=this.maxSamples)break;const o=Math.max(8,Math.round(i.width*(i.scale??1))),n=Math.max(8,Math.round(i.height*(i.scale??1)));if(this.applied!==this.version){const d=this.version;this.resize(o,n);const{P:f,preset:v}=this.pack(i,o,n);e.queue.writeBuffer(this.params,0,f),e.queue.writeBuffer(this.tf,0,et(v,this.pct,this.window)),e.queue.writeBuffer(this.uni,0,new Uint32Array([o,n,0,0]));const w=e.createCommandEncoder();w.clearBuffer(this.accum);const m=w.beginComputePass();m.setBindGroup(0,this.bind),m.setPipeline(this.pipelines.majorant),m.dispatchWorkgroups(Math.ceil(this.nbricks/64)),m.setPipeline(this.pipelines.firsthit),m.dispatchWorkgroups(Math.ceil(o/8),Math.ceil(n/8)),m.end();const T=e.createBuffer({size:o*n*4,usage:z.COPY_DST|z.MAP_READ});w.copyBufferToBuffer(this.depth,0,T,0,o*n*4),e.queue.submit([w.finish()]),await T.mapAsync(xs.READ),s={width:o,height:n,data:new Float32Array(T.getMappedRange().slice(0)),version:d},T.unmap(),T.destroy(),this.applied=d,this.appliedView={camera:i.inv_view_projection,tag:this.tag},this.samples=0,t=0}const r=performance.now(),h=1;for(let d=0;d<h;++d){this.frameNo++,this.samples++,e.queue.writeBuffer(this.uni,0,new Uint32Array([o,n,this.frameNo,this.samples]));const f=e.createCommandEncoder(),v=f.beginComputePass();v.setBindGroup(0,this.bind),v.setPipeline(this.pipelines.trace),v.dispatchWorkgroups(Math.ceil(o/8),Math.ceil(n/8)),v.end(),e.queue.submit([f.finish()])}await e.queue.onSubmittedWorkDone();const l=(performance.now()-r)/h,u=this.samples;((u&u-1)===0||performance.now()-t>250||u>=this.maxSamples)&&(await this.publish(o,n,l,s),t=performance.now())}}catch(i){this.status=`WebGPU: ${i.message}`}finally{this.running=!1}}async publish(e,t,s,i){const o=this.device,n=o.createCommandEncoder(),r=n.beginComputePass();r.setBindGroup(0,this.bind),r.setPipeline(this.pipelines.tonemap),r.dispatchWorkgroups(Math.ceil(e/8),Math.ceil(t/8)),r.end();const h=o.createBuffer({size:e*t*4,usage:z.COPY_DST|z.MAP_READ});n.copyBufferToBuffer(this.out,0,h,0,e*t*4),o.queue.submit([n.finish()]),await h.mapAsync(xs.READ);const l=new Uint8ClampedArray(h.getMappedRange().slice(0));h.unmap(),h.destroy();const u=await createImageBitmap(new ImageData(l,e,t),{premultiplyAlpha:"none"});this.onFrame?.({bitmap:u,depth:i,...this.appliedView,samples:this.samples,width:e,height:t,msPerPass:s,version:this.applied})}dispose(){this.disposed=!0,this.client?.dispose(),this.tex?.destroy(),this.device?.destroy()}}const eo=32e6,to=2048,Pe=8,so=96,Te=48,io=8,oo={top:[.85,.9,1],horizon:[.55,.55,.6],bottom:[.12,.11,.1],scale:.6};function no(a,e){const[t,s]=e.range,i=n=>(n-t)/(s-t||1)*255;if(a.domain==="data")return et({...a,stops:a.stops.map(n=>({...n,value:i(n.value)}))},e.pct);const o=a.domain==="window"&&a.window?[i(a.window[0]),i(a.window[1])]:e.window;return et(a,e.pct,o)}function ao(a,e){const t=new Int32Array(X+1);for(let i=0;i<X;++i)t[i+1]=t[i]+(e[4*i+3]>0?1:0);const s=new Uint8Array(a.length/2);for(let i=0;i<s.length;++i){const o=Math.max(0,Math.floor(a[2*i]*(X-1))),n=Math.min(X-1,Math.ceil(a[2*i+1]*(X-1)));s[i]=n>=o&&t[n+1]-t[o]>0?255:0}return s}function ro(a){const e=Math.max(1,Math.ceil(Math.max(...a)/so));return{cell:e,grid:[0,1,2].map(t=>Math.ceil(a[t]/e))}}function co(a,e,t){const s=Ae(a.inv_view_projection),i=a.world_from_physical?Ae(a.world_from_physical):[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],o=st(tt(i,t.voxelToRas)),[n,r,h]=it(s),l=a.light?.direction??[.4,.7,.6];let u=a.light?.camera_space===!1?l:[0,1,2].map(y=>l[0]*n[y]+l[1]*r[y]+l[2]*h[y]);const d=Math.hypot(...u);u=u.map(y=>y/d);const f=e.light_scale??1,v={...oo,...e.environment??{}},w=a.boxes?.find(y=>y.keep),m=a.crop_fraction??(w?[w.lo,w.hi]:void 0),T=(a.clips??[]).slice(0,6);return{voxFromWorld:[0,1,2,3].flatMap(y=>[0,1,2,3].map(S=>o[4*S+y])),worldFromVox:(()=>{const y=tt(i,t.voxelToRas);return[0,1,2,3].flatMap(S=>[0,1,2,3].map(E=>y[4*E+S]))})(),dims:t.size,cropLo:m?m[0].map((y,S)=>y*t.size[S]-.5):[-1e9,-1e9,-1e9],cropHi:m?m[1].map((y,S)=>y*t.size[S]-.5):[1e9,1e9,1e9],clips:Array.from({length:24},(y,S)=>T[S>>2]?.[S&3]??0),nclip:T.length,density:e.density*(a.unit_mm??1),shadeMix:e.shade_mix??.8,gradScale:e.gradient_scale??40,roughness:e.roughness??.45,specular:e.specular??.15,phaseG:e.phase_g??0,albedo:e.albedo??.9,exposure:e.exposure??1,lightDir:u,lightRgb:(a.light?.rgb??[3.2,3,2.8]).map(y=>y*f),envTop:v.top,envHorizon:v.horizon,envBottom:v.bottom,envUp:r,envScale:v.scale??1}}const Es=`#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`,js=`precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform sampler2D uTf;
uniform mat4 uVoxFromWorld;
uniform vec3 uDims;
uniform vec3 uCropLo;
uniform vec3 uCropHi;
uniform vec4 uClips[6];
uniform int uNClip;
uniform float uDensity;
uniform float uPhaseG;
uniform float uAlbedo;
uniform vec3 uLightDir;
uniform vec3 uLightRgb;
uniform vec3 uEnvTop;
uniform vec3 uEnvHorizon;
uniform vec3 uEnvBottom;
uniform vec3 uEnvUp;
uniform float uEnvScale;
uniform float uCell;

float tex(vec3 v) { return texture(uVol, (v + 0.5) / uDims).r; }
vec4 tf(float t) { return texture(uTf, vec2((clamp(t, 0.0, 1.0) * ${X-1}.0 + 0.5) / ${X}.0, 0.5)); }
bool cut(vec3 w, vec3 v) {
  if (any(lessThan(v, uCropLo)) || any(greaterThan(v, uCropHi))) return true;
  for (int i = 0; i < 6; ++i) {
    if (i >= uNClip) break;
    if (dot(uClips[i].xyz, w) + uClips[i].w < 0.0) return true;
  }
  return false;
}
float sigma(vec3 w, vec3 v) { return cut(w, v) ? 0.0 : uDensity * tf(tex(v)).a; }
// The transmittance from a point toward dir (world, unit), from 1.5 voxels to reach voxels away.
float clear(vec3 w, vec3 v, vec3 dir, float reach) {
  vec3 dv = mat3(uVoxFromWorld) * dir;
  float vox = 1.0 / max(length(dv), 1e-12);
  float T = 1.0;
  float before = 0.0;
  for (float d = 1.5; d < reach; d *= 2.0) {
    T *= exp(-sigma(w + dir * (d * vox), v + dv * (d * vox)) * (d - before) * vox);
    before = d;
  }
  return T;
}
vec3 env(vec3 d) {
  float u = dot(d, uEnvUp);
  return (u > 0.0 ? uEnvHorizon * (1.0 - u) + uEnvTop * u : uEnvHorizon * (1.0 + u) + uEnvBottom * (-u)) * uEnvScale;
}
float hg(float c, float g) {
  float d = 1.0 + g * g - 2.0 * g * c;
  return (1.0 - g * g) / (12.566371 * d * sqrt(d));
}
// Where a ray from voxel point v, dv voxels a world unit, is in the level and its crop (world units from v).
vec2 span(vec3 v, vec3 dv) {
  vec3 bmin = max(vec3(-0.5), uCropLo - 0.5);
  vec3 bmax = min(uDims - 0.5, uCropHi + 0.5);
  vec3 safe = mix(dv, vec3(1e-12), lessThan(abs(dv), vec3(1e-12)));
  vec3 ta = (bmin - v) / safe;
  vec3 tb = (bmax - v) / safe;
  vec3 tlo = min(ta, tb);
  vec3 thi = max(ta, tb);
  return vec2(max(max(max(tlo.x, tlo.y), tlo.z), 0.0), min(min(thi.x, thi.y), thi.z));
}`,lo=a=>`#version 300 es
${js}
uniform highp sampler3D uOcc;
uniform bool uHasOcc;
uniform highp sampler3D uLight;
uniform bool uHasLight;
uniform mat4 uInvVP;
uniform mat4 uVP;
uniform vec4 uViewport;
uniform float uStep;
uniform float uShadeMix;
uniform float uGradScale;
uniform float uRoughness;
uniform float uSpecular;
uniform float uExposure;
uniform float uSplit;
layout(location = ${a.color}) out vec4 out_color;
layout(location = ${a.z}) out highp vec4 out_z;
layout(location = ${a.pick}) out highp vec4 out_pickId;

float noise() { return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); }
vec4 lightAt(vec3 v) { return texture(uLight, (v + 0.5) / (uCell * vec3(textureSize(uLight, 0)))); }
vec3 brdfCos(vec3 n, vec3 wo, vec3 wl, vec3 albedo) {
  float cl = dot(n, wl);
  if (cl <= 0.0) return vec3(0.0);
  vec3 h = normalize(wo + wl);
  float e = max(1.0, 2.0 / max(uRoughness * uRoughness, 1e-4) - 2.0);
  float s = uSpecular * (e + 8.0) / 25.132741 * pow(max(dot(n, h), 0.0), e);
  return (albedo * ((1.0 - uSpecular) * 0.31830989) + vec3(s)) * cl;
}
void main() {
  // While the path-traced picture comes in over it, the object keeps the pixels it has not taken yet.
  if (noise() >= uSplit) discard;
  vec2 ndc = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
  vec4 a = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvVP * vec4(ndc, 1.0, 1.0);
  vec3 ow = a.xyz / a.w;
  vec3 far = b.xyz / b.w;
  vec3 dw = normalize(far - ow);
  mat3 lin = mat3(uVoxFromWorld);
  vec3 ov = (uVoxFromWorld * vec4(ow, 1.0)).xyz;
  vec3 dv = lin * dw;
  vec3 safe = mix(dv, vec3(1e-12), lessThan(abs(dv), vec3(1e-12)));
  vec2 sp = span(ov, dv);
  float t0 = sp.x;
  float t1 = min(sp.y, length(far - ow));
  if (t1 <= t0) discard;
  float dt = uStep / length(dv);
  mat3 normalFrom = transpose(lin);
  vec3 around = (uEnvTop + 2.0 * uEnvHorizon + uEnvBottom) * (0.25 * uEnvScale);
  vec3 L = vec3(0.0);
  float T = 1.0;
  vec3 hit = vec3(0.0);
  bool met = false;
  float t = t0 + dt * noise();
  ivec3 grid = textureSize(uOcc, 0);
  for (int k = 0; k < 4096; ++k) {
    if (t >= t1 || T < 0.02) break;
    vec3 w = ow + dw * t;
    vec3 v = ov + dv * t;
    if (uHasOcc) {
      // A brick the preset leaves clear: on to where the ray leaves it, at the same phase of the steps.
      vec3 cell = clamp(floor((v + 0.5) / ${Pe}.0), vec3(0.0), vec3(grid - 1));
      if (texelFetch(uOcc, ivec3(cell), 0).r == 0.0) {
        vec3 side = cell * ${Pe}.0 - 0.5 + ${Pe}.0 * step(0.0, safe);
        vec3 leave = (side - v) / safe;
        float gone = max(min(min(leave.x, leave.y), leave.z), 0.0);
        t += max(ceil(gone / dt), 1.0) * dt;
        continue;
      }
    }
    t += dt;
    float s = sigma(w, v);
    if (s <= 0.0) continue;
    float al = 1.0 - exp(-s * dt);
    vec3 albedo = tf(tex(v)).rgb * uAlbedo;
    vec3 g = vec3(tex(v + vec3(1.0, 0.0, 0.0)) - tex(v - vec3(1.0, 0.0, 0.0)),
                  tex(v + vec3(0.0, 1.0, 0.0)) - tex(v - vec3(0.0, 1.0, 0.0)),
                  tex(v + vec3(0.0, 0.0, 1.0)) - tex(v - vec3(0.0, 0.0, 1.0))) * 0.5;
    float gm = length(g);
    float edge = 1.0 - exp(-uGradScale * gm);
    float Tl;
    vec3 amb;
    if (uHasLight) {
      // The light held, half a cell out from a surface (so the tissue beneath it does not shade it).
      vec4 held = lightAt(v - (gm > 1e-6 ? g / gm : vec3(0.0)) * (0.5 * uCell * edge));
      Tl = held.a;
      amb = held.rgb;
    } else {
      Tl = clear(w, v, uLightDir, 25.0);
      // One ray stands for the path tracer's many directions to the surroundings: it shades only in part.
      amb = albedo * around * (0.35 + 0.65 * clear(w, v, uEnvUp, 13.0));
    }
    vec3 col = albedo * (uLightRgb * (hg(dot(dw, uLightDir), uPhaseG) * Tl) + amb);
    if (gm > 1e-6) {
      vec3 n = -normalize(normalFrom * g);
      if (dot(n, dw) > 0.0) n = -n;
      // What is held is the mean over every direction, the tissue's own light among it.
      vec3 sky = uHasLight ? amb : env(n) * (0.35 + 0.65 * clear(w, v, n, 13.0));
      vec3 surf = brdfCos(n, -dw, uLightDir, albedo) * uLightRgb * Tl + albedo * sky * (1.0 - uSpecular);
      col = mix(col, surf, uShadeMix * edge);
    }
    L += T * al * col;
    T *= 1.0 - al;
    if (!met && T <= 0.5) {
      met = true;
      hit = w;
    }
  }
  // As the picture: drawn where the ray met tissue, at the depth where it did.
  if (!met) discard;
  vec3 c = L / (1.0 - T) * uExposure;
  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  c = clamp(c, 0.0, 1.0);
  c = mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  vec4 p = uVP * vec4(hit, 1.0);
  float d = clamp((p.z / p.w) * 0.5 + 0.5, 0.0, 0.99999);
  gl_FragDepth = d;
  out_color = vec4(c, 1.0);
  out_z = vec4(1.0 - d);
  out_pickId = vec4(0.0);
}`,ho=`#version 300 es
${js}
uniform highp sampler3D uPrev;
uniform mat4 uWorldFromVox;
uniform int uLayer;
uniform int uPass;
uniform uint uSeed;
out vec4 o;

uint rs;
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float rnd() {
  rs = pcg(rs);
  return float(rs >> 8u) * (1.0 / 16777216.0);
}
vec3 world(vec3 v) { return (uWorldFromVox * vec4(v, 1.0)).xyz; }
vec3 sphere() {
  float z = 1.0 - 2.0 * rnd();
  float r = sqrt(max(0.0, 1.0 - z * z));
  float ph = 6.2831853 * rnd();
  return vec3(r * cos(ph), r * sin(ph), z);
}
vec3 hgdir(vec3 w, float g) {
  float u1 = rnd();
  float c = 1.0 - 2.0 * u1;
  if (abs(g) >= 1e-3) {
    float s = (1.0 - g * g) / (1.0 - g + 2.0 * g * u1);
    c = (1.0 + g * g - s * s) / (2.0 * g);
  }
  float sn = sqrt(max(0.0, 1.0 - c * c));
  float ph = 6.2831853 * rnd();
  vec3 a = abs(w.x) > 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(a, w));
  return normalize(t * (sn * cos(ph)) + cross(w, t) * (sn * sin(ph)) + w * c);
}
// The transmittance from voxel point v toward dir (world, unit) to the level's edge, a voxel a step.
float transmit(vec3 v, vec3 dir) {
  vec3 dv = mat3(uVoxFromWorld) * dir;
  vec3 w = world(v);
  float dt = 1.0 / length(dv);
  float t1 = span(v, dv).y;
  float tau = 0.0;
  for (int k = 0; k < 4096; ++k) {
    float t = (float(k) + 0.5) * dt;
    if (t >= t1 || tau > 8.0) break;
    tau += sigma(w + dir * t, v + dv * t) * dt;
  }
  return exp(-tau);
}
// Where a ray from voxel point v toward dir first scatters (where its optical depth reaches -log(1 - u),
// 1.5 voxels a step); false when it leaves the level first.
bool collide(inout vec3 v, vec3 dir) {
  vec3 dv = mat3(uVoxFromWorld) * dir;
  vec3 w = world(v);
  float dt = 1.5 / length(dv);
  float t1 = span(v, dv).y;
  float target = -log(1.0 - rnd());
  float tau = 0.0;
  float t = dt * rnd();
  for (int k = 0; k < 4096; ++k) {
    if (t >= t1) return false;
    tau += sigma(w + dir * t, v + dv * t) * dt;
    if (tau >= target) {
      v += dv * t;
      return true;
    }
    t += dt;
  }
  return false;
}
float lightAt(vec3 v) { return texture(uPrev, (v + 0.5) / (uCell * vec3(textureSize(uPrev, 0)))).a; }
// The light arriving at voxel point v from direction -dir (dir: the way the path goes out from it).
vec3 incoming(vec3 v, vec3 dir) {
  vec3 thr = vec3(1.0);
  vec3 L = vec3(0.0);
  for (int bounce = 0; bounce < 3; ++bounce) {
    if (!collide(v, dir)) return L + thr * env(dir);
    thr *= tf(tex(v)).rgb * uAlbedo;
    L += thr * uLightRgb * (hg(dot(dir, uLightDir), uPhaseG) * lightAt(v));
    dir = hgdir(dir, uPhaseG);
  }
  return L;
}
void main() {
  ivec3 cell = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  rs = pcg(uint(cell.x) + 1024u * uint(cell.y) + 1048576u * uint(cell.z)) ^ pcg(uSeed);
  vec3 v = (vec3(cell) + 0.5) * uCell - 0.5;
  if (uPass == 0) {
    o = vec4(0.0, 0.0, 0.0, transmit(v, uLightDir));
    return;
  }
  vec4 prev = texelFetch(uPrev, cell, 0);
  vec3 at = v + (vec3(rnd(), rnd(), rnd()) - 0.5) * uCell;
  o = vec4(mix(prev.rgb, incoming(at, sphere()), 1.0 / float(uPass)), prev.a);
}`;class uo{look;onChange;onRedraw;base="";url="";client;level;gl;program;programFor="";failed=!1;vao;vol;tf;uploaded;tfKey="";occ;bounds;occFor;held;lightRead;lightFill;fb;bake;canBake=!1;get text(){const e=this.held;return!this.base||this.level===void 0||e===void 0||!this.canBake?this.base:`${this.base}; light ${e.pass>=Te?"done":`${Math.max(0,e.pass-1)} of ${Te-1} passes`}`}async open(e){if(e!==this.url){this.close(),this.url=e;try{this.client=new Xs,this.base="Object: reading the image";const t=await Hs(this.client,e,eo,to,s=>this.base=`Object: ${s}`);if(this.url!==e)return;this.setLevel(t,e)}catch(t){if(this.url!==e)return;this.base=`Object: ${t.message}`,this.onChange?.()}finally{this.url===e&&(this.client?.dispose(),this.client=void 0)}}}setLevel(e,t){this.url=t,this.level=e,this.failed=!1,this.held=void 0,this.base=`Object: level ${e.path} (${e.size.join(" × ")})`,this.onChange?.(),Ws(e.data,e.size,Pe,()=>this.level!==e).then(s=>{this.level===e&&(this.bounds={level:e,data:s},this.onChange?.())})}ready(){return this.level!==void 0&&!this.failed}draw(e,t=1){const s=this.level,i=s&&!this.failed?this.look?.(e):void 0;if(s===void 0||i===void 0)return!1;const o=e.gl;if(this.gl!==o&&this.reset(o),Math.max(...s.size)>o.getParameter(o.MAX_3D_TEXTURE_SIZE))return this.fail("the level is larger than this GPU's 3-D textures");const n=JSON.stringify(e.outputs);if(this.program===void 0||this.programFor!==n){this.program&&o.deleteProgram(this.program),this.program=void 0;try{this.program=Ss(o,Es,lo(e.outputs)),this.programFor=n}catch(y){return this.fail(y.message)}}const{cell:r,grid:h}=ro(s.size);if(this.uploaded!==s){o.activeTexture(o.TEXTURE6),o.bindTexture(o.TEXTURE_3D,this.vol),o.pixelStorei(o.UNPACK_ALIGNMENT,1),o.texImage3D(o.TEXTURE_3D,0,o.R8,s.size[0],s.size[1],s.size[2],0,o.RED,o.UNSIGNED_BYTE,s.data),o.pixelStorei(o.UNPACK_ALIGNMENT,4);for(const y of[this.lightRead,this.lightFill])o.bindTexture(o.TEXTURE_3D,y),o.texImage3D(o.TEXTURE_3D,0,o.RGBA16F,h[0],h[1],h[2],0,o.RGBA,o.HALF_FLOAT,null);this.uploaded=s,this.tfKey="",this.held=void 0}const l=JSON.stringify([i.preset.domain,i.preset.stops,i.preset.window??null]),u=this.bounds?.level===s?this.bounds.data:void 0;if(this.tfKey!==l||this.occFor!==u){const y=no(i.preset,s);o.activeTexture(o.TEXTURE7),o.bindTexture(o.TEXTURE_2D,this.tf),o.texImage2D(o.TEXTURE_2D,0,o.RGBA16F,X,1,0,o.RGBA,o.FLOAT,y),o.activeTexture(o.TEXTURE5),o.bindTexture(o.TEXTURE_3D,this.occ),o.pixelStorei(o.UNPACK_ALIGNMENT,1);const S=s.size.map(E=>Math.ceil(E/Pe));u!==void 0?o.texImage3D(o.TEXTURE_3D,0,o.R8,S[0],S[1],S[2],0,o.RED,o.UNSIGNED_BYTE,ao(u,y)):o.texImage3D(o.TEXTURE_3D,0,o.R8,1,1,1,0,o.RED,o.UNSIGNED_BYTE,new Uint8Array([255])),o.pixelStorei(o.UNPACK_ALIGNMENT,4),this.tfKey=l,this.occFor=u}const d=co(i.view,i.preset,s),f=i.view.light,v=JSON.stringify([l,d.density,d.albedo,d.phaseG,d.lightRgb,d.envTop,d.envHorizon,d.envBottom,d.envScale,d.clips,d.cropLo,d.cropHi,f?.direction??null,f?.camera_space??!0]);this.held?.key!==v&&(this.held={key:v,lightDir:d.lightDir,envUp:d.envUp,pass:0,layer:0}),d.lightDir=this.held.lightDir,d.envUp=this.held.envUp,this.canBake&&this.held.pass<Te&&this.bakeSome(o,d,r,h);const w=this.program,m=y=>o.getUniformLocation(w,y);o.useProgram(w),this.common(o,w,d,r);const T=o.getParameter(o.VIEWPORT);return o.uniform4f(m("uViewport"),T[0],T[1],T[2],T[3]),o.uniformMatrix4fv(m("uInvVP"),!1,e.invViewProjection),o.uniformMatrix4fv(m("uVP"),!1,e.viewProjection),o.uniform1f(m("uStep"),e.moving?1:.5),o.uniform1f(m("uShadeMix"),d.shadeMix),o.uniform1f(m("uGradScale"),d.gradScale),o.uniform1f(m("uRoughness"),d.roughness),o.uniform1f(m("uSpecular"),d.specular),o.uniform1f(m("uExposure"),d.exposure),o.uniform1f(m("uSplit"),t),o.activeTexture(o.TEXTURE5),o.bindTexture(o.TEXTURE_3D,this.occ),o.uniform1i(m("uOcc"),5),o.uniform1i(m("uHasOcc"),u!==void 0?1:0),o.activeTexture(o.TEXTURE4),o.bindTexture(o.TEXTURE_3D,this.lightRead),o.uniform1i(m("uLight"),4),o.uniform1i(m("uHasLight"),this.canBake&&this.held.pass>=2?1:0),o.bindVertexArray(this.vao),o.drawArrays(o.TRIANGLES,0,3),o.bindVertexArray(null),o.activeTexture(o.TEXTURE0),this.canBake&&this.held.pass<Te&&requestAnimationFrame(()=>this.onRedraw?.()),!0}common(e,t,s,i){const o=n=>e.getUniformLocation(t,n);e.uniformMatrix4fv(o("uVoxFromWorld"),!1,s.voxFromWorld),e.uniform3fv(o("uDims"),s.dims),e.uniform3fv(o("uCropLo"),s.cropLo),e.uniform3fv(o("uCropHi"),s.cropHi),e.uniform4fv(o("uClips"),s.clips),e.uniform1i(o("uNClip"),s.nclip),e.uniform1f(o("uDensity"),s.density),e.uniform1f(o("uPhaseG"),s.phaseG),e.uniform1f(o("uAlbedo"),s.albedo),e.uniform3fv(o("uLightDir"),s.lightDir),e.uniform3fv(o("uLightRgb"),s.lightRgb),e.uniform3fv(o("uEnvTop"),s.envTop),e.uniform3fv(o("uEnvHorizon"),s.envHorizon),e.uniform3fv(o("uEnvBottom"),s.envBottom),e.uniform3fv(o("uEnvUp"),s.envUp),e.uniform1f(o("uEnvScale"),s.envScale),e.uniform1f(o("uCell"),i),e.activeTexture(e.TEXTURE6),e.bindTexture(e.TEXTURE_3D,this.vol),e.uniform1i(o("uVol"),6),e.activeTexture(e.TEXTURE7),e.bindTexture(e.TEXTURE_2D,this.tf),e.uniform1i(o("uTf"),7)}bakeSome(e,t,s,i){const o=this.held;if(this.bake===void 0)try{this.bake=Ss(e,Es,ho)}catch(v){this.canBake=!1,this.base+=` (the light could not be held: ${v.message})`;return}const n=e.getParameter(e.DRAW_FRAMEBUFFER_BINDING),r=e.getParameter(e.VIEWPORT),h=e.getParameter(e.COLOR_WRITEMASK),l=[e.DEPTH_TEST,e.BLEND,e.SCISSOR_TEST,e.CULL_FACE,e.STENCIL_TEST].filter(v=>e.isEnabled(v));for(const v of l)e.disable(v);e.colorMask(!0,!0,!0,!0),e.bindFramebuffer(e.DRAW_FRAMEBUFFER,this.fb),e.viewport(0,0,i[0],i[1]);const u=this.bake,d=v=>e.getUniformLocation(u,v);e.useProgram(u),this.common(e,u,t,s),e.uniformMatrix4fv(d("uWorldFromVox"),!1,t.worldFromVox);const f=()=>{e.uniform1i(d("uPass"),o.pass),e.uniform1ui(d("uSeed"),o.pass*7919+17),e.activeTexture(e.TEXTURE4),e.bindTexture(e.TEXTURE_3D,this.lightRead),e.uniform1i(d("uPrev"),4)};f(),e.bindVertexArray(this.vao);for(let v=0;v<io&&o.pass<Te;++v)e.framebufferTextureLayer(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,this.lightFill,0,o.layer),e.uniform1i(d("uLayer"),o.layer),e.drawArrays(e.TRIANGLES,0,3),!(++o.layer<i[2])&&(o.layer=0,o.pass++,[this.lightRead,this.lightFill]=[this.lightFill,this.lightRead],f(),this.onChange?.());e.bindVertexArray(null),e.bindFramebuffer(e.DRAW_FRAMEBUFFER,n),e.viewport(r[0],r[1],r[2],r[3]),e.colorMask(h[0],h[1],h[2],h[3]);for(const v of l)e.enable(v)}fail(e){return this.failed=!0,this.base=`Object: ${e}`,this.onChange?.(),!1}reset(e){this.gl=e,this.program=void 0,this.programFor="",this.bake=void 0,this.uploaded=void 0,this.tfKey="",this.held=void 0,this.vao=e.createVertexArray();const t=s=>{const i=e.createTexture();return e.bindTexture(s,i),e.texParameteri(s,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(s,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(s,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(s,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texParameteri(s,e.TEXTURE_WRAP_R,e.CLAMP_TO_EDGE),i};this.vol=t(e.TEXTURE_3D),this.tf=t(e.TEXTURE_2D),this.occ=t(e.TEXTURE_3D),this.occFor=void 0,this.canBake=e.getExtension("EXT_color_buffer_float")!==null,this.lightRead=t(e.TEXTURE_3D),this.lightFill=t(e.TEXTURE_3D),this.fb=e.createFramebuffer()}close(){this.url="",this.base="",this.level=void 0,this.bounds=void 0,this.held=void 0,this.failed=!1,this.client?.dispose(),this.client=void 0;const e=this.gl;if(e!==void 0){for(const t of[this.program,this.bake])t&&e.deleteProgram(t);for(const t of[this.vol,this.tf,this.occ,this.lightRead,this.lightFill])t&&e.deleteTexture(t);this.vao&&e.deleteVertexArray(this.vao),this.fb&&e.deleteFramebuffer(this.fb)}this.gl=void 0,this.program=void 0,this.bake=void 0,this.uploaded=void 0}}function Ss(a,e,t){const s=(n,r)=>{const h=a.createShader(n);if(a.shaderSource(h,r),a.compileShader(h),!a.getShaderParameter(h,a.COMPILE_STATUS))throw new Error(a.getShaderInfoLog(h)??"shader");return h},i=a.createProgram(),o=[s(a.VERTEX_SHADER,e),s(a.FRAGMENT_SHADER,t)];for(const n of o)a.attachShader(i,n);a.linkProgram(i);for(const n of o)a.deleteShader(n);if(!a.getProgramParameter(i,a.LINK_STATUS)){const n=a.getProgramInfoLog(i);throw a.deleteProgram(i),new Error(n??"link")}return i}function po(a,e,t){const s=e+t;if(e<0||s<0||e>=a.length||s>=a.length)return a.slice();const i=a.slice();return[i[e],i[s]]=[{...a[s],time:a[e].time},{...a[e],time:a[s].time}],i}const fo=.9,Ps=[{axis:"x",keep:-1,offset:0,on:!1},{axis:"y",keep:-1,offset:0,on:!1},{axis:"z",keep:-1,offset:0,on:!1}];function _s(a){const e=a??{},t=(i,o)=>typeof i=="number"&&Number.isFinite(i)?i:o,s=Array.isArray(e.cuts)&&e.cuts.length===3?e.cuts.map((i,o)=>({...Ps[o],...i})):Ps.map(i=>({...i}));return{on:e.on===!0,where:e.where==="browser"?"browser":"host",layer:typeof e.layer=="string"?e.layer:void 0,labels:typeof e.labels=="string"?e.labels:void 0,preset:typeof e.preset=="string"?e.preset:"",density:typeof e.density=="number"?e.density:void 0,exposure:t(e.exposure,1),windows:Object.fromEntries(Object.entries(e.windows&&typeof e.windows=="object"?e.windows:{}).filter(i=>Array.isArray(i[1])&&i[1].length===2&&i[1].every(o=>typeof o=="number"&&Number.isFinite(o))&&i[1][1]>i[1][0])),volumeAt:Object.fromEntries(Object.entries(e.volumeAt&&typeof e.volumeAt=="object"?e.volumeAt:{}).filter(i=>!!i[1]&&typeof i[1]=="object").map(([i,o])=>[i,{channel:Math.max(0,Math.round(t(o.channel,0))),time:Math.max(0,Math.round(t(o.time,0)))}])),tunings:Object.fromEntries(Object.entries(e.tunings&&typeof e.tunings=="object"?e.tunings:{}).filter(i=>!!i[1]&&typeof i[1]=="object").map(([i,o])=>[i,{shift:t(o.shift,0),scale:t(o.scale,1),stops:Array.isArray(o.stops)?o.stops.filter(n=>n&&typeof n.value=="number"):void 0,warp:Array.isArray(o.warp)?o.warp.filter(n=>n&&Number.isFinite(n.from)&&Number.isFinite(n.to)):void 0}])),lightAzimuth:t(e.lightAzimuth,30),lightElevation:t(e.lightElevation,40),lightMap:typeof e.lightMap=="string"?e.lightMap:"",lightMapRotation:t(e.lightMapRotation,0),lightStyle:typeof e.lightStyle=="string"?e.lightStyle:"",envScale:t(e.envScale,1),lightKey:t(e.lightKey,1),viewCut:{on:e.viewCut?.on===!0,offset:t(e.viewCut?.offset,0),fixed:Array.isArray(e.viewCut?.fixed)&&e.viewCut.fixed.length===4?e.viewCut.fixed:null},cuts:s,regions:e.regions===!0,labelMix:t(e.labelMix,.85),keep:Array.isArray(e.keep)?e.keep.filter(i=>typeof i=="number"):[],hidden:Array.isArray(e.hidden)?e.hidden.filter(i=>typeof i=="number"):[],budget:t(e.budget,4e8),detail:e.detail!==!1,detailBudget:t(e.detailBudget,2e8),jar:e.jar===!0,maxSamples:t(e.maxSamples,512),denoise:e.denoise!==!1,restPicture:e.restPicture===!0,keyframes:Array.isArray(e.keyframes)?e.keyframes.filter(i=>i&&typeof i.time=="number"&&i.view&&typeof i.view=="object"):[],boxes:Array.isArray(e.boxes)?e.boxes.filter(i=>i&&Array.isArray(i.lo)&&Array.isArray(i.hi)).map((i,o)=>({name:String(i.name??`Crop ${o+1}`),on:i.on!==!1,keep:i.keep!==!1,lo:i.lo,hi:i.hi})):e.box?.on?[{name:"Crop 1",on:!0,keep:!0,lo:e.box.lo??[0,0,0],hi:e.box.hi??[1,1,1]}]:[],customPresets:Array.isArray(e.customPresets)?e.customPresets.filter(i=>i&&typeof i.name=="string"):[],rotation:{axis:"vertical",degrees:360,step:2,...e.rotation??{}},movie:{fps:25,width:1280,height:720,samples:128,easing:"smooth",...e.movie??{}},splat:{views:256,size:1024,samples:512,cover:180,steps:3e4,...e.splat??{}}}}const Ce={command:"settings.open",args:{section:"compute"}};function As(a){return a.split(/[\s,]+/).filter(Boolean).map(Number).filter(e=>Number.isInteger(e))}function Rs(a,e,t){const s=b("input",{class:"text-input",type:"text",value:a.join(", "),placeholder:"label ids","aria-label":t});return s.onchange=()=>e(As(s.value)),s.set=i=>{s.ownerDocument.activeElement!==s&&As(s.value).join()!==i.join()&&(s.value=i.join(", "))},s}function ue(a,e){const t=Q([],"",a,e);let s="";return t.update=(i,o)=>{const n=JSON.stringify(i);n!==s&&(s=n,t.replaceChildren(...i.map(([r,h])=>b("option",{value:r},h))),t.value=o),t.set(o)},t}function De(a,e,t,s){const i=Fs(e(a),o=>{const n=e(o);i.value=String(n),t(n)},s);return i}const vo=`
.ar-grow { flex: 1 1 140px; min-width: 0; }
.ar-cut { display: grid; grid-template-columns: 5.5em auto minmax(0, 1fr); align-items: center; gap: var(--sp-3); }
.ar-cut > select { width: auto; }
.ar-editor { display: block; width: 100%; cursor: crosshair; border: 1px solid var(--line-strong); }
.ar-box { display: grid; gap: var(--sp-3); padding-left: var(--sp-4); border-left: 2px solid var(--line-strong); }
.ar-box-axes { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: var(--sp-2) var(--sp-3); }
.ar-box-axes > span { color: var(--muted); font-size: var(--fs-caption); }
.ar-preview { display: grid; gap: var(--sp-3); place-items: center; min-height: 200px; }
.ar-preview > progress { width: 100%; }
.ar-video { width: 100%; max-height: 60vh; background: var(--ink-0); }
.ar-splat { height: min(64vh, 640px); background: var(--ink-0); }
.ar-splat-canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
.ar-splat-canvas.grabbing { cursor: grabbing; }
.ar-job { display: flex; align-items: center; gap: var(--sp-3); }
.ar-job > .readout { flex: 1; min-width: 0; }
`;function ks(a,e){return new Promise(t=>{const s=setTimeout(t,a);e?.addEventListener("abort",()=>(clearTimeout(s),t()),{once:!0})})}const mo=200,Ms=120;function Ls(a){const e=a[11],t=Is(a);return{eye:Math.abs(e)<1e-12?void 0:[a[8]/e,a[9]/e,a[10]/e],forward:t}}function go(a,e){const t=Ls(a),s=Ls(e.invViewProjection);if(t.forward[0]*s.forward[0]+t.forward[1]*s.forward[1]+t.forward[2]*s.forward[2]<Math.cos(20*Math.PI/180))return!0;const o=e.position;if(t.eye&&s.eye){const u=Math.hypot(t.eye[0]-o[0],t.eye[1]-o[1],t.eye[2]-o[2]),d=Math.hypot(s.eye[0]-o[0],s.eye[1]-o[1],s.eye[2]-o[2]);if(d<u/2||d>u*2)return!0}const n=Ns(a),r=n[0]*o[0]+n[4]*o[1]+n[8]*o[2]+n[12],h=n[1]*o[0]+n[5]*o[1]+n[9]*o[2]+n[13],l=n[3]*o[0]+n[7]*o[1]+n[11]*o[2]+n[15];return!(l>0)||Math.abs(r/l)>.8||Math.abs(h/l)>.8}const Us="host",qe="jobs",wo=15e3,Cs="Movies need ffmpeg on the render computer.",Ds="No paired computer has the render service: pair one (Settings › Compute), or render in this browser.";class yo{constructor(e){this.ctx=e,this.saved=_s(e.state.get()),this.host={name:e.settings.get(Us)?.name||void 0},this.jobs=Ei(e.settings.get(qe)),this.drawer.onFrame=t=>this.onFrame(t),this.drawer.onFading=()=>this.handle?.redraw(),this.drawer.live=this.live,this.live.look=t=>this.liveLook(t),this.live.onChange=()=>{this.handle?.redraw(),this.statusUpdate?.()},this.live.onRedraw=()=>this.handle?.redraw(),this.toggle=e.ui.viewToggle({label:"Render",title:"Path-traced rendering (Anatomical rendering)",value:this.saved.on,onChange:t=>this.setOn(t)}),this.offs.push(e.viewer.onLayersChanged(()=>this.update()),e.viewer.onCursorChanged(()=>{const t=e.viewer.cursor();t.active&&t.position.length>=3&&t.position.slice(0,3).every(Number.isFinite)&&(this.lastCursor=t.position.slice(0,3))}),e.state.onChanged(()=>{this.saved=_s(e.state.get()),this.update()}),e.commands.register("anatomicalRendering.toggle",()=>this.setOn(!this.saved.on)),e.ui.panel(ei,t=>this.panel(t)),this.listen("pagehide",()=>this.closeSession(!0)),this.listen("pageshow",t=>t.persisted&&this.update()),e.hosts.onChanged(()=>{const t=this.link()?.label;this.connecting===void 0&&t!==void 0&&(this.serviceInfo===void 0||t!==this.service?.link.label)&&this.connect(),this.panelUpdate?.()}),()=>clearTimeout(this.settle),()=>this.live.close()),this.connect();try{localStorage.getItem("ngplatform.debug")&&(window.anatomicalRendering=this)}catch{}}saved;host;drawer=new bi;handle;handleLayer;service;serviceInfo;presets=[];session;opened;reopened=0;stillRunning=!1;jobs;following=new Set;sides=new Map;sessionKey="";counts=new Map;abort;lastKey="";lastScale=1;lastFrame;lastSpec;sending=!1;viewRefused=!1;pendingView;queued;lastLook="";lastCamera="";cameraChanged=0;turning=!1;settle;depth;distance;views=new Map;live=new uo;fixedLight;lastCursor;cursorOffsets(){const e=this.lastFrame,t=this.lastCursor;if(!e||!t)return;const s=hs(e.dimensions),i=[0,1,2].map(n=>t[n]-e.position[n]),o=Is(e.invViewProjection);return{axis:i.map(n=>Math.round(n*s*10)/10),view:Math.round((o[0]*i[0]+o[1]*i[1]+o[2]*i[2])*s*10)/10}}frameText="";problem="";local;localKey="";localText="";toggle;panelUpdate;statusUpdate;offs=[];listen(e,t){return window.addEventListener(e,t),()=>window.removeEventListener(e,t)}save(e){e(this.saved),this.ctx.state.set({...this.saved}),this.handle?.redraw()}setOn(e){const t=this.target(),s=t===void 0?"Anatomical rendering needs an OME-Zarr or N5 image in the scene.":this.axesOf(t).problem;if(e&&s!==void 0){this.toggle.set(!1),this.panelUpdate?.(),this.ctx.ui.toast(s,"error");return}this.save(i=>i.on=e),this.toggle.set(e),e&&this.ensure3d(),this.update()}ensure3d(){const e=JSON.stringify(this.ctx.viewer.getState().layout??"");/3d|4panel/.test(e)||this.ctx.viewer.patchState(t=>void(t.layout="xy-3d"))}images(){return this.ctx.viewer.layers().filter(e=>e.type==="image"&&V(e.sources[0])!==void 0)}segmentations(){return this.ctx.viewer.layers().filter(e=>e.type==="segmentation"&&V(e.sources[0])!==void 0)}target(){const e=this.images();return e.find(t=>t.name===this.saved.layer)??e[0]}axesOf(e){return ds(this.ctx.viewer.layerTransform?.(e.name)?.input,this.saved.where==="browser")}volumeCounts(e){if(this.saved.where==="browser")return;const t=this.axesOf(e),s=V(e.sources[0]),o=(s===void 0?void 0:this.counts.get(s))??{channels:t.channels??1,times:t.times??1};return o.channels>1||o.times>1?o:void 0}volumeAt(e){const t=V(e.sources[0]),s=t===void 0?void 0:this.saved.volumeAt[t],i=this.volumeCounts(e);return s===void 0||i===void 0?{channel:0,time:0}:{channel:Math.min(s.channel,i.channels-1),time:Math.min(s.time,i.times-1)}}setVolumeAt(e,t){const s=V(e.sources[0]);if(s===void 0)return;const i={...this.volumeAt(e),...t};this.save(o=>o.volumeAt[s]=i),this.update()}viewButtons(){const e=this.target(),t=e?V(e.sources[0]):void 0;return t!==void 0&&!this.sides.has(t)&&this.readSides(t),ti(this.lastFrame?.dimensions.names??["x","y","z"],t===void 0?void 0:this.sides.get(t)??void 0)}async readSides(e){this.sides.set(e,null);const t=si(e);if(!(t===void 0||typeof fetch!="function"))for(const[s,i]of[["zarr.json",o=>o.attributes],[".zattrs",o=>o]])try{const o=await fetch(`${t}/${s}`,{signal:AbortSignal.timeout(8e3)});if(!o.ok)continue;const n=ii(i(await o.json()));if(n===void 0)return;this.sides.set(e,n),this.panelUpdate?.();return}catch{}}lookFrom(e){this.ctx.viewer.patchState(t=>void(t.projectionOrientation=oi(e.forward,e.up)))}renderHosts(){return this.ctx.hosts.list().filter(e=>e.info?.services?.render!==void 0)}link(){const e=(this.host.name?this.ctx.hosts.get(this.host.name):void 0)??this.ctx.hosts.pick({service:"render"});return e===void 0?void 0:ci(e.name,e.address,(t,s)=>e.fetch(t,s))}connects=0;connecting;connectProblem="";async connect(){const e=++this.connects;this.connecting=e,this.closeSession();const t=this.link(),s=t===void 0?void 0:new ui(t);this.service=s,this.serviceInfo=void 0,this.problem="",this.connectProblem="",this.statusUpdate?.();let i,o,n="";try{if(s===void 0)throw new Error(Ds);i=await s.info(AbortSignal.timeout(8e3)),o=await s.presets()}catch(r){n=s===void 0?Ds:`No render service on ${s.link.label}: ${r.message}`}e!==this.connects||this.disposed||(this.connecting=void 0,this.serviceInfo=i,this.connectProblem=n,o!==void 0&&(this.presets=o,!this.saved.preset&&o.length>0&&(this.saved.preset=o[0].name)),this.sessionKey="",this.update(),this.panelUpdate?.(),s!==void 0&&i!==void 0&&this.resumeJobs(s))}async refreshInfo(e=this.service){if(!(e===void 0||e!==this.service||this.serviceInfo===void 0))try{const t=await e.info(AbortSignal.timeout(8e3));if(e!==this.service||this.serviceInfo===void 0||this.disposed)return;this.serviceInfo=t,this.panelUpdate?.()}catch{}}update(){const e=this.target(),t=this.saved.where==="browser",s=e!==void 0&&this.axesOf(e).problem===void 0?e:void 0;if(!this.saved.on||s===void 0||!t&&this.serviceInfo===void 0){this.handle?.dispose(),this.handle=void 0,this.handleLayer=void 0,this.drawer.set(void 0),(!this.saved.on||s===void 0)&&(this.closeSession(),this.closeLocal(),this.live.close()),this.panelUpdate?.();return}this.handleLayer!==s.name&&(this.handle?.dispose(),this.handleLayer=s.name,this.handle=this.ctx.viewer.draw3d(s.name,{draw:i=>this.drawer.draw(i),isReady:()=>this.drawer.isReady(),dispose:()=>{}})),t?(this.closeSession(),this.ensureLocal(s)):(this.closeLocal(),this.ensureSession(s),ds(this.ctx.viewer.layerTransform?.(s.name)?.input,!0).problem===void 0?this.live.open(V(s.sources[0])):this.live.close()),this.handle?.redraw(),this.panelUpdate?.()}presetDomain(){const e=this.saved,s=e.customPresets.find(i=>i.name===e.preset)?.domain??(e.where==="browser"?ve.find(i=>i.name===e.preset)?.domain:this.presets.find(i=>i.name===e.preset)?.domain);return typeof s=="string"?s:void 0}references(){if(this.saved.where==="browser")return[];const e=this.presets.find(s=>s.name===this.saved.preset);return(Array.isArray(e?.reference)?e.reference:[]).map(s=>({title:(s.title??"a photograph").replace(/^File:/,""),page:ni(s.page),author:s.author??"unknown",licence:s.licence??""}))}resolved;editor;presetRequest(){const e=this.saved,t=this.target()?V(this.target().sources[0]):void 0;if(this.session?.status!=="ready"||t===void 0)return;const s=e.customPresets.find(o=>o.name===e.preset)??(e.preset||"HiP-CT brain"),i=e.windows[t]&&this.presetDomain()==="window"?{window:e.windows[t]}:{};return{key:JSON.stringify([this.session.id,s,i]),preset:s,overrides:i}}async resolvePreset(){const e=this.presetRequest();if(!(e===void 0||this.resolved?.key===e.key||!this.service))try{const t=await this.service.resolve(this.session.id,e.preset,e.overrides);this.resolved={key:e.key,preset:t},this.panelUpdate?.(),this.lastKey="",this.handle?.redraw()}catch{}}currentTuning(){const e=this.target()?V(this.target().sources[0]):void 0;if(e!==void 0)return{src:e,tuning:this.saved.tunings[e]??{shift:0,scale:1}}}editedStops(){const e=this.presetRequest();if(!this.resolved||e===void 0||this.resolved.key!==e.key)return;const t=this.resolved.preset.stops??[],s=this.currentTuning()?.tuning,i=s?.stops??t,o=t.filter(l=>l.opacity>.01),n=o.length?(o[0].value+o[o.length-1].value)/2:0,r=Bi(i,s?.shift??0,s?.scale??1,n);let h=s?.warp;if(!h){const l=this.session?.volume?.histogram;h=l&&o.length?Oi(l,o[0].value,o[o.length-1].value).map(u=>({from:u,to:u})):[]}return{stops:r,base:i,centre:n,warp:h,data:r.map(l=>({...l,value:zi(l.value,h)}))}}tunedPreset(){const e=this.currentTuning()?.tuning;if(!e||!e.stops&&e.shift===0&&e.scale===1&&!(e.warp??[]).some(h=>h.to!==h.from))return;const t=this.editedStops();if(!t||!this.resolved)return;const{reference:s,measured:i,histogram:o,design_scan:n,...r}=this.resolved.preset;return{...r,stops:t.data,domain:"data",window:null,histogram:null}}editorUpdate;colourmapEditor(){return this.editor??=new Gi(e=>{const t=this.currentTuning();if(!t)return;const s=this.editedStops(),i=t.tuning.scale||1,o=e.map(n=>({...n,value:(s?s.centre:0)+(n.value-t.tuning.shift-(s?s.centre:0))/i}));this.save(n=>n.tunings[t.src]={...t.tuning,stops:o})},e=>{const t=this.currentTuning();t&&this.save(s=>s.tunings[t.src]={...t.tuning,warp:e})}),this.editor}mapWidth(){const e=this.editedStops()?.base.filter(t=>t.opacity>.01)??[];return e.length&&e[e.length-1].value-e[0].value||1}tune(e,t=!1){const s=this.currentTuning();if(!s)return;const i=o=>{const n={...o.tunings[s.src]??{shift:0,scale:1}};e(n),o.tunings[s.src]=n};t?this.preview(i):this.save(i),this.editorUpdate?.()}preview(e){e(this.saved),this.handle?.redraw()}windowRange(){if(this.presetDomain()!=="window"||this.saved.where==="browser")return;const e=this.target(),t=e?V(e.sources[0]):void 0;if(t===void 0)return;const s=this.session?.volume,i=s?.lo!==void 0&&s.hi!==void 0&&s.hi>s.lo;return{src:t,lo:i?s.lo:0,hi:i?s.hi:65535,step:i?Ri(s.lo,s.hi,s.dtype):1,guess:s?.window??void 0}}setWindow(e,t,s,i){this.save(o=>{const n=o.windows[e]??i??[s,s+1],r=[n[0],n[1]];r[t]=s,r[1]>r[0]&&(o.windows[e]=r)})}labelsSource(){if(!this.saved.regions)return;const e=this.segmentations(),t=e.find(s=>s.name===this.saved.labels)??e[0];return t?V(t.sources[0]):void 0}async ensureSession(e){const t=this.service,s=V(e.sources[0]),i=this.labelsSource(),o=this.saved.detail?this.saved.detailBudget:0,n=this.volumeAt(e),r=JSON.stringify([t.link.base,s,i,this.saved.budget,this.saved.jar,o,n.channel,n.time]);if(r===this.sessionKey)return;this.closeSession(),this.sessionKey=r;const h=new AbortController;this.abort=h;try{let l=await t.open({url:s,budget:this.saved.budget,detail_budget:o,...this.saved.jar?{cylinder:fo}:{},...n.channel?{channel:n.channel}:{},...n.time?{time:n.time}:{}},i?{url:i}:void 0);if(h.signal.aborted){t.close(l.id).catch(()=>{});return}for(this.opened={service:t,id:l.id},this.session=l;l.status==="loading"&&!h.signal.aborted&&(this.statusUpdate?.(),await new Promise(d=>setTimeout(d,400)),l=await t.session(l.id),!h.signal.aborted);)this.session=l;const u=l.volume;if(l.status==="ready"&&u.channels!==void 0&&u.times!==void 0&&!h.signal.aborted){this.counts.set(s,{channels:u.channels,times:u.times});const d=this.volumeAt(e);if(d.channel!==n.channel||d.time!==n.time)return this.update()}if(this.panelUpdate?.(),l.status!=="ready"||h.signal.aborted)return;this.refreshInfo(t),await this.resolvePreset(),this.lastKey="",this.handle?.redraw(),this.frameLoop(t,l.id,h.signal)}catch(l){if(h.signal.aborted)return;this.problem=l.message,this.statusUpdate?.()}}async ensureLocal(e){const t=V(e.sources[0]),s=JSON.stringify([t,this.saved.budget]);if(s===this.localKey)return;this.closeLocal(),this.localKey=s;const i=new Qi;this.local=i,i.onFrame=o=>{this.local===i&&(this.drawer.set({bitmap:o.bitmap,depth:o.depth,camera:o.camera,look:o.tag}),this.frameText=`${o.samples} samples, ${o.width}×${o.height}, ${o.msPerPass.toFixed(0)} ms a pass (this browser)`,this.handle?.redraw(),this.statusUpdate?.())};try{this.localText="Loading in this browser…",this.statusUpdate?.(),this.localText=await i.load(t,Math.min(this.saved.budget,64e6),o=>{this.localText=o,this.statusUpdate?.()}),i.level!==void 0&&this.live.setLevel(i.level,t),this.lastKey="",this.handle?.redraw()}catch(o){this.localText="",this.problem=`This browser cannot render it: ${o.message}`,this.live.open(t)}this.statusUpdate?.()}closeLocal(){this.local?.dispose(),this.local=void 0,this.localKey="",this.localText=""}closeSession(e=!1){this.abort?.abort(),this.abort=void 0;const t=this.opened;t&&t.service.close(t.id,e).catch(()=>{}),this.opened=void 0,this.session=void 0,this.sessionKey="",this.views.clear(),this.distance=void 0,this.depth=void 0,this.queued=void 0,this.viewRefused=!1,this.lastKey="",this.lastLook="",this.lastScale=1,this.frameText="",clearTimeout(this.settle),this.drawer.set(void 0)}retryJob(){const e=this.refused;this.refused=void 0,this.statusUpdate?.(),e?.retry()}retry(){this.problem="",this.reopened=0,this.viewRefused&&this.session?.status==="ready"?(this.viewRefused=!1,this.lastKey="",this.lastLook="",this.handle?.redraw()):this.saved.where==="browser"?(this.closeLocal(),this.update()):this.serviceInfo===void 0?this.connect():(this.closeSession(),this.update()),this.statusUpdate?.()}sessionLost(){if(this.reopened>=1){this.problem="The render computer closed the session.",this.statusUpdate?.();return}this.reopened+=1,this.opened=void 0,this.closeSession(),this.update()}async sessionFailed(e,t,s){const i=await e.session(t).catch(()=>{});this.opened?.id===t&&(i?.status==="failed"?this.session=i:this.problem=s,this.drawer.set(void 0),this.handle?.redraw(),this.statusUpdate?.())}async frameLoop(e,t,s){let i=0,o=0;for(;!s.aborted;)try{const n=await e.frame(t,i,s,this.distance?.version??-1);if(o>0&&(o=0,this.problem="",this.statusUpdate?.()),n===void 0)continue;this.reopened=0,this.problem="",i=n.number,n.distance!==void 0&&(this.distance=n.distance);let r=this.views.get(n.version);r===void 0&&this.pendingView!==void 0&&(await this.pendingView,r=this.views.get(n.version));const h=r?.camera;if(h!==void 0&&this.distance?.version!==n.version){const u=await e.distance(t).catch(()=>{});u!==void 0&&(this.distance=u)}const l=h&&this.distance&&this.distance.version===n.version?{invViewProjection:h,distance:this.distance}:void 0;if(l===void 0){if(this.drawer.placed()!==void 0){n.bitmap.close?.();continue}if(this.depth===void 0||this.depth.version!==n.version){const u=await e.depth(t);u!==void 0&&(this.depth=u)}}this.drawer.set({bitmap:n.bitmap,alpha:n.alpha?{width:n.width,height:n.height,data:n.alpha}:void 0,depth:l?void 0:this.depth,view:l,camera:h,look:r?.look}),this.frameText=`${n.samples} samples, ${n.width}×${n.height}, ${n.msPerPass.toFixed(0)} ms a pass${n.detail?`
Detail: ${n.detail}`:""}`,this.handle?.redraw(),this.statusUpdate?.()}catch(n){if(s.aborted)return;const r=n instanceof Y?n.status:0;if(r===404)return this.sessionLost();if(r===410)return void this.sessionFailed(e,t,n.message);const h=ki(++o);if(this.problem=h===void 0?`Lost touch with ${e.link.label??"the render computer"}: ${n.message}`:`${n.message} (trying again in ${Math.round(h/1e3)} s)`,this.statusUpdate?.(),h===void 0)return;await ks(h,s)}}viewSpec(e,t){const s=us(e.dimensions);if(s===void 0){this.problem=`The 3-D view shows ${e.dimensions.names.join(", ")}; rendering needs x, y and z.`;return}const i=this.saved,o={exposure:i.exposure};i.density!==void 0&&(o.density=i.density);const n=this.target()?V(this.target().sources[0]):void 0;n!==void 0&&i.windows[n]&&this.presetDomain()==="window"&&(o.window=i.windows[n]);const r=this.tunedPreset();return{inv_view_projection:Array.from(e.invViewProjection),width:e.width,height:e.height,scale:t,world_from_physical:s,orbit_center:Array.from(e.position),unit_mm:hs(e.dimensions),preset:r??i.customPresets.find(h=>h.name===i.preset)??(i.preset||"HiP-CT brain"),overrides:r?{exposure:i.exposure,...i.density!==void 0?{density:i.density}:{}}:o,boxes:i.boxes.filter(h=>h.on).map(h=>({lo:h.lo,hi:h.hi,keep:h.keep})),light:this.live.ready()?{direction:this.objectLight(e),camera_space:!1,rgb:[3.2*i.lightKey,3*i.lightKey,2.8*i.lightKey]}:{direction:fs(i.lightAzimuth,i.lightElevation),camera_space:!0,rgb:[3.2*i.lightKey,3*i.lightKey,2.8*i.lightKey]},environment:i.lightMap?{map:i.lightMap,rotation:i.lightMapRotation,scale:i.envScale}:{scale:i.envScale},clips:[...ai(i.cuts,e.position,e.dimensions),...i.viewCut.on?[i.viewCut.fixed??ps(e.invViewProjection,e.position,i.viewCut.offset,e.dimensions)]:[]],labels:i.regions?{show:!0,mix:i.labelMix,keep:i.keep,hidden:i.hidden}:{show:!1},background:[0,0,0,0],max_samples:i.maxSamples,denoise:i.denoise,frame_format:"jpeg"}}onFrame(e){this.lastFrame=e;const t=JSON.stringify([this.saved.boxes,this.saved.customPresets.length,this.saved.preset,this.saved.density,this.saved.exposure,this.saved.windows,this.saved.tunings,this.resolved?.key,this.saved.lightAzimuth,this.saved.lightElevation,this.saved.lightMap,this.saved.lightMapRotation,this.saved.lightStyle,this.saved.envScale,this.saved.lightKey,this.saved.viewCut,this.saved.cuts,this.saved.regions,this.saved.labelMix,this.saved.keep,this.saved.hidden,this.saved.maxSamples,this.saved.denoise,e.position]);this.drawer.look=t,this.drawer.pictureAtRest=this.saved.restPicture;const s=this.saved.where==="browser"?this.local:void 0,i=s?"local":this.session?.status==="ready"?this.session.id:void 0;if(i===void 0||s&&!s.ready)return;if(this.live.ready()&&!this.saved.restPicture){const v=this.viewSpec(e,1);v!==void 0&&(this.lastSpec=v);return}const o=ri(e.invViewProjection,e.width,e.height),n=performance.now();o!==this.lastCamera&&(this.turning=n-this.cameraChanged<Ms,this.lastCamera=o,this.cameraChanged=n);const r=e.moving||this.turning&&n-this.cameraChanged<Ms,h=o+t,l=r?.5:1;if(h===this.lastKey&&!(this.lastScale<1&&!r))return;const u=t===this.lastLook;this.lastKey=h,this.lastLook=t,this.lastScale=l,clearTimeout(this.settle),l<1&&(this.settle=setTimeout(()=>{const v=this.lastFrame;if(v===void 0||this.lastScale===1)return;const w=this.viewSpec(v,1);w!==void 0&&(this.lastScale=1,this.lastSpec=w,this.send(i,w,this.lastLook))},mo));const d=this.drawer.placed();if(r&&(this.live.ready()||u&&d!==void 0&&!go(d,e)))return;const f=this.viewSpec(e,l);f!==void 0&&(l===1&&(this.lastSpec=f),this.send(i,f,t))}objectLight(e){const t=this.saved,s=JSON.stringify([t.lightAzimuth,t.lightElevation]);if(this.fixedLight?.key!==s){const[i,o,n]=it(Ae(e.invViewProjection)),r=fs(t.lightAzimuth,t.lightElevation);this.fixedLight={key:s,direction:[0,1,2].map(h=>r[0]*i[h]+r[1]*o[h]+r[2]*n[h])}}return this.fixedLight.direction}liveLook(e){const t=this.viewSpec(e,1);if(t===void 0)return;const s=this.saved.where!=="browser",i=s?this.presetRequest():void 0,o=i!==void 0&&this.resolved?.key===i.key?this.resolved.preset:void 0,n=l=>(s?this.presets.find(u=>u.name===l):void 0)??ve.find(u=>u.name===l),h={...(typeof t.preset=="object"?t.preset:o??n(t.preset))??ve[0],...t.overrides??{}};return Array.isArray(h.stops)?{view:t,preset:h}:void 0}send(e,t,s){if(e==="local"){this.local?.setView(t,s);return}if(this.sending){this.queued={spec:t,look:s};return}this.sending=!0,this.pendingView=this.opened.service.setView(e,t).then(i=>{if(this.opened?.id===e){this.viewRefused&&(this.viewRefused=!1,this.problem="",this.statusUpdate?.()),this.views.set(i.version,{camera:t.inv_view_projection,look:s});for(const o of this.views.keys())o<i.version-64&&this.views.delete(o)}}).catch(i=>{this.opened?.id===e&&(this.viewRefused=Fe(i)!==void 0,this.problem=i.message,this.statusUpdate?.())}).finally(()=>{this.sending=!1,this.pendingView=void 0;const i=this.queued;this.queued=void 0;const o=this.session?.status==="ready"?this.session.id:void 0;i!==void 0&&o!==void 0&&this.send(o,i.spec,i.look)})}camera(){const e=this.ctx.viewer.getState();if(Array.isArray(e?.position))return{position:e.position.slice(),orientation:Array.isArray(e.projectionOrientation)?e.projectionOrientation.slice():[0,0,0,1],scale:typeof e.projectionScale=="number"?e.projectionScale:256}}addKeyframe(e){const t=this.lastSpec;if(t===void 0){this.ctx.ui.toast("Render a view first: switch Render on and look at the image in 3-D.","error");return}const s=this.camera(),i={view:{...t,scale:1},...s?{camera:s}:{}};if(e!==void 0)return this.save(n=>n.keyframes[e]={time:n.keyframes[e].time,...i});const o=this.saved.keyframes.at(-1)?.time??-2;this.save(n=>n.keyframes.push({time:o+2,...i}))}goToKeyframe(e){const t=this.saved.keyframes[e]?.camera;if(t===void 0){this.ctx.ui.toast("This keyframe was made before keyframes kept their camera: replace it to go back to it.","error");return}this.ctx.viewer.patchState(s=>{const i=s;i.position=t.position.slice(),i.projectionOrientation=t.orientation.slice(),i.projectionScale=t.scale})}currentSpec(){const e=this.lastFrame;return e?this.viewSpec(e,1):this.lastSpec}centreOnTissue(){const e=this.session?.volume?.tissue_mm,t=this.lastFrame;if(!e||t===void 0){this.ctx.ui.toast("Render first: the tissue's box comes with the rendered image.","error");return}const s=us(t.dimensions);if(s===void 0)return;const i=l=>[0,1,2].map(u=>s[u]*l[0]+s[4+u]*l[1]+s[8+u]*l[2]+s[12+u]),o=i(e[0]),n=i(e[1]),r=o.map((l,u)=>(l+n[u])/2),h=Math.max(...o.map((l,u)=>Math.abs(n[u]-l)));this.ctx.viewer.patchState(l=>{const u=l,d=Array.isArray(u.position)?u.position.slice():[0,0,0];for(let f=0;f<3;++f)d[f]=r[f];u.position=d,u.projectionScale=h*1.4})}async saveStill(){const e=this.session?.status==="ready"?this.session.id:void 0,t=this.opened?.service,s=this.currentSpec();if(e===void 0||t===void 0||s===void 0)return this.ctx.ui.toast("Render a view on a computer first.","error");if(this.stillRunning)return this.ctx.ui.toast("A still is already rendering.","error");const i=Xe(this.saved.movie),o=Math.min($.maxSamples,i.samples*2),n=Ai(i.width,i.height,o);if(n)return this.ctx.ui.toast(n,"error");this.stillRunning=!0,this.panelUpdate?.();const r=`Still ${i.width} × ${i.height}, ${o} samples`;try{await this.ctx.jobs.run(r,async h=>{const l=await t.still(e,{view:s,width:i.width,height:i.height,samples:o,name:"anatomical-rendering"}),u=await this.follow("still",t,l,r,h);if(u.status!=="done")throw new Error(u.error??u.status);ce(await t.stillFile(l.id),"anatomical-rendering.png")})}catch(h){this.jobFailed("Still",h,()=>void this.saveStill())}finally{this.stillRunning=!1,this.panelUpdate?.()}}refused;jobFailed(e,t,s){const i=Fe(t);i?.retry?(this.refused={text:`${e}: ${i.text}`,retry:s},this.statusUpdate?.()):this.ctx.ui.toast(`${e}: ${t.message}`,"error")}recordJob(e){this.jobs=Si(this.jobs,e),this.ctx.settings.set(qe,this.jobs),this.jobsUpdate?.()}jobsUpdate;async follow(e,t,s,i,o){const n=t.link.label??"",r=`${e}:${n}:${s.id}`,h=d=>({kind:e,id:s.id,host:n,name:i,status:d.status,progress:d.progress,message:d.message,...d.error?{error:d.error}:{},...d.files?{files:d.files}:{},...d.status==="queued"&&(d.jobs_ahead??d.ahead)!==void 0?{ahead:d.jobs_ahead??d.ahead}:{},started:this.jobs.find(f=>f.kind===e&&f.id===s.id&&f.host===n)?.started??Date.now()});let l=h(s);this.recordJob(l),this.refreshInfo(t),this.following.add(r);let u=!1;try{for(;!Ee(l.status)&&!this.disposed;){o?.cancelled&&!u&&(u=!0,await this.cancelJob(t,l)),o?.progress(l.progress,Je(l)),await ks(e==="splat"?2e3:e==="movie"?1e3:500);try{const d=l.status;l=h(e==="still"?await t.stillInfo(s.id):e==="movie"?await t.movieInfo(s.id):await t.splatInfo(s.id)),l.status!==d&&this.refreshInfo(t)}catch(d){if(!(d instanceof Y&&d.status===404))throw d;l={...l,status:"gone"}}this.recordJob(l)}}finally{this.following.delete(r)}return l}cancelJob(e,t){return(t.kind==="still"?e.cancelStill(t.id):t.kind==="movie"?e.cancelMovie(t.id):e.cancelSplat(t.id)).catch(()=>{})}resumeJobs(e){const t=e.link.label??"";for(const s of this.jobs){if(Ee(s.status)||s.host!==t||this.following.has(`${s.kind}:${t}:${s.id}`))continue;const i=`${s.kind==="still"?"Still":s.kind==="movie"?"Movie":"Splat"}: ${s.name}`;this.ctx.jobs.run(i,o=>this.follow(s.kind,e,{...s,error:s.error??null},s.name,o)).catch(o=>this.ctx.log.error(`${i}: ${o.message}`))}}serviceFor(e){return this.service!==void 0&&this.serviceInfo!==void 0&&(this.service.link.label??"")===e.host?this.service:void 0}async download(e){const t=this.serviceFor(e);if(t===void 0)return this.ctx.ui.toast(`Connect to ${e.host} first.`,"error");try{e.kind==="still"?ce(await t.stillFile(e.id),"anatomical-rendering.png"):e.kind==="movie"?ce(await t.movieFile(e.id),`${e.name}.mp4`):ce(new Blob([await t.splatFile(e.id,"scene.splat")]),"anatomical-rendering.splat")}catch(s){s instanceof Y&&s.status===404&&this.recordJob({...e,status:"gone"}),this.ctx.ui.toast(`${e.name}: ${s.message}`,"error")}}async renderRotation(){const e=this.currentSpec();if(e===void 0)return;const t=this.saved.rotation;this.renderMovie({keyframes:[{time:0,view:{...e,scale:1}}],rotation:t,name:`rotation-${t.axis}-${t.degrees}`})}loadPresetFile(){const e=b("input",{type:"file",accept:".json,application/json"});e.onchange=async()=>{const t=e.files?.[0];if(t)try{const s=JSON.parse(await t.text()),i=(Array.isArray(s)?s:[s]).filter(o=>o&&typeof o.name=="string"&&Array.isArray(o.stops));if(i.length===0)throw new Error("no preset in it (a preset has a name and stops)");this.save(o=>{const n=new Set(i.map(r=>r.name));o.customPresets=[...o.customPresets.filter(r=>!n.has(r.name)),...i],o.preset=i[0].name}),this.panelUpdate?.()}catch(s){this.ctx.ui.toast(`Preset file: ${s.message}`,"error")}},e.click()}movieSpec(e,t){const s=Xe(this.saved.movie),i={keyframes:this.saved.keyframes,fps:s.fps,width:s.width,height:s.height,samples:s.samples,easing:s.easing,name:"anatomical-rendering",...e??{}};if(!t)return i;const o=384/Math.max(s.width,s.height,1),n=h=>Math.max(16,2*Math.round(h*Math.min(1,o)/2)),r=e?.rotation;return{...i,width:n(s.width),height:n(s.height),samples:Math.min(8,s.samples),fps:Math.min(12,s.fps),crf:30,name:"preview",...r?{rotation:{...r,step:Math.max(6,(r.step??2)*3)}}:{}}}renderMovie(e){const t=this.session?.id,s=this.service;if(t===void 0||s===void 0)return this.ctx.ui.toast("Connect to a computer and switch Render on first.","error");if(e===void 0&&this.saved.keyframes.length<2)return this.ctx.ui.toast("Add two keyframes or more first.","error");if(this.serviceInfo?.ffmpeg===!1)return this.ctx.ui.toast(Cs,"error");const i=Xe(this.saved.movie);let o,n;this.ctx.ui.sheet("Movie preview",(r,h)=>{const l=b("progress",{max:"1",value:"0","aria-label":"Preview"}),u=b("span",{class:"muted"},"Rendering a preview…"),d=b("div",{class:"ar-preview"},l,u),f=L(`Render the movie (${i.width}×${i.height}, ${i.samples} samples)`,()=>{h(),this.movieJob(t,this.movieSpec(e,!1))},void 0,"btn primary");r.append(d,b("div",{class:"row"},f,pe("It renders in the background, its progress in the Movie card and in Activity; the view stays live.","About rendering the movie")));let v=!0;return(async()=>{try{for(o=await s.movie(t,this.movieSpec(e,!0));v&&(o.status==="queued"||o.status==="running");)l.value=o.progress,u.textContent=o.status==="queued"||/^waiting/i.test(o.message)?`Preview ${Je({status:o.status,progress:o.progress,message:o.message,ahead:o.jobs_ahead})}`:o.message||"Rendering a preview…",await new Promise(w=>setTimeout(w,400)),o=await s.movieInfo(o.id);if(!v)return;if(o.status!=="done")throw new Error(o.error??o.status);if(n=URL.createObjectURL(await s.movieFile(o.id)),!v)return;d.replaceChildren(b("video",{src:n,autoplay:!0,loop:!0,muted:!0,playsinline:!0,controls:!0,class:"ar-video"}))}catch(w){if(!v)return;const m=Fe(w);d.replaceChildren(b("p",{class:"empty error"},m?m.text:`The preview failed: ${w.message}`)),m?.retry&&d.append(b("div",{class:"row"},L("Retry",()=>(h(),this.renderMovie(e)))))}})(),()=>{v=!1,o&&(o.status==="queued"||o.status==="running")&&s.cancelMovie(o.id).catch(()=>{}),n&&URL.revokeObjectURL(n)}},{wide:!0})}async movieJob(e,t){const s=this.service,i=String(t.name??"movie");try{await this.ctx.jobs.run(`Movie: ${i}`,async o=>{const n=await s.movie(e,t),r=await this.follow("movie",s,n,i,o);if(r.status!=="done")throw new Error(r.error??r.status);ce(await s.movieFile(n.id),`${i}.mp4`)})}catch(o){this.jobFailed("Movie",o,()=>void this.movieJob(this.session?.status==="ready"?this.session.id:e,t))}}async makeSplat(){const e=this.session?.id,t=this.currentSpec();if(e===void 0||t===void 0||this.service===void 0){this.ctx.ui.toast("Render a view on a computer first: the splat is made from it.","error");return}const s=this.saved.splat,i=this.serviceInfo?.splats;if(s.steps>0&&i&&!i.ready&&!await this.ctx.ui.confirm(`This computer cannot fit splats (${i.error??"no splat Python"}). Render the ${s.views} views only? They can be fitted later on a computer that can.`))return;const o=this.service,n=`Splat of ${this.saved.layer??"the view"}`;try{const r=await this.ctx.jobs.run(n,async h=>{const l=await o.splat(e,{view:{...t,scale:1},views:s.views,size:s.size,samples:s.samples,cover:s.cover,steps:s.steps,name:this.saved.layer??"view"}),u=await this.follow("splat",o,l,n,h);if(u.status!=="done")throw new Error(u.error??u.status);return u});r.files?.includes("scene.splat")&&this.ctx.ui.toast(`Splat made: ${r.message}`)}catch(r){this.jobFailed("Splat",r,()=>void this.makeSplat())}}async viewSplat(e){const t=this.serviceFor(e);if(t===void 0)return this.ctx.ui.toast(`Connect to ${e.host} first.`,"error");try{const[s,i]=await Promise.all([t.splatFile(e.id,"scene.splat"),t.splatFile(e.id,"cameras.json")]),o=JSON.parse(new TextDecoder().decode(i)),n=o.frames[0]?{c2w:o.frames[0].c2w,fovy:o.frames[0].fovy,centre:o.centre}:void 0,r=(h,l)=>()=>void t.splatFile(e.id,h).then(u=>ce(new Blob([u]),l));ws(this.ctx.ui.sheet,e.name,gs(s),n,[["Download .splat",r("scene.splat","anatomical-rendering.splat")],...e.files?.includes("splat.ply")?[["Download .ply",r("splat.ply","anatomical-rendering.ply")]]:[]])}catch(s){this.ctx.ui.toast(`Splat: ${s.message}`,"error")}}openSplatFile(){const e=b("input",{type:"file",accept:".splat,.ply"});e.onchange=async()=>{const t=e.files?.[0];if(t)try{const s=await t.arrayBuffer();ws(this.ctx.ui.sheet,t.name,t.name.toLowerCase().endsWith(".ply")?Mi(s):gs(s),void 0)}catch(s){this.ctx.ui.toast(`Splat file: ${s.message}`,"error")}},e.click()}status(){const e=this.saved.where==="host";if(e&&this.connectProblem&&this.connecting===void 0)return{error:this.connectProblem,action:this.service===void 0?"pair":"retry"};const t=e?this.session:void 0;return this.problem?{error:this.problem,action:"retry"}:t?.status==="failed"?{error:`Failed: ${t.error??"unknown error"}`,action:"retry"}:this.refused?{error:this.refused.text,action:"again"}:this.saved.on?e&&this.connecting!==void 0?{progress:`Connecting to ${this.link()?.label??"the render computer"}…`}:t?.status==="loading"?{progress:`Loading: ${t.message} (${Math.round(t.progress*100)}%)`}:!e&&this.local&&!this.local.ready&&this.localText?{progress:this.localText}:{}:{}}readout(){const e=[],t=this.session;if(this.saved.where==="host"&&t?.status==="ready"){const s=t.volume;e.push(`${t.message}${s.made?s.from_cache?" (made here, from the cache)":" (made here by downsampling)":""}`)}return this.saved.where==="browser"&&this.local?.ready&&e.push(this.localText),this.live.text&&e.push(this.live.text),this.frameText&&e.push(this.frameText),e.join(`
`)}panel(e){const t=this.ctx,s=()=>this.saved,i={label:"Open data…",run:()=>void t.commands.invoke("dataset.add")},o=[],n=c=>(o.push(c),c),r=cs("Render",s().on,c=>this.setOn(c)),h=Js(),l=ls("No OME-Zarr or N5 image in this scene.",i),u=se(c=>[L("Centre",()=>this.centreOnTissue()),...c.map(p=>b("button",{class:"btn outline small",type:"button",title:`Look from ${p.name}`,"aria-label":`Look from ${p.name}`,onclick:()=>this.lookFrom(p)},p.label)),pe(c[0]?.label.startsWith("+")?"Centre moves to the middle of the tissue and zooms to show all of it. The others look from each end of x, y and z: the image's metadata does not give its anatomical orientation (in RAS, +x is right, +y anterior and +z superior).":"Centre moves to the middle of the tissue and zooms to show all of it. The others look from each side of the image, as its metadata names them.","About the view buttons")],{class:"row"}),d=Q([["host","A computer's GPU (CUDA)"],["browser","This browser (WebGPU)"]],s().where,c=>{this.save(p=>p.where=c),this.update()},"Where"),f=ue(c=>{this.host={name:c||void 0},t.settings.set(Us,this.host),this.connect()},"Computer"),v=n(b("p",{class:"readout"})),w=L("Reconnect",()=>void this.connect()),m=Z("anatomical.remote","Remote",{open:!0},R("Where",d),n(R("Computer",f)),v,n(b("div",{class:"row"},L("Pair a computer…",()=>void t.commands.invoke(Ce.command,Ce.args)),w))),T=ue(c=>this.save(p=>p.layer=c),"Image"),y=b("p",{class:"hint"});let S,E;const F=se(c=>{if(S=E=void 0,c===void 0)return null;const p=()=>this.target(),g=p()?this.volumeAt(p()):{channel:0,time:0};return c.channels>1&&(S=Q(Array.from({length:c.channels},(P,_)=>[String(_),String(_)]),String(g.channel),P=>{const _=p();_&&this.setVolumeAt(_,{channel:Number(P)})},"Channel")),c.times>1&&(E=I(g.time,{min:0,max:c.times-1,step:1,label:"Time point",onchange:P=>{const _=p();_&&this.setVolumeAt(_,{time:Math.round(P)})}})),[S&&R("Channel",S,{info:`This image has ${c.channels} channels, numbered from 0: one is rendered at a time.`}),E&&R("Time point",E,{info:`This image has ${c.times} time points, numbered from 0: one is rendered at a time.`})]},{class:"stack"}),A=ue(c=>this.save(p=>p.preset=c),"Preset"),W=se(c=>c.length===0?null:b("p",{class:"hint"},"Colours from ",...c.flatMap((p,g)=>[g?", ":"",p.page?b("a",{href:p.page,target:"_blank",rel:"noopener"},`photo ${g+1}`):`photo ${g+1}`])," ",pe(c.map(p=>`${p.title} (${p.author}${p.licence?`, ${p.licence}`:""})`).join("; "),"About the photographs")));let M;const j=se(c=>{if(M=void 0,c===void 0)return null;const p=this.saved.windows[c.src]??c.guess,g=(P,_)=>I(p?p[P]:P,{min:c.lo,max:c.hi,step:c.step,label:_,onchange:k=>this.setWindow(c.src,P,k,c.guess)});return M=[g(0,"Window low"),g(1,"Window high")],R("Window",b("div",{class:"stack"},M[0],M[1],b("div",{class:"row"},L("Guess",()=>this.save(P=>delete P.windows[c.src])))),{info:"The image values the preset's colours are spread over, low and high. Guess goes back to the computer's guess: from just past the mounting medium, with the commonest tissue value at the middle."})}),q=I(0,{min:-1,max:1,step:.01,label:"Shift",oninput:c=>this.tune(p=>p.shift=c*this.mapWidth(),!0),onchange:c=>this.tune(p=>p.shift=c*this.mapWidth())}),H=I(1,{min:.4,max:2.5,step:.01,label:"Compress",oninput:c=>this.tune(p=>p.scale=c,!0),onchange:c=>this.tune(p=>p.scale=c)}),U=se(c=>c?[R("Colourmap",this.colourmapEditor().element,{info:"The image's histogram (grey) under the preset's colours and opacity. Drag a point: left and right moves it, up and down its opacity. Double-click to colour it, Ctrl-click to add one, right-click to remove one. The blue triangles under the histogram slide and warp it under the colours."}),R("Shift",q,{info:"Moves the whole map along the values (a fraction of its width)."}),R("Compress",H,{info:"Narrows (below 1) or widens (above 1) the map about its middle."}),b("div",{class:"row"},L("Reset",()=>{const p=this.currentTuning();p&&this.save(g=>delete g.tunings[p.src]),this.editorUpdate?.()}),L("Save as a preset file",()=>{const p=this.tunedPreset()??this.resolved?.preset;if(!p)return;const g=`${String(p.name??"preset")} (tuned)`;ce(new Blob([JSON.stringify([{...p,name:g}],null,1)],{type:"application/json"}),"preset.json")}),pe("Reset goes back to the preset as it falls on this image. Save as a preset file writes the map as tuned, at this image's values, to load again with Load…","About the colourmap's buttons"))]:null,{class:"stack"}),G=I(40,{min:0,max:200,label:"Density",unit:"/mm",oninput:c=>this.preview(p=>p.density=c),onchange:c=>this.save(p=>p.density=c)}),ne=I(1,{min:0,max:5,step:.05,label:"Exposure",oninput:c=>this.preview(p=>p.exposure=c),onchange:c=>this.save(p=>p.exposure=c)}),ae=n(le("Hide the jar",!1,c=>{this.save(p=>p.jar=c),this.update()},{info:"Renders only a cylinder about the scan's axis, leaving out the jar's wall (HiP-CT organs in their jars)."})),ot=Z("anatomical.rendering","Rendering",{open:!0},R("Image",T),y,F,b("div",{class:"row"},R("Preset",A,{info:"A look per modality or organ. Load… reads a preset (or a list of them) from a JSON file: a name, a domain, stops of value, colour and opacity, and the material."}),L("Load…",()=>this.loadPresetFile())),W,j,U,R("Density",G,{info:"How opaque the tissue is: higher gives crisper surfaces, lower more translucent ones."}),R("Exposure",ne),ae),nt=ls("No OME-Zarr segmentation in this scene.",i),at=le("Colour by region",!1,c=>this.save(p=>p.regions=c)),rt=ue(c=>this.save(p=>p.labels=c),"Segmentation"),ct=I(.85,{min:0,max:1,step:.05,label:"Region colour",oninput:c=>this.preview(p=>p.labelMix=c),onchange:c=>this.save(p=>p.labelMix=c)}),lt=Rs([],c=>this.save(p=>p.hidden=c),"Hidden regions"),ht=Rs([],c=>this.save(p=>p.keep=c),"Kept whole"),dt=b("div",{class:"stack"},R("Segmentation",rt),at,R("Region colour",ct,{info:"0 keeps the preset's colours; 1 gives each region its own."}),R("Hidden regions",lt,{info:"Label ids left out, with spaces or commas between."}),R("Kept whole",ht,{info:"Label ids that stay whole where the crops cut (vessels through a cut brain)."})),ut=Z("anatomical.regions","Regions",{},nt,dt),pt=I(400,{min:10,max:2e3,step:10,unit:"M voxels",label:"Whole volume",onchange:c=>this.save(p=>p.budget=Math.max(1,c)*1e6)}),ft=n(le("Finer detail",!0,c=>{this.save(p=>p.detail=c),this.update()},{info:"Where the view comes close, the region in view is read at a finer level; shadows and light from outside it stay at the whole volume's."})),vt=I(200,{min:10,max:2e3,step:10,unit:"M voxels",label:"Detail",onchange:c=>{this.save(p=>p.detailBudget=Math.max(1,c)*1e6),this.update()}}),mt=R("Detail",vt,{info:"The voxels the finer region may hold."}),gt=le("Denoise",!0,c=>this.save(p=>p.denoise=c),{info:"Smooths the first frames after the view changes (the computer's denoiser)."}),wt=le("Path-traced picture when still",!1,c=>{this.lastKey="",this.save(p=>p.restPicture=c)},{info:"Over the object, the path-traced picture of the view (at the image's full detail) once the camera rests. Off, the view shows the object alone, and the render computer renders only stills, movies and splats."}),yt=I(512,{min:16,max:4096,step:16,label:"Samples per pixel",onchange:c=>this.save(p=>p.maxSamples=Math.max(1,Math.round(c)))}),Re=b("p",{class:"readout"}),bt=Z("anatomical.quality","Quality",{},R("Whole volume",pt,{info:"One level of the whole image on the GPU: the finest stored level within this, or one made from a finer level."}),ft,mt,gt,wt,R("Samples per pixel",yt,{info:"Where a still view stops refining."}),Re),ze=ue(c=>this.save(p=>{p.lightStyle=c;const g=vs[c];g&&([p.lightMap,p.envScale,p.lightKey]=[g.map,g.envScale,g.key])}),"Style");ze.update([["","Custom"],...Object.entries(vs).map(([c,p])=>[c,p.name])],s().lightStyle);const xt=I(30,{min:-180,max:180,step:5,unit:"°",label:"Around",oninput:c=>this.preview(p=>p.lightAzimuth=c),onchange:c=>this.save(p=>p.lightAzimuth=c)}),Tt=I(40,{min:-90,max:90,step:5,unit:"°",label:"Up",oninput:c=>this.preview(p=>p.lightElevation=c),onchange:c=>this.save(p=>p.lightElevation=c)}),Et=I(1,{min:0,max:4,step:.05,label:"Key light",oninput:c=>this.preview(p=>p.lightKey=c),onchange:c=>this.save(p=>(p.lightKey=c,p.lightStyle=""))}),St=I(1,{min:0,max:3,step:.05,label:"Surroundings",oninput:c=>this.preview(p=>p.envScale=c),onchange:c=>this.save(p=>(p.envScale=c,p.lightStyle=""))}),Pt=ue(c=>this.save(p=>p.lightMap=c),"Light map"),_t=I(0,{min:-180,max:180,step:5,unit:"°",label:"Turn the light map",oninput:c=>this.preview(p=>p.lightMapRotation=c),onchange:c=>this.save(p=>p.lightMapRotation=c)}),At=b("div",{class:"stack"},R("Light map",Pt,{info:"HDR panoramas (CC0, Poly Haven), or the preset's sky colours."}),R("Turn",_t)),Rt=Z("anatomical.lighting","Lighting",{},n(R("Style",ze)),R("Around",xt,{info:"The key light turns with the camera: 0 lights from the camera, 90 from the right, -90 from the left."}),R("Up",Tt,{info:"90 lights from above, -90 from below."}),n(R("Key light",Et,{info:"The light that makes shadows."})),n(R("Surroundings",St,{info:"Light from all round: the light map, or the sky colours."})),At),Ks=L("Move to the cursor",()=>{const c=this.cursorOffsets();if(!c)return t.ui.toast("Point at the tissue in the 3-D view first.","error");this.save(p=>{const g=this.lastFrame.dimensions.names;for(const P of p.cuts){const _=g.indexOf(P.axis);P.on&&_>=0&&_<3&&(P.offset=c.axis[_])}p.viewCut.on&&(p.viewCut={...p.viewCut,offset:c.view,fixed:null})})}),kt=le("Camera plane",!1,c=>this.save(p=>{const g=c?this.cursorOffsets():void 0;p.viewCut={...p.viewCut,on:c,...g?{offset:g.view,fixed:null}:{}}}),{info:"A clip across the view, keeping what lies beyond it. It turns with the camera; Pin keeps it where it is now (an oblique clip), Follow lets it turn again."}),Mt=I(0,{min:-100,max:100,step:.5,unit:"mm",label:"Camera plane offset",unbounded:!0,onchange:c=>this.save(p=>p.viewCut={...p.viewCut,offset:c,fixed:null})}),Lt=L("Pin",()=>{if(this.saved.viewCut.fixed)return this.save(p=>p.viewCut={...p.viewCut,fixed:null});const c=this.lastFrame;if(!c)return t.ui.toast("Render a view first.","error");this.save(p=>p.viewCut={...p.viewCut,on:!0,fixed:ps(c.invViewProjection,c.position,p.viewCut.offset,c.dimensions)})}),Ut=s().cuts.map((c,p)=>{const g=le(`Across ${c.axis}`,c.on,k=>this.save(C=>{C.cuts[p].on=k;const B=k?this.cursorOffsets():void 0,D=this.lastFrame?.dimensions.names.indexOf(C.cuts[p].axis)??-1;B&&D>=0&&D<3&&(C.cuts[p].offset=B.axis[D])})),P=Q([["-1","keep −"],["1","keep +"]],String(c.keep),k=>this.save(C=>C.cuts[p].keep=Number(k)),`Side kept across ${c.axis}`),_=I(c.offset,{min:-100,max:100,step:.5,unit:"mm",label:`Offset across ${c.axis}`,unbounded:!0,onchange:k=>this.save(C=>C.cuts[p].offset=k)});return{on:g,side:P,offset:_,row:b("div",{class:"ar-cut"},g,P,_)}});let Oe=[];const Ct=se(c=>(Oe=[],Array.from({length:c},(p,g)=>{const P=this.saved.boxes[g],_=cs(`Box ${g+1}`,P.on,D=>this.save(O=>O.boxes[g].on=D),{hideLabel:!0}),k=b("input",{class:"text-input ar-grow",type:"text",value:P.name,"aria-label":`Name of box ${g+1}`});k.onchange=()=>this.save(D=>D.boxes[g].name=k.value),k.set=D=>{k.ownerDocument.activeElement!==k&&k.value!==D&&(k.value=D)};const C=Q([["keep","keep inside"],["cut","cut out"]],P.keep?"keep":"cut",D=>this.save(O=>O.boxes[g].keep=D==="keep"),`Box ${g+1} keeps`),B=["x","y","z"].map((D,O)=>[I(P.lo[O],{min:0,max:1,step:.005,label:`Box ${g+1} low ${D}`,onchange:de=>this.save(te=>te.boxes[g].lo[O]=Math.min(de,te.boxes[g].hi[O]-.005))}),I(P.hi[O],{min:0,max:1,step:.005,label:`Box ${g+1} high ${D}`,onchange:de=>this.save(te=>te.boxes[g].hi[O]=Math.max(de,te.boxes[g].lo[O]+.005))})]);return Oe.push({on:_,name:k,keep:C,ends:B}),b("div",{class:"ar-box"},b("div",{class:"row"},_,k,C,we("trash",`Remove box ${g+1}`,()=>this.save(D=>D.boxes.splice(g,1)))),b("div",{class:"ar-box-axes"},...B.flatMap(([D,O],de)=>[b("span",{},"xyz"[de]),D,O])))})),{class:"stack"}),Dt=L("Add a box",()=>{this.saved.boxes.length>=$.maxBoxes||this.save(c=>c.boxes.push({name:`Box ${c.boxes.length+1}`,on:!0,keep:!0,lo:[0,0,0],hi:[1,1,1]}))}),Ft=Z("anatomical.crops","Crops",{info:`Clips and boxes. A clip turned on starts through the point the cursor was last over in the 3-D view; Move to the cursor moves the clips that are on there. Boxes (up to ${$.maxBoxes}) are fractions of the volume along x, y and z; what shows is inside any box that keeps and in none that cuts out.`},b("div",{class:"row"},Ks),kt,b("div",{class:"row"},b("div",{class:"ar-grow"},Mt),Lt),b("h4",{class:"section-title"},"Axis planes"),...Ut.map(c=>c.row),b("h4",{class:"section-title"},"Boxes"),Ct,b("div",{class:"row"},Dt)),Ne=(c,p,g,P,_)=>{const k=De(p(s().movie),g,C=>this.save(B=>P(B.movie,C)),{"aria-label":c,..._});return{input:k,field:R(c,k)}},It=Ne("Width",c=>c.width,fe,(c,p)=>c.width=p,{min:"8",max:"8192",step:"2"}),zt=Ne("Height",c=>c.height,fe,(c,p)=>c.height=p,{min:"8",max:"8192",step:"2"}),Ot=Ne("Samples",c=>c.samples,c=>oe(c,1,$.maxSamples),(c,p)=>c.samples=p,{min:"1",max:String($.maxSamples)}),$e=L("Save still (PNG)",()=>void this.saveStill()),Nt=b("p",{class:"hint"},Cs),Be=c=>se(p=>p.map(g=>{const P=this.serviceFor(g),_=[];return!Ee(g.status)&&P&&_.push(L("Cancel",()=>void this.cancelJob(P,g))),g.status==="done"&&g.kind==="splat"&&g.files?.includes("scene.splat")&&_.push(L("View",()=>void this.viewSplat(g))),g.status==="done"&&(g.kind!=="splat"||g.files?.includes("scene.splat"))&&_.push(L("Download",()=>void this.download(g))),Ee(g.status)&&_.push(we("close",`Remove ${g.name} from the list`,()=>(this.jobs=Pi(this.jobs,g),t.settings.set(qe,this.jobs),this.jobsUpdate?.()))),b("li",{class:"ar-job"},b("span",{class:"readout"},_i(g)),..._)}),{class:"list"}),$t=Be(),Bt=Z("anatomical.output","Output",{info:"The size and samples of stills and movies. A still is path-traced on the computer to twice the samples, as a job: its progress here and in Activity, and it downloads when done."},b("div",{class:"row"},It.field,zt.field,Ot.field),b("div",{class:"row"},$e),n(Nt),$t);let Ve=[];const Vt=se(c=>(Ve=[],Array.from({length:c},(p,g)=>{const P=Fs(this.saved.keyframes[g].time,k=>this.save(C=>C.keyframes[g].time=k),{step:"0.5","aria-label":`Time of keyframe ${g+1}`});Ve.push(P);const _=k=>()=>this.save(C=>C.keyframes=po(C.keyframes,g,k));return b("li",{class:"row"},b("span",{class:"muted"},`#${g+1} at`),P,b("span",{class:"muted"},"s"),L("Go to",()=>this.goToKeyframe(g)),L("Replace",()=>this.addKeyframe(g)),we("arrow-up",`Move keyframe ${g+1} earlier`,_(-1),{disabled:g===0}),we("arrow-down",`Move keyframe ${g+1} later`,_(1),{disabled:g===c-1}),we("trash",`Remove keyframe ${g+1}`,()=>this.save(k=>k.keyframes.splice(g,1))))})),{class:"list"}),Gt=De(s().movie.fps,c=>oe(c,1,$.maxFps),c=>this.save(p=>p.movie.fps=c),{min:"1",max:String($.maxFps),"aria-label":"Frames a second"}),Xt=Q([["smooth","slows at keyframes"],["linear","steady"]],s().movie.easing,c=>this.save(p=>p.movie.easing=c),"Camera"),Ht=Q([["vertical","the vertical"],["horizontal","the horizontal"]],s().rotation.axis,c=>this.save(p=>p.rotation.axis=c),"About"),Wt=Q([["360","full turn"],["180","half turn"]],String(s().rotation.degrees),c=>this.save(p=>p.rotation.degrees=Number(c)),"Turn"),jt=De(s().rotation.step,c=>Math.min(90,Math.max(.25,c)),c=>this.save(p=>p.rotation.step=c),{step:"1",min:"0.25",max:"90","aria-label":"Step (degrees)"}),Kt=Be(),qt=Z("anatomical.movie","Movie",{info:"Add keyframes as you move, set each one's time, then preview: a small, quick version plays in a window, and from there the movie renders in the background at the Output card's size and samples. Go to moves the view back to a keyframe; Replace puts the view now in its place."},Vt,b("div",{class:"row"},L("Add keyframe",()=>this.addKeyframe()),R("fps",Gt),R("Camera",Xt)),b("div",{class:"row"},L("Preview movie…",()=>this.renderMovie())),b("h4",{class:"section-title"},"Rotation"),b("div",{class:"row"},R("About",Ht),R("Turn",Wt),R("Step °",jt)),b("div",{class:"row"},L("Preview rotation…",()=>void this.renderRotation())),Kt),ke=n(b("p",{class:"hint"})),Me=(c,p,g,P,_,k)=>{const C=De(p(s().splat),B=>oe(B,g,P),B=>this.save(D=>_(D.splat,B)),{min:String(g),max:String(P),"aria-label":c});return{input:C,field:R(c,C,k?{info:k}:void 0)}},Yt=Me("Views",c=>c.views,8,4096,(c,p)=>c.views=p),Jt=Me("Size",c=>c.size,64,4096,(c,p)=>c.size=p,"Pixels along the longer side of each view."),Zt=Me("Samples",c=>c.samples,1,8192,(c,p)=>c.samples=p),Qt=Me("Fit steps",c=>c.steps,0,2e5,(c,p)=>c.steps=p,"0 renders the views only."),es=Q([["180","every side"],["90","this half"],["50","near this side"]],String(s().splat.cover),c=>this.save(p=>p.splat.cover=Number(c)),"From"),ts=Be(),ss=Z("anatomical.splat","Splat",{info:"The look now, path-traced from all round and fitted with 3-D Gaussians that any browser, phone or headset draws at full speed."},ke,b("div",{class:"row"},Yt.field,Jt.field,Zt.field,R("From",es),Qt.field),b("div",{class:"row"},L("Make splat",()=>void this.makeSplat()),L("Open file…",()=>this.openSplatFile()),pe("Make splat runs on the computer that renders. Open file… views a .splat or a 3-D Gaussian splatting .ply from this device.","About splats")),ts);e.append(b("div",{class:"row"},r),l,h,u,m,ot,ut,bt,Rt,Ft,Bt,qt,ss);let is="";this.statusUpdate=()=>{const c=this.status(),p=JSON.stringify(c);p!==is&&(is=p,c.error!==void 0?h.error(c.error,c.action==="pair"?{label:"Pair a computer…",run:()=>void t.commands.invoke(Ce.command,Ce.args)}:c.action==="again"?{label:"Retry",run:()=>this.retryJob()}:{label:"Retry",run:()=>this.retry()}):c.progress!==void 0?h.progress(c.progress):h.clear());const g=this.readout();Re.textContent!==g&&(Re.textContent=g),Re.hidden=g===""},this.jobsUpdate=()=>{for(const[c,p]of[["still",$t],["movie",Kt],["splat",ts]])p.update(this.jobs.filter(g=>g.kind===c))},this.editorUpdate=()=>{const c=this.editedStops(),p=this.session?.volume?.histogram;c&&this.editor&&!this.editor.dragging&&this.editor.set(p,c.stops,c.warp)};let os=!0;const Ge=()=>{const c=this.saved,p=this.images(),g=this.target(),P=c.where==="host",_=g?this.axesOf(g):{};for(const x of o)x.hidden=!P;r.set(c.on),r.input.disabled=p.length===0,l.hidden=p.length>0,u.update(p.length?this.viewButtons():[]),u.hidden=p.length===0;const k=!P||this.serviceInfo!==void 0;!k&&os&&this.connecting===void 0&&(m.open=!0),os=k||this.connecting!==void 0,d.set(c.where);const C=this.renderHosts(),B=this.link()?.label;f.update([["",`Automatic${!this.host.name&&B?`: ${B}`:""}`],...C.map(x=>[x.name,`${x.name}${x.info?.hostname&&x.info.hostname!==x.name?` (${x.info.hostname})`:""}${x.available?"":": not answering"}`])],C.some(x=>x.name===this.host.name)?this.host.name:"");const D=this.serviceInfo?.gpu;v.textContent=this.serviceInfo===void 0?"":di(this.serviceInfo),v.hidden=!P||D===void 0,w.hidden=C.length===0,ot.hidden=p.length===0,T.update(p.map(x=>[x.name,x.name]),g?.name??""),y.textContent=_.problem??"";const O=g&&_.problem===void 0?this.volumeCounts(g):void 0;if(F.update(O),F.hidden=O===void 0,g&&O){const x=this.volumeAt(g);S?.set(String(x.channel)),E?.set(x.time)}y.hidden=y.textContent==="",y.className=_.problem!==void 0?"hint error":"hint";const te=[...c.where==="browser"?ve.map(x=>({name:x.name,modality:x.modality??""})):this.presets,...c.customPresets.map(x=>({name:String(x.name),modality:"from a file"}))];A.update(te.map(x=>[x.name,x.modality?`${x.name} (${x.modality})`:x.name]),c.preset),A.disabled=te.length===0,W.update(this.references());const Le=this.windowRange();if(j.update(Le),Le&&M){const x=c.windows[Le.src]??Le.guess;x&&M.forEach((J,re)=>J.set(x[re]))}const Ue=P&&this.session?.status==="ready"?this.currentTuning():void 0;if(U.update(Ue!==void 0),Ue){const x=this.mapWidth();q.set(x?Ue.tuning.shift/x:0),H.set(Ue.tuning.scale),this.editorUpdate?.(),this.resolvePreset()}G.set(c.density??Number(this.presets.find(x=>x.name===c.preset)?.density??40)),ne.set(c.exposure),ae.set(c.jar);const me=this.segmentations();ut.hidden=!P||p.length===0,nt.hidden=me.length>0,dt.hidden=me.length===0,rt.update(me.map(x=>[x.name,x.name]),me.find(x=>x.name===c.labels)?.name??me[0]?.name??""),at.set(c.regions),ct.set(c.labelMix),lt.set(c.hidden),ht.set(c.keep),bt.hidden=p.length===0,pt.set(c.budget/1e6),ft.set(c.detail),mt.hidden=!P||!c.detail,vt.set(c.detailBudget/1e6),gt.set(c.denoise),wt.set(c.restPicture),yt.set(c.maxSamples),Rt.hidden=p.length===0,ze.set(c.lightStyle),xt.set(c.lightAzimuth),Tt.set(c.lightElevation),Et.set(c.lightKey),St.set(c.envScale);const as=this.serviceInfo?.lightmaps??[];At.hidden=!P||as.length===0,Pt.update([["","Sky colours"],...as.map(x=>[x,x])],c.lightMap),_t.set(c.lightMapRotation),Ft.hidden=p.length===0,kt.set(c.viewCut.on),Mt.set(c.viewCut.offset),Lt.textContent=c.viewCut.fixed?"Follow":"Pin",Ut.forEach((x,J)=>{x.on.set(c.cuts[J].on),x.side.set(String(c.cuts[J].keep)),x.offset.set(c.cuts[J].offset)}),Ct.update(c.boxes.length),Oe.forEach((x,J)=>{const re=c.boxes[J];x.on.set(re.on),x.name.set(re.name),x.keep.set(re.keep?"keep":"cut"),x.ends.forEach(([qs,Ys],rs)=>(qs.set(re.lo[rs]),Ys.set(re.hi[rs])))}),Dt.disabled=c.boxes.length>=$.maxBoxes,Bt.hidden=qt.hidden=ss.hidden=p.length===0,It.input.set(fe(c.movie.width)),zt.input.set(fe(c.movie.height)),Ot.input.set(oe(c.movie.samples,1,$.maxSamples)),$e.disabled=this.stillRunning,$e.textContent=this.stillRunning?"Rendering still…":"Save still (PNG)",Nt.hidden=!P||this.serviceInfo?.ffmpeg!==!1,Vt.update(c.keyframes.length),Ve.forEach((x,J)=>x.set(c.keyframes[J].time)),Gt.set(oe(c.movie.fps,1,$.maxFps)),Xt.set(c.movie.easing),Ht.set(c.rotation.axis),Wt.set(String(c.rotation.degrees)),jt.set(c.rotation.step);const ge=this.serviceInfo?.splats;ke.textContent=ge&&!ge.ready?`Views only: this computer cannot fit (${ge.error??"no splat Python"}).`:ge?.warning?`${ge.warning}.`:"",ke.hidden=!P||ke.textContent==="",Yt.input.set(c.splat.views),Jt.input.set(c.splat.size),Zt.input.set(c.splat.samples),Qt.input.set(c.splat.steps),es.set(String(c.splat.cover)),this.jobsUpdate?.(),this.statusUpdate?.()};this.panelUpdate=Ge,Ge();const ns=setInterval(()=>{if(this.panelUpdate!==Ge)return clearInterval(ns);this.saved.where==="host"&&!document.hidden&&this.refreshInfo()},wo);return()=>{clearInterval(ns),this.panelUpdate=void 0,this.statusUpdate=void 0,this.jobsUpdate=void 0,this.editorUpdate=void 0}}disposed=!1;dispose(){this.disposed=!0,this.panelUpdate=this.statusUpdate=this.jobsUpdate=this.editorUpdate=void 0,this.closeSession(),this.closeLocal(),clearTimeout(this.settle),this.handle?.dispose(),this.drawer.dispose(),this.toggle.dispose();for(const e of this.offs)e()}}const Po={activate(a){const e=document.createElement("style");e.textContent=vo,(document.head??document.body).append(e),a.subscriptions.push(()=>e.remove());const t=new yo(a);a.subscriptions.push(()=>t.dispose())}};export{go as farFrom,po as moveKeyframe,As as parseIds,Po as plugin,_s as readSaved};
