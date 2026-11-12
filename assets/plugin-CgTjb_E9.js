import{e as x,n as C,h as fe,l as ce,t as We,j as ii,d as fs,r as Q,m as te,a as ee,f as M,p as O,c as ue,i as le,o as Ns}from"./dom-CEvR2cwn.js";import{W as oi}from"./worker_rpc-BGQIcfWl.js";import{w as ai}from"./chunk_host-nd9vUssm.js";import{R as ni,u as ms,v as $s,o as G,a as vs,b as ri,m as ci,c as li,d as hi,s as di,e as gs,f as ui,p as pi,l as ws,g as ys,h as fi,L as bs}from"./view-DBdl7ErE.js";import"./shared_chunks-BvbSDm9W.js";function mi(n,e,t){return{base:`${e.replace(/\/+$/,"")}/svc/render`,token:"",viaRunner:!0,hostFetch:t,label:n}}function he(n,e,t={},s=!1){if(n.hostFetch){const i=new Headers(t.headers);return s&&i.set("Content-Type","application/json"),n.hostFetch(`render${e}`,{...t,headers:i})}return fetch(`${n.base}${e}`,{...t,headers:{...vi(n,s),...t.headers}})}function vi(n,e){const t={};return n.token&&(n.viaRunner?t.Authorization=`Bearer ${n.token}`:t["X-NGP-Service-Token"]=n.token),e&&(t["Content-Type"]="application/json"),t}class Z extends Error{constructor(e,t=0,s={},i){super(e),this.status=t,this.detail=s,this.retryAfter=i}}function gi(n){return n<1024?`${Math.round(n)} MB`:`${(n/1024).toFixed(n<10240?1:0)} GB`}function ze(n){if(!(n instanceof Z))return;const e=n.detail,t=s=>typeof e[s]=="number"?gi(e[s]):void 0;if(e.reason==="gpu-budget"||n.status===503&&e.need_mb!==void 0){const s=t("need_mb"),i=t("free_mb");return{text:`The render computer's GPU is busy${s&&i?` (needs ${s}, ${i} free)`:""}. Retry, or close another view.`,retry:!0}}if(e.reason==="queue-full"||n.status===429)return{text:"Too many jobs waiting on the render computer. Retry when one has finished.",retry:!0};if(e.reason==="disk"||n.status===507){const s=t("need_mb"),i=t("free_mb");return{text:`The render computer's disk is nearly full${s?` (needs ${s}${i?`, ${i} free`:""})`:""}. Free some space there, then Retry.`,retry:!0}}if(n.status===400&&typeof e.error=="string")return{text:e.error,retry:!1}}async function V(n,e,t,s,i,o={}){const a=await he(n,t,{...o,method:e,body:s===void 0?void 0:JSON.stringify(s),signal:i},s!==void 0),r=await a.text();let l;try{l=r?JSON.parse(r):void 0}catch{l=r}if(!a.ok){const c=l&&typeof l=="object"?l:{},u=typeof c.error=="string"?c.error:`${a.status} ${a.statusText}`,d=Number(a.headers.get("Retry-After")),f=Number.isFinite(d)&&d>0?d:void 0,m=ze(new Z("",a.status,c));throw new Z(m?m.text:`${e} ${t}: ${u}`,a.status,c,f)}return l}function wi(n){const e=n.gpu;if(e.backend!=="cuda")return`No GPU: ${e.error??""}`;const t=o=>(o/1024).toFixed(o<102400?1:0).replace(/\.0$/,""),s=[e.name??"GPU"];n.budget?s.push(`GPU: ${t(n.budget.used_mb)} of ${t(n.budget.total_mb)} GB in use`):s.push(`${Math.round((e.free_mb??0)/1024)} of ${Math.round((e.total_mb??0)/1024)} GB free`);const i=n.queue;if(i&&(i.running||i.waiting.length>0)){const o=i.waiting.length;s.push([i.running?"1 job running":"",o?`${o} waiting`:""].filter(Boolean).join(", "))}return s.join(" · ")}class yi{constructor(e){this.link=e}info(e){return V(this.link,"GET","/info",void 0,e)}resolve(e,t,s={}){return V(this.link,"POST",`/sessions/${e}/resolve`,{preset:t,overrides:s})}presets(){return V(this.link,"GET","/presets")}open(e,t){return V(this.link,"POST","/sessions",{volume:e,labels:t})}session(e){return V(this.link,"GET",`/sessions/${e}`)}close(e,t=!1){return V(this.link,"DELETE",`/sessions/${e}`,void 0,void 0,t?{keepalive:!0}:{})}setView(e,t){return V(this.link,"PUT",`/sessions/${e}/view`,t)}still(e,t){return V(this.link,"POST",`/sessions/${e}/stills`,t)}stillInfo(e){return V(this.link,"GET",`/stills/${e}`)}cancelStill(e){return V(this.link,"DELETE",`/stills/${e}`)}async stillFile(e){const t=await he(this.link,`/stills/${e}/file`);if(!t.ok)throw new Z(`still file: ${t.status}`,t.status);return t.blob()}movie(e,t){return V(this.link,"POST",`/sessions/${e}/movies`,t)}movieInfo(e){return V(this.link,"GET",`/movies/${e}`)}cancelMovie(e){return V(this.link,"DELETE",`/movies/${e}`)}splat(e,t){return V(this.link,"POST",`/sessions/${e}/splats`,t)}splatInfo(e){return V(this.link,"GET",`/splats/${e}`)}cancelSplat(e){return V(this.link,"DELETE",`/splats/${e}`)}async splatFile(e,t){const s=await he(this.link,`/splats/${e}/file/${t}`);if(!s.ok)throw new Z(`splat file: ${s.status}`);return s.arrayBuffer()}async movieFile(e){const t=await he(this.link,`/movies/${e}/file`);if(!t.ok)throw new Z(`movie file: ${t.status}`);return t.blob()}async frame(e,t,s,i=-1){const o=await he(this.link,`/sessions/${e}/frame?after=${t}&timeout=20&have=${i}`,{signal:s});if(o.status===204)return;if(!o.ok){const w=(await o.json().catch(()=>({}))).error;throw new Z(`frame: ${w??o.status}`,o.status)}let a=await o.blob();const r=w=>Number(o.headers.get(w)??0),l=r("X-Version"),c=r("X-Distance-Offset");let u;if(c&&o.headers.get("X-Distance-Format")==="float16-zlib"){const w=a.slice(c);a=a.slice(0,c);const _=r("X-Distance-Width"),y=r("X-Distance-Height"),P=r("X-Distance-Scale");u=new Response(w.stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer().then(T=>({version:l,width:_,height:y,data:bi(new Uint16Array(T),P)}))}const d=r("X-Alpha-Offset"),[f,m,v]=await Promise.all([createImageBitmap(d?a.slice(0,d,"image/jpeg"):a,{premultiplyAlpha:"none"}),d?new Response(a.slice(d).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer().then(w=>new Uint8Array(w)):void 0,u]);return{bitmap:f,alpha:m,detail:o.headers.get("X-Detail")??void 0,number:r("X-Frame"),samples:r("X-Samples"),version:l,width:r("X-Width"),height:r("X-Height"),msPerPass:r("X-Ms-Per-Pass"),distance:v}}async distance(e){const t=await he(this.link,`/sessions/${e}/depth?channel=distance`);if(t.status===204||!t.ok||t.headers.get("X-Format")!=="float32-zlib")return;const s=Number(t.headers.get("X-Width")),i=Number(t.headers.get("X-Height")),o=Number(t.headers.get("X-Version")),a=await new Response(t.body.pipeThrough(new DecompressionStream("deflate"))).arrayBuffer();return{version:o,width:s,height:i,data:new Float32Array(a)}}async depth(e){const t=await he(this.link,`/sessions/${e}/depth`);if(t.status===204||!t.ok)return;const s=Number(t.headers.get("X-Width")),i=Number(t.headers.get("X-Height")),o=Number(t.headers.get("X-Version")),a=t.body.pipeThrough(new DecompressionStream("deflate")),r=new Uint8Array(await new Response(a).arrayBuffer());return{version:o,width:s,height:i,data:Bs(new Uint16Array(r.buffer,r.byteOffset,r.byteLength>>1))}}}function bi(n,e){const t=Bs(n);for(let s=0;s<t.length;++s)t[s]=t[s]<0?-1:t[s]*e;return t}function Bs(n){const e=new Float32Array(n.length);for(let t=0;t<n.length;++t){const s=n[t],i=s&32768?-1:1,o=s>>10&31,a=s&1023;e[t]=o===0?i*a*2**-24:o===31?a?NaN:i*(1/0):i*(1+a/1024)*2**(o-15)}return e}const ye=250,Vs=`
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
}`,xi=`#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`,Ti=n=>`#version 300 es
precision highp float;
uniform highp sampler2D uDepth;
uniform vec4 uViewport;
uniform float uHasDepth;
${Vs}
layout(location = ${n.color}) out vec4 out_color;
layout(location = ${n.z}) out highp vec4 out_z;
layout(location = ${n.pick}) out highp vec4 out_pickId;
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
}`,Ei=`#version 300 es
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
}`,Si=n=>`#version 300 es
precision highp float;
${Vs}
in vec2 vUv;
in float vValid;
layout(location = ${n.color}) out vec4 out_color;
layout(location = ${n.z}) out highp vec4 out_z;
layout(location = ${n.pick}) out highp vec4 out_pickId;
void main() {
  if (vValid < 0.999 || liveHere()) discard;
  vec4 c = picture(vUv);
  if (c.a < 0.5) discard;
  out_color = vec4(c.rgb / max(c.a, 1e-3), 1.0);
  out_z = vec4(1.0 - gl_FragCoord.z);
  out_pickId = vec4(0.0);
}`;function Gs(n){const e=Array.from(n),t=new Array(16).fill(0);t[0]=e[5]*e[10]*e[15]-e[5]*e[11]*e[14]-e[9]*e[6]*e[15]+e[9]*e[7]*e[14]+e[13]*e[6]*e[11]-e[13]*e[7]*e[10],t[4]=-e[4]*e[10]*e[15]+e[4]*e[11]*e[14]+e[8]*e[6]*e[15]-e[8]*e[7]*e[14]-e[12]*e[6]*e[11]+e[12]*e[7]*e[10],t[8]=e[4]*e[9]*e[15]-e[4]*e[11]*e[13]-e[8]*e[5]*e[15]+e[8]*e[7]*e[13]+e[12]*e[5]*e[11]-e[12]*e[7]*e[9],t[12]=-e[4]*e[9]*e[14]+e[4]*e[10]*e[13]+e[8]*e[5]*e[14]-e[8]*e[6]*e[13]-e[12]*e[5]*e[10]+e[12]*e[6]*e[9],t[1]=-e[1]*e[10]*e[15]+e[1]*e[11]*e[14]+e[9]*e[2]*e[15]-e[9]*e[3]*e[14]-e[13]*e[2]*e[11]+e[13]*e[3]*e[10],t[5]=e[0]*e[10]*e[15]-e[0]*e[11]*e[14]-e[8]*e[2]*e[15]+e[8]*e[3]*e[14]+e[12]*e[2]*e[11]-e[12]*e[3]*e[10],t[9]=-e[0]*e[9]*e[15]+e[0]*e[11]*e[13]+e[8]*e[1]*e[15]-e[8]*e[3]*e[13]-e[12]*e[1]*e[11]+e[12]*e[3]*e[9],t[13]=e[0]*e[9]*e[14]-e[0]*e[10]*e[13]-e[8]*e[1]*e[14]+e[8]*e[2]*e[13]+e[12]*e[1]*e[10]-e[12]*e[2]*e[9],t[2]=e[1]*e[6]*e[15]-e[1]*e[7]*e[14]-e[5]*e[2]*e[15]+e[5]*e[3]*e[14]+e[13]*e[2]*e[7]-e[13]*e[3]*e[6],t[6]=-e[0]*e[6]*e[15]+e[0]*e[7]*e[14]+e[4]*e[2]*e[15]-e[4]*e[3]*e[14]-e[12]*e[2]*e[7]+e[12]*e[3]*e[6],t[10]=e[0]*e[5]*e[15]-e[0]*e[7]*e[13]-e[4]*e[1]*e[15]+e[4]*e[3]*e[13]+e[12]*e[1]*e[7]-e[12]*e[3]*e[5],t[14]=-e[0]*e[5]*e[14]+e[0]*e[6]*e[13]+e[4]*e[1]*e[14]-e[4]*e[2]*e[13]-e[12]*e[1]*e[6]+e[12]*e[2]*e[5],t[3]=-e[1]*e[6]*e[11]+e[1]*e[7]*e[10]+e[5]*e[2]*e[11]-e[5]*e[3]*e[10]-e[9]*e[2]*e[7]+e[9]*e[3]*e[6],t[7]=e[0]*e[6]*e[11]-e[0]*e[7]*e[10]-e[4]*e[2]*e[11]+e[4]*e[3]*e[10]+e[8]*e[2]*e[7]-e[8]*e[3]*e[6],t[11]=-e[0]*e[5]*e[11]+e[0]*e[7]*e[9]+e[4]*e[1]*e[11]-e[4]*e[3]*e[9]-e[8]*e[1]*e[7]+e[8]*e[3]*e[5],t[15]=e[0]*e[5]*e[10]-e[0]*e[6]*e[9]-e[4]*e[1]*e[10]+e[4]*e[2]*e[9]+e[8]*e[1]*e[6]-e[8]*e[2]*e[5];const s=e[0]*t[0]+e[1]*t[4]+e[2]*t[8]+e[3]*t[12];return Float32Array.from(t.map(i=>i/(s||1)))}const _i=.08;function et(n,e){let t=0;for(let s=0;s<16;++s)t=Math.max(t,Math.abs(n[s]));for(let s=0;s<16;++s)if(Math.abs(n[s]-e[s])>1e-5*Math.max(t,1e-12))return!1;return!0}function Pi(n,e){return n===void 0?!1:n.view===void 0||e.view===void 0?n.view===e.view&&n.bitmap.width===e.bitmap.width&&n.bitmap.height===e.bitmap.height:et(n.view.invViewProjection,e.view.invViewProjection)}class Ri{onFrame;onFading;live;look="";pictureAtRest=!0;liveAlone=!1;coverStart;split=0;prevColor;prevAlpha;prevHasAlpha=!1;fadeStart;picture;uploaded;uploadedDepth;uploadedAlpha;gl;program;programFor="";vao;color;depth;alpha;dist;uploadedDist;mesh;meshFor="";grid;set(e){const t=this.picture;this.picture=e,t!==void 0&&t!==e&&t!==this.uploaded&&t.bitmap.close?.()}placed(){return this.picture?.view?.invViewProjection}stats={placed:0,flat:0,flatMoving:0,live:0};isOf(e,t){return e.camera!==void 0&&et(e.camera,t.invViewProjection)&&(e.look===void 0||e.look===this.look)}isReady(){return this.picture!==void 0}draw(e){this.onFrame?.(e);const t=this.picture,s=this.live?.ready()?this.live:void 0;if(s!==void 0&&(!this.pictureAtRest||t===void 0||!this.isOf(t,e))&&s.draw(e,1)){this.stats.live++,this.liveAlone=!0,this.coverStart=void 0;return}if(t===void 0)return;this.liveAlone&&(this.liveAlone=!1,this.coverStart=s!==void 0?performance.now():void 0);const i=this.coverStart===void 0?1:Math.min(1,(performance.now()-this.coverStart)/ye),o=1-i*i*(3-2*i);this.split=o>0&&s!==void 0&&s.draw(e,o)?o:0;const a=e.gl;this.gl!==a&&this.reset(a);const r=this.compile(a,e.outputs);if(r===void 0)return;if(this.uploaded!==t){Pi(this.uploaded,t)?((this.fadeStart===void 0||performance.now()-this.fadeStart>=ye)&&([this.prevColor,this.color]=[this.color,this.prevColor],[this.prevAlpha,this.alpha]=[this.alpha,this.prevAlpha],this.prevHasAlpha=this.uploaded.alpha!==void 0,this.fadeStart=performance.now()),this.uploadedAlpha=void 0):this.fadeStart=void 0,a.activeTexture(a.TEXTURE0),a.bindTexture(a.TEXTURE_2D,this.color),a.pixelStorei(a.UNPACK_FLIP_Y_WEBGL,!1),a.pixelStorei(a.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),a.texImage2D(a.TEXTURE_2D,0,a.RGBA8,a.RGBA,a.UNSIGNED_BYTE,t.bitmap);const c=this.uploaded;this.uploaded=t,c!==void 0&&c!==this.picture&&c.bitmap.close?.()}if(t.depth!==void 0&&this.uploadedDepth!==t.depth&&(a.activeTexture(a.TEXTURE1),a.bindTexture(a.TEXTURE_2D,this.depth),a.pixelStorei(a.UNPACK_ALIGNMENT,4),a.texImage2D(a.TEXTURE_2D,0,a.R32F,t.depth.width,t.depth.height,0,a.RED,a.FLOAT,t.depth.data),this.uploadedDepth=t.depth),t.alpha!==void 0&&this.uploadedAlpha!==t.alpha&&(a.activeTexture(a.TEXTURE2),a.bindTexture(a.TEXTURE_2D,this.alpha),a.pixelStorei(a.UNPACK_ALIGNMENT,1),a.texImage2D(a.TEXTURE_2D,0,a.R8,t.alpha.width,t.alpha.height,0,a.RED,a.UNSIGNED_BYTE,t.alpha.data),a.pixelStorei(a.UNPACK_ALIGNMENT,4),this.uploadedAlpha=t.alpha),t.view!==void 0&&this.drawMesh(a,e,t)){this.stats.placed++,this.fadeOn();return}this.stats.flat++,e.moving&&this.stats.flatMoving++,a.useProgram(r),this.bindMix(a,r);const l=a.getParameter(a.VIEWPORT);a.uniform4f(a.getUniformLocation(r,"uViewport"),l[0],l[1],l[2],l[3]),a.uniform1f(a.getUniformLocation(r,"uHasDepth"),t.depth!==void 0?1:0),a.uniform1f(a.getUniformLocation(r,"uHasAlpha"),t.alpha!==void 0?1:0),a.activeTexture(a.TEXTURE0),a.bindTexture(a.TEXTURE_2D,this.color),a.uniform1i(a.getUniformLocation(r,"uColor"),0),a.activeTexture(a.TEXTURE1),a.bindTexture(a.TEXTURE_2D,this.depth),a.uniform1i(a.getUniformLocation(r,"uDepth"),1),a.activeTexture(a.TEXTURE2),a.bindTexture(a.TEXTURE_2D,this.alpha),a.uniform1i(a.getUniformLocation(r,"uAlpha"),2),a.bindVertexArray(this.vao),a.drawArrays(a.TRIANGLES,0,3),a.bindVertexArray(null),a.activeTexture(a.TEXTURE0),this.fadeOn()}bindMix(e,t){const s=this.fadeStart===void 0?1:Math.min(1,(performance.now()-this.fadeStart)/ye);e.uniform1f(e.getUniformLocation(t,"uMix"),s*s*(3-2*s)),e.uniform1f(e.getUniformLocation(t,"uSplit"),this.split),e.uniform1f(e.getUniformLocation(t,"uPrevHasAlpha"),this.prevHasAlpha?1:0),e.activeTexture(e.TEXTURE4),e.bindTexture(e.TEXTURE_2D,this.prevColor),e.uniform1i(e.getUniformLocation(t,"uPrevColor"),4),e.activeTexture(e.TEXTURE5),e.bindTexture(e.TEXTURE_2D,this.prevAlpha),e.uniform1i(e.getUniformLocation(t,"uPrevAlpha"),5)}fadeOn(){const e=performance.now();this.fadeStart!==void 0&&e-this.fadeStart>=ye&&(this.fadeStart=void 0),this.coverStart!==void 0&&e-this.coverStart>=ye&&(this.coverStart=void 0),(this.fadeStart!==void 0||this.coverStart!==void 0)&&requestAnimationFrame(()=>this.onFading?.())}drawMesh(e,t,s){const i=s.view,o=i.distance.width,a=i.distance.height,r=JSON.stringify(t.outputs);if(this.mesh===void 0||this.meshFor!==r)try{this.mesh&&e.deleteProgram(this.mesh),this.mesh=void 0,this.mesh=this.link(e,Ei,Si(t.outputs)),this.meshFor=r}catch{return!1}this.uploadedDist!==i&&(e.activeTexture(e.TEXTURE3),e.bindTexture(e.TEXTURE_2D,this.dist),e.pixelStorei(e.UNPACK_ALIGNMENT,4),e.texImage2D(e.TEXTURE_2D,0,e.R32F,o,a,0,e.RED,e.FLOAT,i.distance.data),this.uploadedDist=i);const l=o*a>4e5?2:1,c=Math.floor((o-1)/l)+1,u=Math.floor((a-1)/l)+1,d=`${c}x${u}`;if(this.grid?.key!==d){const v=new Uint32Array((c-1)*(u-1)*6);let w=0;for(let y=0;y<u-1;++y)for(let P=0;P<c-1;++P){const T=y*c+P;v.set([T,T+1,T+c,T+1,T+c+1,T+c],w),w+=6}const _=this.grid?.buffer??e.createBuffer();e.bindVertexArray(this.vao),e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,_),e.bufferData(e.ELEMENT_ARRAY_BUFFER,v,e.STATIC_DRAW),e.bindVertexArray(null),this.grid={key:d,buffer:_,count:v.length,cols:c,step:l}}const f=this.mesh;e.useProgram(f),this.bindMix(e,f);const m=v=>e.getUniformLocation(f,v);return e.uniformMatrix4fv(m("uOldInv"),!1,Float32Array.from(i.invViewProjection)),e.uniformMatrix4fv(m("uNewVP"),!1,Gs(t.invViewProjection)),e.uniform2i(m("uSize"),o,a),e.uniform1i(m("uStep"),l),e.uniform1i(m("uCols"),c),e.uniform1f(m("uJump"),et(i.invViewProjection,t.invViewProjection)?1e9:_i),e.uniform1f(m("uHasAlpha"),s.alpha!==void 0?1:0),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.color),e.uniform1i(m("uColor"),0),e.activeTexture(e.TEXTURE2),e.bindTexture(e.TEXTURE_2D,this.alpha),e.uniform1i(m("uAlpha"),2),e.activeTexture(e.TEXTURE3),e.bindTexture(e.TEXTURE_2D,this.dist),e.uniform1i(m("uDist"),3),e.bindVertexArray(this.vao),e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,this.grid.buffer),e.drawElements(e.TRIANGLES,this.grid.count,e.UNSIGNED_INT,0),e.bindVertexArray(null),e.activeTexture(e.TEXTURE0),!0}link(e,t,s){const i=(r,l)=>{const c=e.createShader(r);if(e.shaderSource(c,l),e.compileShader(c),!e.getShaderParameter(c,e.COMPILE_STATUS))throw new Error(e.getShaderInfoLog(c)??"shader");return c},o=e.createProgram(),a=[i(e.VERTEX_SHADER,t),i(e.FRAGMENT_SHADER,s)];for(const r of a)e.attachShader(o,r);e.linkProgram(o);for(const r of a)e.deleteShader(r);if(!e.getProgramParameter(o,e.LINK_STATUS)){const r=e.getProgramInfoLog(o);throw e.deleteProgram(o),new Error(r??"link")}return o}reset(e){this.gl=e,this.program=void 0,this.programFor="",this.uploaded=void 0,this.uploadedDepth=void 0,this.uploadedAlpha=void 0,this.uploadedDist=void 0,this.mesh=void 0,this.meshFor="",this.grid=void 0,this.vao=e.createVertexArray();const t=s=>{const i=e.createTexture();return e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,s),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,s),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),i};this.color=t(e.LINEAR),this.depth=t(e.NEAREST),this.alpha=t(e.LINEAR),this.prevColor=t(e.LINEAR),this.prevAlpha=t(e.LINEAR),this.fadeStart=void 0,this.dist=t(e.NEAREST)}compile(e,t){const s=JSON.stringify(t);return this.program!==void 0&&this.programFor===s?this.program:(this.program!==void 0&&e.deleteProgram(this.program),this.program=void 0,this.program=this.link(e,xi,Ti(t)),this.programFor=s,this.program)}dispose(){for(const t of[this.picture,this.uploaded])t?.bitmap.close?.();this.picture=void 0,this.uploaded=void 0;const e=this.gl;if(e!==void 0){this.program&&e.deleteProgram(this.program);for(const t of[this.color,this.depth,this.alpha,this.dist,this.prevColor,this.prevAlpha])t&&e.deleteTexture(t);this.mesh&&e.deleteProgram(this.mesh),this.vao&&e.deleteVertexArray(this.vao),this.grid&&e.deleteBuffer(this.grid.buffer),this.grid=void 0,this.gl=void 0}}}const Xs=12,Ai=["still","movie","splat"],Mi=["queued","running","done","failed","cancelled","gone"];function Ee(n){return n!=="queued"&&n!=="running"}function ki(n){return Array.isArray(n)?n.filter(e=>!!e&&typeof e=="object"&&Ai.includes(e.kind)&&typeof e.id=="string"&&typeof e.host=="string").map(e=>({kind:e.kind,id:e.id,host:e.host,name:typeof e.name=="string"?e.name:e.kind,status:Mi.includes(e.status)?e.status:"gone",progress:typeof e.progress=="number"&&Number.isFinite(e.progress)?e.progress:0,message:typeof e.message=="string"?e.message:"",...typeof e.error=="string"?{error:e.error}:{},...Array.isArray(e.files)?{files:e.files.filter(t=>typeof t=="string")}:{},...typeof e.ahead=="number"&&Number.isFinite(e.ahead)?{ahead:e.ahead}:{},started:typeof e.started=="number"?e.started:0})).slice(-Xs):[]}function Li(n,e){const t=i=>i.kind===e.kind&&i.id===e.id&&i.host===e.host,s=n.some(t)?n.map(i=>t(i)?e:i):[...n,e];for(;s.length>Xs;){const i=s.findIndex(o=>Ee(o.status));s.splice(i>=0?i:0,1)}return s}function Fi(n,e){return n.filter(t=>!(t.kind===e.kind&&t.id===e.id&&t.host===e.host))}function tt(n){return n.status==="queued"?n.ahead!==void 0?n.ahead>0?`waiting, ${n.ahead} job${n.ahead===1?"":"s"} ahead`:"waiting, next to start":n.message?/^waiting/i.test(n.message)?n.message:`waiting, ${n.message}`:"waiting":/^waiting for GPU memory/i.test(n.message)?n.message:`${Math.round(n.progress*100)}%${n.message?`, ${n.message}`:""}`}function Ui(n){switch(n.status){case"queued":case"running":return`${n.name}: ${tt(n)}`;case"done":return`${n.name}: done`;case"failed":return`${n.name}: failed${n.error?` (${n.error})`:""}`;case"cancelled":return`${n.name}: cancelled`;case"gone":return`${n.name}: no longer on ${n.host}`}}const N={minSide:8,maxSide:8192,maxSamples:4096,maxFps:120,maxBoxes:8,maxClips:6,stillWork:8192*8192*256};function ae(n,e,t){return Number.isFinite(n)?Math.min(t,Math.max(e,Math.round(n))):e}function me(n){const e=ae(n,N.minSide,N.maxSide);return e-e%2}function Ke(n){return{...n,fps:ae(n.fps,1,N.maxFps),width:me(n.width),height:me(n.height),samples:ae(n.samples,1,N.maxSamples)}}function Di(n,e,t){if(!(n*e*t<=N.stillWork))return`A ${n} × ${e} still at ${t} samples is too large: use fewer samples or a smaller size.`}function Ci(n,e,t){const s=e-n,i=t!==void 0&&t.startsWith("float");if(!(s>0)||!Number.isFinite(s))return i?.001:1;const o=s/1e3,a=10**Math.floor(Math.log10(o)),r=[1,2,5,10].map(l=>l*a).find(l=>l>=o*.999)??o;return i?r:Math.max(1,Math.round(r))}const xs=[1e3,2e3,4e3,8e3,15e3,3e4];function Ii(n){return n>=1&&n<=xs.length?xs[n-1]:void 0}const qe=.28209479177387814;function Hs(n,e){const t=Math.hypot(e[0],e[1],e[2],e[3])||1,s=e[0]/t,i=e[1]/t,o=e[2]/t,a=e[3]/t,r=[1-2*(o*o+a*a),2*(i*o-s*a),2*(i*a+s*o),2*(i*o+s*a),1-2*(i*i+a*a),2*(o*a-s*i),2*(i*a-s*o),2*(o*a+s*i),1-2*(i*i+o*o)],l=[0,1,2].flatMap(u=>[0,1,2].map(d=>r[u*3+d]*n[d])),c=(u,d)=>l[u*3]*l[d*3]+l[u*3+1]*l[d*3+1]+l[u*3+2]*l[d*3+2];return[c(0,0),c(0,1),c(0,2),c(1,1),c(1,2),c(2,2)]}function Ts(n){const e=Math.floor(n.byteLength/32),t=new Float32Array(n,0,e*8),s=new Uint8Array(n,0,e*32),i=js(e);for(let o=0;o<e;++o){i.positions.set(t.subarray(o*8,o*8+3),o*3);const a=[0,1,2,3].map(r=>(s[o*32+28+r]-128)/128);i.covariances.set(Hs(t.subarray(o*8+3,o*8+6),a),o*6),i.colors.set(s.subarray(o*32+24,o*32+28),o*4)}return i}function zi(n){const e=new Uint8Array(n),t=new TextEncoder().encode(`end_header
`);let s=-1;for(let f=0;f+t.length<=Math.min(e.length,65536);++f)if(t.every((m,v)=>e[f+v]===m)){s=f+t.length;break}if(s<0)throw new Error("not a PLY file (no end_header)");const i=new TextDecoder().decode(e.subarray(0,s));if(!/format binary_little_endian/.test(i))throw new Error("only binary little-endian PLY files are read");const o=Number(/element vertex (\d+)/.exec(i)?.[1]??NaN),a=[...i.matchAll(/^property (\w+) (\w+)$/gm)].map(f=>({type:f[1],name:f[2]}));if(!Number.isFinite(o)||a.some(f=>f.type!=="float"))throw new Error("a splat PLY has only float properties");const r=Object.fromEntries(a.map((f,m)=>[f.name,m]));for(const f of["x","y","z","f_dc_0","f_dc_1","f_dc_2","opacity","scale_0","scale_1","scale_2","rot_0","rot_1","rot_2","rot_3"])if(!(f in r))throw new Error(`the PLY has no ${f}: not a Gaussian splat`);const l=a.length,c=new Float32Array(n.slice(s,s+o*l*4)),u=js(o),d=f=>Math.max(0,Math.min(255,Math.round(f*255)));for(let f=0;f<o;++f){const m=v=>c[f*l+r[v]];u.positions.set([m("x"),m("y"),m("z")],f*3),u.covariances.set(Hs([Math.exp(m("scale_0")),Math.exp(m("scale_1")),Math.exp(m("scale_2"))],[m("rot_0"),m("rot_1"),m("rot_2"),m("rot_3")]),f*6),u.colors.set([d(.5+qe*m("f_dc_0")),d(.5+qe*m("f_dc_1")),d(.5+qe*m("f_dc_2")),d(1/(1+Math.exp(-m("opacity"))))],f*4)}return u}function js(n){return{count:n,positions:new Float32Array(n*3),covariances:new Float32Array(n*6),colors:new Uint8Array(n*4)}}function Oi(n,e,t,s=new Uint32Array(e)){const i=new Float32Array(e);let o=1/0,a=-1/0;for(let d=0;d<e;++d){const f=t[2]*n[d*3]+t[6]*n[d*3+1]+t[10]*n[d*3+2]+t[14];i[d]=f,f<o&&(o=f),f>a&&(a=f)}const r=65536,l=a>o?(r-1)/(a-o):0,c=new Uint16Array(e),u=new Uint32Array(r);for(let d=0;d<e;++d)c[d]=(i[d]-o)*l,u[c[d]]++;for(let d=1;d<r;++d)u[d]+=u[d-1];for(let d=e-1;d>=0;--d)s[--u[c[d]]]=d;return s}function Ni(n,e,t){const s=oe(Se(e,n)),i=oe(Pe(s,t)),o=Pe(i,s),a=[i,o.map(l=>-l),s],r=new Float32Array(16);for(let l=0;l<3;++l){for(let c=0;c<3;++c)r[c*4+l]=a[l][c];r[12+l]=-(a[l][0]*n[0]+a[l][1]*n[1]+a[l][2]*n[2])}return r[15]=1,r}const Se=(n,e)=>[n[0]-e[0],n[1]-e[1],n[2]-e[2]],se=(n,e)=>[n[0]+e[0],n[1]+e[1],n[2]+e[2]],J=(n,e)=>[n[0]*e,n[1]*e,n[2]*e],Ws=(n,e)=>n[0]*e[0]+n[1]*e[1]+n[2]*e[2],Pe=(n,e)=>[n[1]*e[2]-n[2]*e[1],n[2]*e[0]-n[0]*e[2],n[0]*e[1]-n[1]*e[0]],oe=n=>J(n,1/(Math.hypot(n[0],n[1],n[2])||1)),Je=(n,e,t)=>{const s=Math.cos(t),i=Math.sin(t);return se(se(J(n,s),J(Pe(e,n),i)),J(e,Ws(e,n)*(1-s)))},$i=`#version 300 es
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
}`,Bi=`#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vPos;
out vec4 fragColor;
void main() {
  float A = -dot(vPos, vPos);
  if (A < -4.0) discard;
  float B = exp(A) * vColor.a;
  fragColor = vec4(B * vColor.rgb, B);
}`;class Vi{constructor(e,t){this.splats=e,this.canvas=document.createElement("canvas"),this.canvas.className="ar-splat-canvas";const s=this.canvas.getContext("webgl2",{antialias:!1,premultipliedAlpha:!0});if(!s)throw new Error("this browser has no WebGL 2");this.gl=s,this.program=Gi(s,$i,Bi),this.order=new Uint32Array(e.count),this.upload();const i=s.createBuffer();s.bindBuffer(s.ARRAY_BUFFER,i),s.bufferData(s.ARRAY_BUFFER,new Float32Array([-2,-2,2,-2,-2,2,2,2]),s.STATIC_DRAW);const o=s.createVertexArray();s.bindVertexArray(o);const a=s.getAttribLocation(this.program,"aCorner");s.enableVertexAttribArray(a),s.vertexAttribPointer(a,2,s.FLOAT,!1,0,0),this.indexBuffer=s.createBuffer(),s.bindBuffer(s.ARRAY_BUFFER,this.indexBuffer),s.bufferData(s.ARRAY_BUFFER,this.order,s.DYNAMIC_DRAW);const r=s.getAttribLocation(this.program,"aIndex");s.enableVertexAttribArray(r),s.vertexAttribIPointer(r,1,s.UNSIGNED_INT,0,0),s.vertexAttribDivisor(r,1),this.start=t??this.framing(),this.reset(),this.controls()}canvas;gl;program;order;indexBuffer;eye=[0,0,1];target=[0,0,0];up=[0,-1,0];fovy=30;start;frame=0;sortedFor="";offs=[];reset(){const e=this.start,t=e.c2w;this.eye=[t[0][3],t[1][3],t[2][3]];const s=[t[0][2],t[1][2],t[2][2]],i=Math.max(1e-6,Ws(Se(e.centre,this.eye),s));this.target=se(this.eye,J(s,i)),this.up=[-t[0][1],-t[1][1],-t[2][1]],this.fovy=e.fovy,this.redraw()}framing(){const e=this.splats.positions,t=[1/0,1/0,1/0],s=[-1/0,-1/0,-1/0];for(let r=0;r<this.splats.count;++r)for(let l=0;l<3;++l)t[l]=Math.min(t[l],e[r*3+l]),s[l]=Math.max(s[l],e[r*3+l]);const i=J(se(t,s),.5),a=Math.max(.001,Math.hypot(...Se(s,t))/2)/Math.sin(30*Math.PI/360)*1.1;return{c2w:[[1,0,0,i[0]],[0,0,1,i[1]-a],[0,-1,0,i[2]],[0,0,0,1]],fovy:30,centre:i}}upload(){const e=this.gl,t=this.splats.count,s=2048,i=Math.max(1,Math.ceil(t/s)),o=new Float32Array(s*i*4),a=new Float32Array(s*i*4),r=new Float32Array(s*i*4),l=new Uint8Array(s*i*4),{positions:c,covariances:u,colors:d}=this.splats;for(let m=0;m<t;++m)o[m*4]=c[m*3],o[m*4+1]=c[m*3+1],o[m*4+2]=c[m*3+2],a[m*4]=u[m*6],a[m*4+1]=u[m*6+1],a[m*4+2]=u[m*6+2],a[m*4+3]=u[m*6+3],r[m*4]=u[m*6+4],r[m*4+1]=u[m*6+5];l.set(d),e.useProgram(this.program),[["uPos",e.RGBA32F,e.RGBA,e.FLOAT,o],["uCovA",e.RGBA32F,e.RGBA,e.FLOAT,a],["uCovB",e.RGBA32F,e.RGBA,e.FLOAT,r],["uColor",e.RGBA8,e.RGBA,e.UNSIGNED_BYTE,l]].forEach(([m,v,w,_,y],P)=>{const T=e.createTexture();e.activeTexture(e.TEXTURE0+P),e.bindTexture(e.TEXTURE_2D,T),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texImage2D(e.TEXTURE_2D,0,v,s,i,0,w,_,y),e.uniform1i(e.getUniformLocation(this.program,m),P)})}controls(){const e=this.canvas;let t;const s=c=>{t={x:c.clientX,y:c.clientY,pan:c.button===2||c.shiftKey},e.setPointerCapture(c.pointerId),e.classList.add("grabbing")},i=c=>{if(!t)return;const u=c.clientX-t.x,d=c.clientY-t.y;t={...t,x:c.clientX,y:c.clientY};const f=Se(this.eye,this.target),m=oe(J(f,-1)),v=oe(Pe(m,this.up));if(t.pan){const w=Math.hypot(...f)*2*Math.tan(this.fovy*Math.PI/360)/Math.max(1,e.clientHeight),_=se(J(v,-u*w),J(this.up,d*w));this.eye=se(this.eye,_),this.target=se(this.target,_)}else{let w=Je(f,oe(this.up),-u*.006);const _=oe(Pe(oe(J(w,-1)),this.up));w=Je(w,_,-d*.006),this.up=oe(Je(this.up,_,-d*.006)),this.eye=se(this.target,w)}this.redraw()},o=c=>{t=void 0,e.releasePointerCapture(c.pointerId),e.classList.remove("grabbing")},a=c=>{c.preventDefault();const u=Se(this.eye,this.target);this.eye=se(this.target,J(u,Math.exp(Math.max(-1,Math.min(1,c.deltaY*.0015))))),this.redraw()},r=c=>c.preventDefault();e.addEventListener("pointerdown",s),e.addEventListener("pointermove",i),e.addEventListener("pointerup",o),e.addEventListener("wheel",a,{passive:!1}),e.addEventListener("contextmenu",r);const l=new ResizeObserver(()=>this.redraw());l.observe(e),this.offs.push(()=>l.disconnect())}redraw(){this.frame||(this.frame=requestAnimationFrame(()=>{this.frame=0,this.draw()}))}draw(){const e=this.gl,t=this.canvas,s=Math.min(2,window.devicePixelRatio||1),i=Math.max(1,Math.round(t.clientWidth*s)),o=Math.max(1,Math.round(t.clientHeight*s));(t.width!==i||t.height!==o)&&(t.width=i,t.height=o);const a=Ni(this.eye,this.target,this.up),r=Array.from(a,c=>c.toFixed(4)).join();r!==this.sortedFor&&(Oi(this.splats.positions,this.splats.count,a,this.order),e.bindBuffer(e.ARRAY_BUFFER,this.indexBuffer),e.bufferSubData(e.ARRAY_BUFFER,0,this.order),this.sortedFor=r);const l=o/2/Math.tan(this.fovy*Math.PI/360);e.viewport(0,0,i,o),e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT),e.useProgram(this.program),e.uniformMatrix4fv(e.getUniformLocation(this.program,"uView"),!1,a),e.uniform2f(e.getUniformLocation(this.program,"uFocal"),l,l),e.uniform2f(e.getUniformLocation(this.program,"uViewport"),i,o),e.enable(e.BLEND),e.blendFuncSeparate(e.ONE_MINUS_DST_ALPHA,e.ONE,e.ONE_MINUS_DST_ALPHA,e.ONE),e.disable(e.DEPTH_TEST),e.drawArraysInstanced(e.TRIANGLE_STRIP,0,4,this.splats.count)}dispose(){this.frame&&cancelAnimationFrame(this.frame);for(const e of this.offs)e();this.gl.getExtension("WEBGL_lose_context")?.loseContext()}}function Gi(n,e,t){const s=(o,a)=>{const r=n.createShader(o);if(n.shaderSource(r,a),n.compileShader(r),!n.getShaderParameter(r,n.COMPILE_STATUS))throw new Error(`splat shader: ${n.getShaderInfoLog(r)}`);return r},i=n.createProgram();if(n.attachShader(i,s(n.VERTEX_SHADER,e)),n.attachShader(i,s(n.FRAGMENT_SHADER,t)),n.linkProgram(i),!n.getProgramParameter(i,n.LINK_STATUS))throw new Error(`splat program: ${n.getProgramInfoLog(i)}`);return i}function Es(n,e,t,s,i=[]){return n(e,o=>{let a;const r=x("div",{class:"ar-splat"});o.append(x("div",{class:"row"},x("span",{class:"readout spacer"},`${t.count.toLocaleString()} Gaussians`),fe("Drag to turn, right or Shift drag to move, the wheel to come closer.","About moving the view"),C("Reset view",()=>a?.reset()),...i.map(([l,c])=>C(l,c))),r);try{a=new Vi(t,s),r.append(a.canvas)}catch(l){r.append(x("p",{class:"empty error"},l.message))}return()=>a?.dispose()},{wide:!0})}function st(n,e){if(!e||e.length===0)return n;const t=[...e].sort((i,o)=>i.from-o.from);if(n<=t[0].from)return t[0].to+(n-t[0].from);for(let i=1;i<t.length;++i)if(n<=t[i].from)return t[i-1].to+(n-t[i-1].from)*(t[i].to-t[i-1].to)/(t[i].from-t[i-1].from||1);const s=t[t.length-1];return s.to+(n-s.from)}function Xi(n,e){return st(n,e?.map(t=>({from:t.to,to:t.from})))}function Hi(n,e,t,s=[.1,.3,.5,.7,.9]){const i=n.counts.length,o=(n.hi-n.lo)/i,a=n.counts.map((d,f)=>({v:n.lo+(f+.5)*o,c:d})).filter(d=>d.v>=e&&d.v<=t),r=a.reduce((d,f)=>d+f.c,0);if(!r)return s.map(d=>e+d*(t-e));let l=0,c=0;const u=[];for(const d of a)for(l+=d.c;c<s.length&&l/r>=s[c];)u.push(d.v),++c;for(;u.length<s.length;)u.push(t);return u.map((d,f)=>f>0&&d<=u[f-1]?u[f-1]+(t-e)*.001:d)}function ji(n,e=14){if(n.length<=e)return n.map((i,o)=>o);const t=new Set([0,n.length-1]);for(let i=1;i<n.length;++i)if(n[i].tissue!==n[i-1].tissue&&(t.add(i-1),t.add(i)),i<n.length-1){const o=n[i].opacity-n[i-1].opacity,a=n[i+1].opacity-n[i].opacity;Math.abs(o-a)>.15&&t.add(i)}let s=[...t].sort((i,o)=>i-o);for(;s.length>e;){let i=1,o=1/0;for(let a=1;a<s.length-1;++a){const r=n[s[a+1]].value-n[s[a-1]].value;r<o&&([i,o]=[a,r])}s.splice(i,1)}if(s.length<Math.min(e,6)){const i=(n.length-1)/(Math.min(e,6)-1);s=[...new Set([...s,...Array.from({length:Math.min(e,6)},(o,a)=>Math.round(a*i))])].sort((o,a)=>o-a)}return s}function Wi(n,e,t,s){const i=e.indexOf(t),o=i>0?n[e[i-1]].value:-1/0,a=i<e.length-1?n[e[i+1]].value:1/0,r=Math.min(Math.max(s,o+1e-6),a-1e-6),l=n[t].value;return n.map((c,u)=>u===t?{...c,value:r}:i>0&&u>e[i-1]&&u<t?{...c,value:o+(c.value-o)*(r-o)/(l-o||1)}:i<e.length-1&&u>t&&u<e[i+1]?{...c,value:a-(a-c.value)*(a-r)/(a-l||1)}:i===0&&u<t?{...c,value:c.value+(r-l)}:i===e.length-1&&u>t?{...c,value:c.value+(r-l)}:c)}function Ss(n,e,t,s){const i=e.indexOf(t),o=i>0?e[i-1]:t,a=i<e.length-1?e[i+1]:t,r=n[t];return n.map((l,c)=>{if(c<o||c>a)return l;const u=c===t?1:c<t?(l.value-n[o].value)/(r.value-n[o].value||1):(n[a].value-l.value)/(n[a].value-r.value||1),d={...l};return s.opacity!==void 0&&(d.opacity=Math.min(1,Math.max(0,l.opacity+u*(s.opacity-r.opacity)))),s.color&&(d.color=l.color.map((f,m)=>Math.min(1,Math.max(0,f+u*(s.color[m]-r.color[m]))))),d})}function Ki(n,e,t,s){return e===0&&t===1?n:n.map(i=>({...i,value:s+(i.value-s)*t+e}))}function be(n,e,t){return(typeof getComputedStyle=="function"?getComputedStyle(n).getPropertyValue(e).trim():"")||t}const Ye=n=>"#"+n.map(e=>Math.round(Math.min(1,Math.max(0,e))*255).toString(16).padStart(2,"0")).join(""),qi=n=>[1,3,5].map(e=>parseInt(n.slice(e,e+2),16)/255);class Ji{constructor(e,t=()=>{}){this.onChange=e,this.onWarp=t,this.canvas=x("canvas",{class:"ar-editor",width:"420",height:"150","aria-label":"Colourmap over the image's histogram"}),this.element=this.canvas,this.canvas.addEventListener("pointerdown",s=>this.down(s)),this.canvas.addEventListener("pointermove",s=>this.move(s)),this.canvas.addEventListener("pointerup",()=>{this.drag=void 0,this.warpDrag=void 0}),this.canvas.addEventListener("dblclick",s=>this.recolour(s)),this.canvas.addEventListener("contextmenu",s=>this.remove(s))}element;canvas;stops=[];points=[];range=[0,1];counts=[];hlo=0;hhi=1;drag;warp=[];warpDrag;get dragging(){return this.drag!==void 0||this.warpDrag!==void 0}set(e,t,s=[]){if(this.dragging)return;this.warp=s.map(l=>({...l})),this.stops=t.map(l=>({...l})),this.points=ji(this.stops),e&&([this.counts,this.hlo,this.hhi]=[e.counts,e.lo,e.hi]);const o=(this.stops.filter(l=>l.opacity>.01)[0]??this.stops[0])?.value??this.hlo,a=this.stops[this.stops.length-1]?.value??this.hhi,r=(a-o)*.12||1;this.range=[o-r,a+r],this.draw()}x(e){return(e-this.range[0])/(this.range[1]-this.range[0])*this.canvas.width}v(e){return this.range[0]+e/this.canvas.width*(this.range[1]-this.range[0])}y(e){return 10+(1-e)*(this.canvas.height-40)}draw(){const e=this.canvas.getContext("2d"),t=this.canvas.width,s=this.canvas.height,i=this.canvas;if(e.fillStyle=be(i,"--ink-1","#0c0c0c"),e.fillRect(0,0,t,s),this.counts.length){const o=this.counts.length,a=Math.log1p(Math.max(...this.counts));e.fillStyle=be(i,"--plot","#777");for(let r=0;r<o;++r){const l=this.hlo+(this.hhi-this.hlo)*r/o,c=this.hlo+(this.hhi-this.hlo)*(r+1)/o,u=this.x(st(l,this.warp)),d=this.x(st(c,this.warp));if(d<0||u>t)continue;const f=Math.log1p(this.counts[r])/a*(s-40);e.fillRect(u,s-30-f,Math.max(1,d-u),f)}}for(let o=0;o<t;++o){const a=this.at(this.v(o));e.fillStyle=Ye(a.color.map(r=>Math.min(1,r*1.6))),e.fillRect(o,s-24,1,18)}e.strokeStyle=be(i,"--text","#dedede"),e.lineWidth=1.5,e.beginPath(),this.stops.forEach((o,a)=>a?e.lineTo(this.x(o.value),this.y(o.opacity)):e.moveTo(this.x(o.value),this.y(o.opacity))),e.stroke(),e.fillStyle=be(i,"--dec-z","#4f88dc");for(const o of this.warp){const a=this.x(o.to),r=s-30;e.beginPath(),e.moveTo(a,r-7),e.lineTo(a-5,r+2),e.lineTo(a+5,r+2),e.closePath(),e.fill()}for(const o of this.points){const a=this.stops[o];e.fillStyle=Ye(a.color.map(r=>Math.min(1,r*1.6))),e.strokeStyle=be(i,"--text-strong","#fff"),e.beginPath(),e.arc(this.x(a.value),this.y(a.opacity),5,0,Math.PI*2),e.fill(),e.stroke()}}at(e){const t=this.stops;if(!t.length)return{color:[0,0,0],opacity:0};if(e<=t[0].value)return{color:t[0].color,opacity:t[0].opacity};for(let i=1;i<t.length;++i)if(e<=t[i].value){const o=(e-t[i-1].value)/(t[i].value-t[i-1].value||1);return{color:t[i].color.map((a,r)=>t[i-1].color[r]+o*(a-t[i-1].color[r])),opacity:t[i-1].opacity+o*(t[i].opacity-t[i-1].opacity)}}const s=t[t.length-1];return{color:s.color,opacity:s.opacity}}pos(e){const t=this.canvas.getBoundingClientRect();return[(e.clientX-t.left)/t.width*this.canvas.width,(e.clientY-t.top)/t.height*this.canvas.height]}near(e){const[t,s]=this.pos(e);let i,o=9;for(const a of this.points){const r=Math.hypot(this.x(this.stops[a].value)-t,this.y(this.stops[a].opacity)-s);r<o&&([i,o]=[a,r])}return i}down(e){if(e.button!==0)return;const[t,s]=this.pos(e);if(s>this.canvas.height-40){let o=-1,a=9;if(this.warp.forEach((r,l)=>{const c=Math.abs(this.x(r.to)-t);c<a&&([o,a]=[l,c])}),o>=0){this.warpDrag=o,this.canvas.setPointerCapture(e.pointerId);return}}const i=this.near(e);if(i!==void 0){this.drag=i,this.canvas.setPointerCapture(e.pointerId);return}if(e.ctrlKey||e.metaKey){const[o]=this.pos(e),a=this.v(o),r=this.at(a),l=this.stops.findIndex(d=>d.value>a),c=l<0?this.stops.length:l,u=this.stops[Math.min(c,this.stops.length-1)];this.stops.splice(c,0,{...u,value:a,color:r.color,opacity:r.opacity}),this.points=[...new Set([...this.points.map(d=>d>=c?d+1:d),c])].sort((d,f)=>d-f),this.changed()}}move(e){if(this.warpDrag!==void 0){const[a]=this.pos(e),r=this.warpDrag,l=this.warp,c=r>0?l[r-1].to:-1/0,u=r<l.length-1?l[r+1].to:1/0,d=this.range[1]-this.range[0];l[r]={...l[r],to:Math.min(Math.max(this.v(a),c+d*.001),u-d*.001)},this.draw(),this.onWarp(this.warp.map(f=>({...f})));return}if(this.drag===void 0)return;const[t,s]=this.pos(e),i=this.drag;this.stops=Wi(this.stops,this.points,i,this.v(t));const o=Math.min(1,Math.max(0,1-(s-10)/(this.canvas.height-40)));this.stops=Ss(this.stops,this.points,i,{opacity:o}),this.changed()}recolour(e){const t=this.near(e);if(t===void 0)return;const s=x("input",{type:"color",value:Ye(this.stops[t].color)});s.oninput=()=>{this.stops=Ss(this.stops,this.points,t,{color:qi(s.value)}),this.changed()},s.click()}remove(e){const t=this.near(e);t!==void 0&&(e.preventDefault(),!(this.stops.length<=2)&&(this.stops.splice(t,1),this.points=this.points.filter(s=>s!==t).map(s=>s>t?s-1:s),this.changed()))}changed(){this.draw(),this.onChange(this.stops.map(e=>({...e})))}}class Ks{rpc=new oi(()=>ai(new Worker(new URL(""+new URL("volume_worker-Be8XgPid.js",import.meta.url).href,import.meta.url),{type:"module",name:"volume view"})),{stopped:e=>`the volume reader stopped: ${e}. Reload the page to try again`});request(e,t={}){const{progress:s,signal:i}=t;return this.rpc.request(e,{signal:i,progress:o=>o.type==="progress"&&s?.(o.done,o.total)})}open(e,t){return this.request({type:"open",stores:e,space:t})}volume(e,t,s,i){return this.request({type:"volume",level:e,region:i},{progress:t,signal:s})}dispose(){this.rpc.dispose()}}const Yi=[{name:"MR T1 brain",modality:"MR",description:"A T1-weighted brain: the cortex's surface in warm grey, white matter paler beneath it.",domain:"percentile",stops:[{value:0,color:[.55,.42,.38],opacity:0},{value:20,color:[.62,.45,.4],opacity:0},{value:40,color:[.8,.62,.55],opacity:.35},{value:70,color:[.9,.78,.7],opacity:.8},{value:99.5,color:[.98,.95,.9],opacity:1}],density:40,shade_mix:.85,gradient_scale:30,roughness:.5,specular:.12,albedo:.95},{name:"HiP-CT brain",modality:"HiP-CT",description:"A HiP-CT brain in fixative: tissue in ivory, vessels and dense structure brighter.",domain:"percentile",stops:[{value:0,color:[.75,.7,.62],opacity:0},{value:10,color:[.8,.74,.66],opacity:0},{value:30,color:[.88,.8,.7],opacity:.4},{value:70,color:[.95,.88,.78],opacity:.8},{value:99.9,color:[1,.97,.92],opacity:1}],density:40,shade_mix:.85,gradient_scale:30,roughness:.45,specular:.15,albedo:.95},{name:"Histology (BigBrain)",modality:"histology",description:"Merker-stained sections: tissue in stain blue-grey, darker where cells are dense.",domain:"percentile",stops:[{value:0,color:[.55,.58,.72],opacity:0},{value:10,color:[.55,.58,.72],opacity:0},{value:35,color:[.62,.64,.78],opacity:.5},{value:80,color:[.8,.8,.88],opacity:.85},{value:99.9,color:[.95,.95,.98],opacity:1}],density:40,shade_mix:.85,gradient_scale:30,roughness:.5,specular:.1,albedo:.95},{name:"Translucent tissue",modality:"",description:"Any volume as a translucent, scattering solid: deep structure shows through the surface.",domain:"percentile",stops:[{value:0,color:[.9,.75,.65],opacity:0},{value:15,color:[.9,.75,.65],opacity:0},{value:50,color:[.95,.8,.7],opacity:.05},{value:95,color:[1,.92,.85],opacity:.4},{value:99.9,color:[1,1,1],opacity:.8}],density:12,shade_mix:.3,gradient_scale:30,roughness:.6,specular:.05,phase_g:.3,albedo:.98},{name:"Regions (labels)",modality:"labels",description:"Each region of a co-registered segmentation in its own colour, on the image's tissue.",domain:"percentile",stops:[{value:0,color:[1,1,1],opacity:0},{value:15,color:[1,1,1],opacity:0},{value:40,color:[1,1,1],opacity:.6},{value:99.9,color:[1,1,1],opacity:1}],density:40,shade_mix:.85,gradient_scale:30,roughness:.5,specular:.1,albedo:.95}],Zi=[{name:"INVVP",size:16,about:"clip -> display (world) coordinates, column-major"},{name:"VP",size:16,about:"world -> clip, column-major"},{name:"VOX_FROM_WORLD",size:12,about:"3x4 row-major: voxel index coordinates (x fastest) from world"},{name:"WORLD_NORMAL",size:9,about:"3x3 row-major: the transpose of VOX_FROM_WORLD's linear part"},{name:"DIMS",size:3,about:"volume size in voxels, x, y, z"},{name:"BRICK",size:1,about:"majorant brick size in voxels"},{name:"MGRID",size:3,about:"majorant grid size, x, y, z"},{name:"DENSITY",size:1,about:"extinction per display unit at opacity 1"},{name:"SHADE_MIX",size:1,about:"0: volume scattering only .. 1: surfaces where gradients are strong"},{name:"GRAD_SCALE",size:1,about:"how quickly the gradient's magnitude makes a surface (per texture unit per voxel)"},{name:"ROUGHNESS",size:1,about:""},{name:"SPECULAR",size:1,about:""},{name:"PHASE_G",size:1,about:""},{name:"ALBEDO",size:1,about:"scales the transfer function's colour"},{name:"LIGHT_DIR",size:3,about:"direction towards the key light, world, unit"},{name:"LIGHT_RGB",size:3,about:"key light radiance (irradiance at normal incidence)"},{name:"ENV_TOP",size:3,about:'environment: colour above (world "up")'},{name:"ENV_HORIZON",size:3,about:""},{name:"ENV_BOTTOM",size:3,about:""},{name:"ENV_UP",size:3,about:"world up for the environment, unit"},{name:"ENV_SCALE",size:1,about:""},{name:"BG",size:4,about:"background shown where primary rays leave (alpha 0: transparent)"},{name:"EXPOSURE",size:1,about:""},{name:"MAX_BOUNCES",size:1,about:""},{name:"NCLIP",size:1,about:""},{name:"CLIPS",size:24,about:"up to 6 planes, (nx, ny, nz, d) in world: kept where n.x + d >= 0"},{name:"CROP_LO",size:3,about:"crop box in voxel coordinates (inclusive), x, y, z"},{name:"CROP_HI",size:3,about:""},{name:"HAS_LABELS",size:1,about:""},{name:"LABEL_FROM_WORLD",size:12,about:"3x4 row-major: label voxel coordinates from world"},{name:"LDIMS",size:3,about:""},{name:"NLUT",size:1,about:""},{name:"LABEL_MIX",size:1,about:"0: the transfer function's colour .. 1: the label's colour"},{name:"STEP",size:1,about:"depth pass: step in voxels"},{name:"FRAME",size:1,about:"pass number, for the random sequence"},{name:"APERTURE",size:1,about:"thin lens: aperture radius in display units (0: pinhole)"},{name:"FOCUS",size:1,about:"thin lens: focal distance in display units"},{name:"OPAQUE_LIMIT",size:1,about:"depth pass: accumulated opacity where the surface is"},{name:"ENVMAP",size:1,about:"1: the environment is a light map (a texture), 0: the three colours"},{name:"ENV_RIGHT",size:3,about:"light map frame: right (world, unit)"},{name:"ENV_BACK",size:3,about:"light map frame: back (world, unit); up is ENV_UP"},{name:"ENV_ROT",size:1,about:"light map turned about up, radians"},{name:"INSET",size:1,about:"voxels along the gradient at which a collision takes its colour, on the more opaque side (0: where it is), so a surface shows the tissue beneath it, not the values between it and the medium"},{name:"FAST",size:1,about:"1: frames while the camera moves; through dense bricks the tracking steps a voxel at a time, summing optical depth (approximate, its cost bounded by the voxels crossed, not the density), 0: exact delta and ratio tracking"},{name:"DETAIL",size:1,about:"1 when a finer level's region (the detail) is held beside the coarse level"},{name:"DETAIL_FROM_WORLD",size:12,about:"3x4 row-major: the detail's voxel index coordinates from world"},{name:"DETAIL_NORMAL",size:9,about:"3x3 row-major: the transpose of DETAIL_FROM_WORLD's linear part"},{name:"DETAIL_DIMS",size:3,about:"the detail's size in voxels, x, y, z"},{name:"DETAIL_MGRID",size:3,about:"the detail's majorant grid size, x, y, z"},{name:"DETAIL_GSCALE",size:1,about:"coarse voxel size over detail voxel size: gradients per detail voxel to per coarse voxel"},{name:"NBOX",size:1,about:"how many crops (up to 8)"},{name:"BOXES",size:56,about:"8 crops x (lo x, y, z; hi x, y, z, voxel coordinates; mode: 1 keeps the inside, -1 cuts it out)"}],Qi={fields:Zi},eo=`// The path tracer in WGSL, for WebGPU in the page: the same method and parameter block as the
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
`,Oe=globalThis,$=new Proxy({},{get:(n,e)=>Oe.GPUBufferUsage[e]}),_s=new Proxy({},{get:(n,e)=>Oe.GPUTextureUsage[e]}),to=new Proxy({},{get:(n,e)=>Oe.GPUShaderStage[e]}),Ps=new Proxy({},{get:(n,e)=>Oe.GPUMapMode[e]}),H=1024,xe=4,it={},Rs=(()=>{let n=0;for(const e of Qi.fields)it[e.name]=n,n+=e.size;return n})(),ve=Yi,so={top:[.85,.9,1],horizon:[.55,.55,.6],bottom:[.12,.11,.1],scale:.6};function io(n){const e=new Float64Array(256);for(let d=0;d<n.length;++d)e[n[d]]++;let t=0;for(let d=1;d<25;++d)e[d]>e[t]&&(t=d);let s=t;for(;s+1<256&&e[s+1]<=e[s];)s++;const i=Float64Array.from(e);for(let d=0;d<=s;++d)i[d]=0;let o=i.reduce((d,f)=>d+f,0);const a=o>0?i:e;o===0&&(o=e.reduce((d,f)=>d+f,0));const r=new Map,l=[.5,1,2,5,10,20,30,40,50,60,70,80,90,95,98,99,99.5,99.9];let c=0,u=0;for(let d=0;d<256&&u<l.length;++d)for(c+=a[d];u<l.length&&c/o>=l[u]/100;)r.set(l[u++],d);for(;u<l.length;)r.set(l[u++],255);return r.set(0,s+1),r}function oo(n,e,t,s){if(Math.min(e,t,s)<8)return;const i=new Float64Array(256),o=new Float64Array(256);for(let v=0;v<t;v+=2)for(let w=0;w<e;w+=2){const _=Math.hypot((v-(t-1)/2)/(t/2),(w-(e-1)/2)/(e/2));if(_>=.9)continue;const y=_>.75;for(let P=0;P<s;P+=2){const T=n[(P*t+v)*e+w];o[T]++,y&&i[T]++}}i[0]=0,o[0]=0;const a=i.map((v,w)=>{let _=0;for(let y=w-2;y<=w+2;++y)y>=0&&y<256&&(_+=i[y]);return _/5});let r=0;for(let v=1;v<256;++v)a[v]>a[r]&&(r=v);if(a[r]===0)return;let l=r;for(;l>0&&a[l]>.2*a[r];)l--;let c=r;for(;c<255&&a[c]>.2*a[r];)c++;const u=Math.max(r-l,c-r,1);let d=0,f=0;for(let v=r+u;v<256;++v)d+=o[v];for(let v=0;v<r-u;++v)f+=o[v];const m=v=>{let w=-1;for(let S=0;S<v.length;++S)v[S]>0&&(w=S);if(w<0)return 1;const _=Math.max(5,Math.floor((w+1)/40))|1,y=new Float64Array(v.length);for(let S=0;S<v.length;++S){let L=0;for(let k=S-(_>>1);k<=S+(_>>1);++k)k>=0&&k<v.length&&(L+=v[k]);y[S]=L/_}const P=Math.max(...y);let T=-1,z=1/0;for(let S=0;S<_-(_>>1)-1;++S)z=Math.min(z,y[S]);for(let S=_;S<y.length-1;++S)z=Math.min(z,y[S-(_>>1)-1]),y[S]>=y[S-1]&&y[S]>y[S+1]&&y[S]>1.3*z&&y[S]>.05*P&&(T<0||y[S]>y[T])&&(T=S);if(T<0){const S=v.reduce((k,W)=>k+W,0);let L=0;T=v.length-1;for(let k=0;k<v.length;++k)if((L+=v[k])/S>=.99){T=k;break}T=Math.floor(T/2)}return Math.max(T,1)};if(d>=f&&d>0)return[r+u,r+u+2*m(o.slice(r+u))];if(f>0){const v=Math.max(0,r-u);return[v-2*m(o.slice(0,v).reverse()),v]}}function Ze(n,e,t){if(n<=e[0])return t[0];for(let s=1;s<e.length;++s)if(n<=e[s])return t[s-1]+(t[s]-t[s-1])*(n-e[s-1])/(e[s]-e[s-1]||1);return t[t.length-1]}function ot(n,e,t){const s=[...e.keys()].sort((c,u)=>c-u),i=t??[0,255],o=c=>(n.domain==="percentile"?Ze(c,s,s.map(u=>e.get(u))):n.domain==="window"?i[0]+c*(i[1]-i[0]):c)/255,a=n.stops.map(c=>({x:o(c.value),c:c.color,a:c.opacity})).sort((c,u)=>c.x-u.x),r=a.map(c=>c.x),l=new Float32Array(H*4);for(let c=0;c<H;++c){const u=c/(H-1);for(let d=0;d<3;++d)l[4*c+d]=Ze(u,r,a.map(f=>f.c[d]));l[4*c+3]=Ze(u,r,a.map(d=>d.a))}return l}const at=(n,e)=>{const t=new Array(16).fill(0);for(let s=0;s<4;++s)for(let i=0;i<4;++i)for(let o=0;o<4;++o)t[4*s+i]+=n[4*s+o]*e[4*o+i];return t};function nt(n){const e=n.slice(),t=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];for(let s=0;s<4;++s){let i=s;for(let a=s+1;a<4;++a)Math.abs(e[4*a+s])>Math.abs(e[4*i+s])&&(i=a);for(let a=0;a<4;++a)[e[4*s+a],e[4*i+a]]=[e[4*i+a],e[4*s+a]],[t[4*s+a],t[4*i+a]]=[t[4*i+a],t[4*s+a]];const o=e[4*s+s];for(let a=0;a<4;++a)e[4*s+a]/=o,t[4*s+a]/=o;for(let a=0;a<4;++a){if(a===s)continue;const r=e[4*a+s];for(let l=0;l<4;++l)e[4*a+l]-=r*e[4*s+l],t[4*a+l]-=r*t[4*s+l]}}return t}const Re=n=>{const e=new Array(16);for(let t=0;t<4;++t)for(let s=0;s<4;++s)e[4*t+s]=n[4*s+t];return e};function rt(n){const e=(c,u,d)=>{const f=[0,1,2,3].map(m=>n[4*m]*c+n[4*m+1]*u+n[4*m+2]*d+n[4*m+3]);return[f[0]/f[3],f[1]/f[3],f[2]/f[3]]},t=(c,u)=>c.map((d,f)=>d-u[f]),s=c=>{const u=Math.hypot(...c);return c.map(d=>d/u)},i=(c,u)=>c[0]*u[0]+c[1]*u[1]+c[2]*u[2],o=e(0,0,-1),a=s(t(e(0,0,1),o));let r=t(e(1,0,-1),o);r=s(r.map((c,u)=>c-a[u]*i(r,a)));const l=[r[1]*a[2]-r[2]*a[1],r[2]*a[0]-r[0]*a[2],r[0]*a[1]-r[1]*a[0]];return[r,l,a.map(c=>-c)]}async function qs(n,e,t,s,i){const{levels:o,window:a}=await n.open([e.endsWith("/")?e:`${e}/`],void 0),r=o.filter(f=>f.size[0]*f.size[1]*f.size[2]<=t&&Math.max(...f.size)<=s),l=r.length?o.indexOf(r[0]):o.length-1,c=o[l];i?.(`reading level ${c.path} (${c.size.join(" × ")})`);const{data:u,size:d}=await n.volume(l,(f,m)=>i?.(`reading level ${c.path}: ${f}/${m} chunks`));return{data:u,size:d,voxelToRas:Array.from(c.voxelToRas),range:a??[0,255],pct:io(u),window:oo(u,d[0],d[1],d[2]),path:c.path}}async function ao(){const n=navigator.gpu;if(n!==void 0)return await n.requestAdapter({powerPreference:"high-performance"})??void 0}async function Js(n,e,t,s=()=>!1){const[i,o,a]=e,r=[Math.ceil(i/t),Math.ceil(o/t),Math.ceil(a/t)],l=r[0]*r[1]*r[2],c=new Float32Array(l*2);for(let d=0;d<l;++d)c[2*d]=1,c[2*d+1]=0;const u=Math.max(1,Math.floor(4e6/Math.max(1,i*o)));for(let d=0;d<a;d+=u){if(d>0&&await new Promise(f=>setTimeout(f,0)),s())return c;for(let f=d;f<Math.min(a,d+u);++f){const m=Math.floor(Math.max(0,f-1)/t),v=Math.floor(Math.min(a-1,f+1)/t);for(let w=0;w<o;++w){const _=Math.floor(Math.max(0,w-1)/t),y=Math.floor(Math.min(o-1,w+1)/t),P=(f*o+w)*i;for(let T=0;T<i;++T){const z=n[P+T]/255,S=Math.floor(Math.max(0,T-1)/t),L=Math.floor(Math.min(i-1,T+1)/t);for(let k=m;k<=v;++k)for(let W=_;W<=y;++W)for(let Y=S;Y<=L;++Y){const j=(k*r[1]+W)*r[0]+Y;z<c[2*j]&&(c[2*j]=z),z>c[2*j+1]&&(c[2*j+1]=z)}}}}}return c}class no{onFrame;status="";device;pipelines={};layout;tex;sampler;bounds;maj;nbricks=0;grid=[1,1,1];size=[1,1,1];voxelToRas=[];pct=new Map;window;params;tf;accum;out;depth;uni;W=0;H=0;bind;view;tag="";appliedView={camera:[],tag:""};version=0;applied=-1;samples=0;frameNo=0;maxSamples=256;running=!1;disposed=!1;ready=!1;client;adapterName="";level;async load(e,t,s){const i=await ao();if(i===void 0)throw new Error("This browser has no WebGPU adapter.");const o=i.info;this.adapterName=[o?.vendor,o?.architecture,o?.description].filter(Boolean).join(" ")||"WebGPU";const a=i.limits,r=await i.requestDevice({requiredLimits:{maxStorageBufferBindingSize:Math.min(a.maxStorageBufferBindingSize,1<<30),maxBufferSize:Math.min(a.maxBufferSize,1<<30)}});this.device=r,this.client?.dispose(),this.client=new Ks;const l=await qs(this.client,e,t,r.limits.maxTextureDimension3D,s),{data:c,size:u}=l;this.level=l,this.size=u,this.voxelToRas=l.voxelToRas,this.pct=l.pct,this.window=l.window;const[d,f,m]=u;this.tex=r.createTexture({size:[d,f,m],dimension:"3d",format:"r8unorm",usage:_s.TEXTURE_BINDING|_s.COPY_DST});const v=Math.ceil(d/256)*256;if(v===d)r.queue.writeTexture({texture:this.tex},c,{bytesPerRow:d,rowsPerImage:f},[d,f,m]);else{const y=new Uint8Array(v*f*m);for(let P=0;P<m;++P)for(let T=0;T<f;++T)y.set(c.subarray((P*f+T)*d,(P*f+T+1)*d),(P*f+T)*v);r.queue.writeTexture({texture:this.tex},y,{bytesPerRow:v,rowsPerImage:f},[d,f,m])}this.sampler=r.createSampler({magFilter:"linear",minFilter:"linear",addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge",addressModeW:"clamp-to-edge"});const w=[Math.ceil(d/xe),Math.ceil(f/xe),Math.ceil(m/xe)];this.grid=w,this.nbricks=w[0]*w[1]*w[2],s?.("finding empty space");const _=await Js(c,u,xe,()=>this.disposed);if(this.disposed)throw new Error("closed");return this.bounds=r.createBuffer({size:_.byteLength,usage:$.STORAGE|$.COPY_DST}),r.queue.writeBuffer(this.bounds,0,_),this.maj=r.createBuffer({size:this.nbricks*4,usage:$.STORAGE}),this.params=r.createBuffer({size:Rs*4,usage:$.STORAGE|$.COPY_DST}),this.tf=r.createBuffer({size:H*16,usage:$.STORAGE|$.COPY_DST}),this.uni=r.createBuffer({size:16,usage:$.UNIFORM|$.COPY_DST}),this.compile(r),this.applied=-1,this.ready=!0,`level ${l.path} (${u.join(" × ")}) on ${this.adapterName}`}compile(e){const t=`const TF_SIZE: u32 = ${H}u;
`+Object.entries(it).map(([a,r])=>`const P_${a}: u32 = ${r}u;`).join(`
`)+`
`,s=e.createShaderModule({code:t+eo}),i=to.COMPUTE;this.layout=e.createBindGroupLayout({entries:[{binding:0,visibility:i,buffer:{type:"read-only-storage"}},{binding:1,visibility:i,texture:{sampleType:"float",viewDimension:"3d"}},{binding:2,visibility:i,sampler:{type:"filtering"}},{binding:3,visibility:i,buffer:{type:"read-only-storage"}},{binding:4,visibility:i,buffer:{type:"storage"}},{binding:5,visibility:i,buffer:{type:"storage"}},{binding:6,visibility:i,buffer:{type:"storage"}},{binding:7,visibility:i,buffer:{type:"storage"}},{binding:8,visibility:i,buffer:{type:"read-only-storage"}},{binding:9,visibility:i,buffer:{type:"uniform"}}]});const o=e.createPipelineLayout({bindGroupLayouts:[this.layout]});for(const a of["trace","firsthit","majorant","tonemap"])this.pipelines[a]=e.createComputePipeline({layout:o,compute:{module:s,entryPoint:a}})}resize(e,t){const s=this.device;e===this.W&&t===this.H&&this.accum||(this.accum?.destroy(),this.out?.destroy(),this.depth?.destroy(),this.W=e,this.H=t,this.accum=s.createBuffer({size:e*t*16,usage:$.STORAGE|$.COPY_DST}),this.out=s.createBuffer({size:e*t*4,usage:$.STORAGE|$.COPY_SRC}),this.depth=s.createBuffer({size:e*t*4,usage:$.STORAGE|$.COPY_SRC}),this.bind=s.createBindGroup({layout:this.layout,entries:[{binding:0,resource:{buffer:this.params}},{binding:1,resource:this.tex.createView({dimension:"3d"})},{binding:2,resource:this.sampler},{binding:3,resource:{buffer:this.tf}},{binding:4,resource:{buffer:this.maj}},{binding:5,resource:{buffer:this.accum}},{binding:6,resource:{buffer:this.out}},{binding:7,resource:{buffer:this.depth}},{binding:8,resource:{buffer:this.bounds}},{binding:9,resource:{buffer:this.uni}}]}))}setView(e,t=""){this.view=e,this.tag=t,this.version++,this.maxSamples=e.max_samples??256,this.running||this.loop()}pack(e,t,s){const i=it,o=new Float32Array(Rs),a=Re(e.inv_view_projection),r=nt(a),l=(I,X)=>o.set(Array.from(X),i[I]),c=I=>{const X=new Array(16);for(let ne=0;ne<4;++ne)for(let re=0;re<4;++re)X[4*re+ne]=I[4*ne+re];return X};l("INVVP",c(a)),l("VP",c(r));const u=e.world_from_physical?Re(e.world_from_physical):[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],d=at(u,this.voxelToRas),f=nt(d);l("VOX_FROM_WORLD",f.slice(0,12)),l("WORLD_NORMAL",[f[0],f[4],f[8],f[1],f[5],f[9],f[2],f[6],f[10]]),l("DIMS",this.size),o[i.BRICK]=xe,l("MGRID",this.grid);const m=typeof e.preset=="string"?e.preset:String(e.preset.name??""),w={...(typeof e.preset=="object"?e.preset:ve.find(I=>I.name===m))??ve[0],...e.overrides??{}};o[i.DENSITY]=w.density*(e.unit_mm??1),o[i.SHADE_MIX]=w.shade_mix??.8,o[i.GRAD_SCALE]=w.gradient_scale??40,o[i.ROUGHNESS]=w.roughness??.45,o[i.SPECULAR]=w.specular??.15,o[i.PHASE_G]=w.phase_g??0,o[i.ALBEDO]=w.albedo??.9,o[i.INSET]=w.surface_inset??0;const[_,y,P]=rt(a),T=e.light?.direction??[.4,.7,.6];let z=e.light?.camera_space===!1?T:[0,1,2].map(I=>T[0]*_[I]+T[1]*y[I]+T[2]*P[I]);const S=Math.hypot(...z);z=z.map(I=>I/S),l("LIGHT_DIR",z);const L=w.light_scale??1;l("LIGHT_RGB",(e.light?.rgb??[3.2,3,2.8]).map(I=>I*L));const k={...so,...w.environment??{}};l("ENV_TOP",k.top),l("ENV_HORIZON",k.horizon),l("ENV_BOTTOM",k.bottom),l("ENV_UP",y),o[i.ENV_SCALE]=k.scale??1,l("BG",e.background??[0,0,0,0]),o[i.EXPOSURE]=w.exposure??1,o[i.MAX_BOUNCES]=e.max_bounces??4;const W=(e.clips??[]).slice(0,6);o[i.NCLIP]=W.length,W.forEach((I,X)=>o.set(I,i.CLIPS+4*X));const Y=e.boxes?.find(I=>I.keep),j=e.crop_fraction??(Y?[Y.lo,Y.hi]:void 0);return l("CROP_LO",j?j[0].map((I,X)=>I*this.size[X]-.5):[-1e9,-1e9,-1e9]),l("CROP_HI",j?j[1].map((I,X)=>I*this.size[X]-.5):[1e9,1e9,1e9]),o[i.STEP]=.5,o[i.APERTURE]=e.aperture??0,o[i.FOCUS]=e.focus??0,o[i.OPAQUE_LIMIT]=.5,{P:o,preset:w}}async loop(){this.running=!0;const e=this.device;let t=0,s;try{for(;!this.disposed;){const i=this.view;if(i===void 0||this.applied===this.version&&this.samples>=this.maxSamples)break;const o=Math.max(8,Math.round(i.width*(i.scale??1))),a=Math.max(8,Math.round(i.height*(i.scale??1)));if(this.applied!==this.version){const d=this.version;this.resize(o,a);const{P:f,preset:m}=this.pack(i,o,a);e.queue.writeBuffer(this.params,0,f),e.queue.writeBuffer(this.tf,0,ot(m,this.pct,this.window)),e.queue.writeBuffer(this.uni,0,new Uint32Array([o,a,0,0]));const v=e.createCommandEncoder();v.clearBuffer(this.accum);const w=v.beginComputePass();w.setBindGroup(0,this.bind),w.setPipeline(this.pipelines.majorant),w.dispatchWorkgroups(Math.ceil(this.nbricks/64)),w.setPipeline(this.pipelines.firsthit),w.dispatchWorkgroups(Math.ceil(o/8),Math.ceil(a/8)),w.end();const _=e.createBuffer({size:o*a*4,usage:$.COPY_DST|$.MAP_READ});v.copyBufferToBuffer(this.depth,0,_,0,o*a*4),e.queue.submit([v.finish()]),await _.mapAsync(Ps.READ),s={width:o,height:a,data:new Float32Array(_.getMappedRange().slice(0)),version:d},_.unmap(),_.destroy(),this.applied=d,this.appliedView={camera:i.inv_view_projection,tag:this.tag},this.samples=0,t=0}const r=performance.now(),l=1;for(let d=0;d<l;++d){this.frameNo++,this.samples++,e.queue.writeBuffer(this.uni,0,new Uint32Array([o,a,this.frameNo,this.samples]));const f=e.createCommandEncoder(),m=f.beginComputePass();m.setBindGroup(0,this.bind),m.setPipeline(this.pipelines.trace),m.dispatchWorkgroups(Math.ceil(o/8),Math.ceil(a/8)),m.end(),e.queue.submit([f.finish()])}await e.queue.onSubmittedWorkDone();const c=(performance.now()-r)/l,u=this.samples;((u&u-1)===0||performance.now()-t>250||u>=this.maxSamples)&&(await this.publish(o,a,c,s),t=performance.now())}}catch(i){this.status=`WebGPU: ${i.message}`}finally{this.running=!1}}async publish(e,t,s,i){const o=this.device,a=o.createCommandEncoder(),r=a.beginComputePass();r.setBindGroup(0,this.bind),r.setPipeline(this.pipelines.tonemap),r.dispatchWorkgroups(Math.ceil(e/8),Math.ceil(t/8)),r.end();const l=o.createBuffer({size:e*t*4,usage:$.COPY_DST|$.MAP_READ});a.copyBufferToBuffer(this.out,0,l,0,e*t*4),o.queue.submit([a.finish()]),await l.mapAsync(Ps.READ);const c=new Uint8ClampedArray(l.getMappedRange().slice(0));l.unmap(),l.destroy();const u=await createImageBitmap(new ImageData(c,e,t),{premultiplyAlpha:"none"});this.onFrame?.({bitmap:u,depth:i,...this.appliedView,samples:this.samples,width:e,height:t,msPerPass:s,version:this.applied})}dispose(){this.disposed=!0,this.client?.dispose(),this.tex?.destroy(),this.device?.destroy()}}const Ys=64e6,ro=2048,_e=8,co=96,Te=48,lo=8,As=150,ho=1024,uo={top:[.85,.9,1],horizon:[.55,.55,.6],bottom:[.12,.11,.1],scale:.6};function po(n,e){const[t,s]=e.range,i=a=>(a-t)/(s-t||1)*255;if(n.domain==="data")return ot({...n,stops:n.stops.map(a=>({...a,value:i(a.value)}))},e.pct);const o=n.domain==="window"&&n.window?[i(n.window[0]),i(n.window[1])]:e.window;return ot(n,e.pct,o)}function fo(n,e){const t=new Int32Array(H+1);for(let i=0;i<H;++i)t[i+1]=t[i]+(e[4*i+3]>0?1:0);const s=new Uint8Array(n.length/2);for(let i=0;i<s.length;++i){const o=Math.max(0,Math.floor(n[2*i]*(H-1))),a=Math.min(H-1,Math.ceil(n[2*i+1]*(H-1)));s[i]=a>=o&&t[a+1]-t[o]>0?255:0}return s}function mo(n){const e=Math.max(1,Math.ceil(Math.max(...n)/co));return{cell:e,grid:[0,1,2].map(t=>Math.ceil(n[t]/e))}}function vo(n,e,t){const s=Re(n.inv_view_projection),i=n.world_from_physical?Re(n.world_from_physical):[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],o=nt(at(i,t.voxelToRas)),[a,r,l]=rt(s),c=n.light?.direction??[.4,.7,.6];let u=n.light?.camera_space===!1?c:[0,1,2].map(y=>c[0]*a[y]+c[1]*r[y]+c[2]*l[y]);const d=Math.hypot(...u);u=u.map(y=>y/d);const f=e.light_scale??1,m={...uo,...e.environment??{}},v=n.boxes?.find(y=>y.keep),w=n.crop_fraction??(v?[v.lo,v.hi]:void 0),_=(n.clips??[]).slice(0,6);return{voxFromWorld:[0,1,2,3].flatMap(y=>[0,1,2,3].map(P=>o[4*P+y])),worldFromVox:(()=>{const y=at(i,t.voxelToRas);return[0,1,2,3].flatMap(P=>[0,1,2,3].map(T=>y[4*T+P]))})(),dims:t.size,cropLo:w?w[0].map((y,P)=>y*t.size[P]-.5):[-1e9,-1e9,-1e9],cropHi:w?w[1].map((y,P)=>y*t.size[P]-.5):[1e9,1e9,1e9],clips:Array.from({length:24},(y,P)=>_[P>>2]?.[P&3]??0),nclip:_.length,density:e.density*(n.unit_mm??1),shadeMix:e.shade_mix??.8,gradScale:e.gradient_scale??40,roughness:e.roughness??.45,specular:e.specular??.15,phaseG:e.phase_g??0,albedo:e.albedo??.9,inset:e.surface_inset??0,maxBounces:n.max_bounces??4,exposure:e.exposure??1,lightDir:u,lightRgb:(n.light?.rgb??[3.2,3,2.8]).map(y=>y*f),envTop:m.top,envHorizon:m.horizon,envBottom:m.bottom,envUp:r,envScale:m.scale??1}}const Ue=`#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`,ct=`precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform sampler2D uTf;
uniform highp sampler3D uOcc;
uniform bool uHasOcc;
uniform mat4 uVoxFromWorld;
uniform mat4 uWorldFromVox;
uniform vec3 uDims;
uniform vec3 uCropLo;
uniform vec3 uCropHi;
uniform vec4 uClips[6];
uniform int uNClip;
uniform float uDensity;
uniform float uPhaseG;
uniform float uAlbedo;
uniform float uShadeMix;
uniform float uGradScale;
uniform float uRoughness;
uniform float uSpecular;
uniform float uInset;
uniform vec3 uLightDir;
uniform vec3 uLightRgb;
uniform vec3 uEnvTop;
uniform vec3 uEnvHorizon;
uniform vec3 uEnvBottom;
uniform vec3 uEnvUp;
uniform float uEnvScale;
uniform float uCell;

vec3 world(vec3 v) { return (uWorldFromVox * vec4(v, 1.0)).xyz; }
float tex(vec3 v) { return texture(uVol, (v + 0.5) / uDims).r; }
vec4 tf(float t) { return texture(uTf, vec2((clamp(t, 0.0, 1.0) * ${H-1}.0 + 0.5) / ${H}.0, 0.5)); }
vec3 grad(vec3 v) {
  return vec3(tex(v + vec3(1.0, 0.0, 0.0)) - tex(v - vec3(1.0, 0.0, 0.0)),
              tex(v + vec3(0.0, 1.0, 0.0)) - tex(v - vec3(0.0, 1.0, 0.0)),
              tex(v + vec3(0.0, 0.0, 1.0)) - tex(v - vec3(0.0, 0.0, 1.0))) * 0.5;
}
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
float phongExp() { return max(1.0, 2.0 / max(uRoughness * uRoughness, 1e-4) - 2.0); }
vec3 brdfCos(vec3 n, vec3 wo, vec3 wl, vec3 albedo) {
  float cl = dot(n, wl);
  if (cl <= 0.0) return vec3(0.0);
  vec3 h = normalize(wo + wl);
  float e = phongExp();
  float s = uSpecular * (e + 8.0) / 25.132741 * pow(max(dot(n, h), 0.0), e);
  return (albedo * ((1.0 - uSpecular) * 0.31830989) + vec3(s)) * cl;
}
vec3 safeDir(vec3 dv) { return mix(dv, vec3(1e-12), lessThan(abs(dv), vec3(1e-12))); }
// Where a ray from voxel point v, dv voxels a world unit, is in the level and its crop (world units from v).
vec2 span(vec3 v, vec3 dv) {
  vec3 bmin = max(vec3(-0.5), uCropLo - 0.5);
  vec3 bmax = min(uDims - 0.5, uCropHi + 0.5);
  vec3 safe = safeDir(dv);
  vec3 ta = (bmin - v) / safe;
  vec3 tb = (bmax - v) / safe;
  vec3 tlo = min(ta, tb);
  vec3 thi = max(ta, tb);
  return vec2(max(max(max(tlo.x, tlo.y), tlo.z), 0.0), min(min(thi.x, thi.y), thi.z));
}
// In a brick the preset leaves clear, how far (world units) the ray goes before it leaves the brick; else 0.
float clearRun(vec3 v, vec3 dv) {
  if (!uHasOcc) return 0.0;
  ivec3 grid = textureSize(uOcc, 0);
  vec3 cell = clamp(floor((v + 0.5) / ${_e}.0), vec3(0.0), vec3(grid - 1));
  if (texelFetch(uOcc, ivec3(cell), 0).r != 0.0) return 0.0;
  vec3 safe = safeDir(dv);
  vec3 side = cell * ${_e}.0 - 0.5 + ${_e}.0 * step(0.0, safe);
  vec3 leave = (side - v) / safe;
  return max(min(min(leave.x, leave.y), leave.z), 0.0);
}`,Zs=`uint rs;
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float rnd() {
  rs = pcg(rs);
  return float(rs >> 8u) * (1.0 / 16777216.0);
}
mat3 basis(vec3 n) {
  vec3 a = abs(n.x) > 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(a, n));
  return mat3(t, cross(n, t), n);
}
vec3 sphere() {
  float z = 1.0 - 2.0 * rnd();
  float r = sqrt(max(0.0, 1.0 - z * z));
  float ph = 6.2831853 * rnd();
  return vec3(r * cos(ph), r * sin(ph), z);
}
vec3 cosdir(vec3 n) {
  float u1 = rnd();
  float r = sqrt(u1);
  float ph = 6.2831853 * rnd();
  return normalize(basis(n) * vec3(r * cos(ph), r * sin(ph), sqrt(max(0.0, 1.0 - u1))));
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
  return normalize(basis(w) * vec3(sn * cos(ph), sn * sin(ph), c));
}
// The transmittance from voxel point v toward dir (world, unit) to the level's edge, a voxel a step.
float transmit(vec3 v, vec3 dir) {
  vec3 dv = mat3(uVoxFromWorld) * dir;
  vec3 w = world(v);
  float dt = 1.0 / length(dv);
  float t1 = span(v, dv).y;
  float tau = 0.0;
  float t = 0.5 * dt;
  for (int k = 0; k < 4096; ++k) {
    if (t >= t1 || tau > 8.0) break;
    float run = clearRun(v + dv * t, dv);
    if (run > 0.0) {
      t += max(ceil(run / dt), 1.0) * dt;
      continue;
    }
    tau += sigma(w + dir * t, v + dv * t) * dt;
    t += dt;
  }
  return exp(-tau);
}
// Moves voxel point v to where a ray toward dir first scatters (where its optical depth reaches
// -log(1 - u), stepVox voxels a step); false when it leaves the level first.
bool collide(inout vec3 v, vec3 dir, float stepVox) {
  vec3 dv = mat3(uVoxFromWorld) * dir;
  vec3 w = world(v);
  float dt = stepVox / length(dv);
  vec2 sp = span(v, dv);
  float target = -log(1.0 - rnd());
  float tau = 0.0;
  float t = sp.x + dt * rnd();
  for (int k = 0; k < 8192; ++k) {
    if (t >= sp.y) return false;
    float run = clearRun(v + dv * t, dv);
    if (run > 0.0) {
      t += max(ceil(run / dt), 1.0) * dt;
      continue;
    }
    tau += sigma(w + dir * t, v + dv * t) * dt;
    if (tau >= target) {
      v += dv * t;
      return true;
    }
    t += dt;
  }
  return false;
}`,Qs=`vec3 tone(vec3 c) {
  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  c = clamp(c, 0.0, 1.0);
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float noise() { return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); }`,go=n=>`#version 300 es
${ct}
${Qs}
uniform highp sampler3D uLight;
uniform bool uHasLight;
uniform mat4 uInvVP;
uniform mat4 uVP;
uniform vec4 uViewport;
uniform float uStep;
uniform float uExposure;
uniform vec2 uBand;
layout(location = ${n.color}) out vec4 out_color;
layout(location = ${n.z}) out highp vec4 out_z;
layout(location = ${n.pick}) out highp vec4 out_pickId;

vec4 lightAt(vec3 v) { return texture(uLight, (v + 0.5) / (uCell * vec3(textureSize(uLight, 0)))); }
void main() {
  // The pixels this image draws while another (the path-traced one) comes in over it.
  float k = noise();
  if (k < uBand.x || k >= uBand.y) discard;
  vec2 ndc = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
  vec4 a = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvVP * vec4(ndc, 1.0, 1.0);
  vec3 ow = a.xyz / a.w;
  vec3 far = b.xyz / b.w;
  vec3 dw = normalize(far - ow);
  mat3 lin = mat3(uVoxFromWorld);
  vec3 ov = (uVoxFromWorld * vec4(ow, 1.0)).xyz;
  vec3 dv = lin * dw;
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
  for (int k = 0; k < 4096; ++k) {
    if (t >= t1 || T < 0.02) break;
    vec3 w = ow + dw * t;
    vec3 v = ov + dv * t;
    // A brick the preset leaves clear: on to where the ray leaves it, at the same phase of the steps.
    float run = clearRun(v, dv);
    if (run > 0.0) {
      t += max(ceil(run / dt), 1.0) * dt;
      continue;
    }
    t += dt;
    float s = sigma(w, v);
    if (s <= 0.0) continue;
    float al = 1.0 - exp(-s * dt);
    vec3 albedo = tf(tex(v)).rgb * uAlbedo;
    vec3 g = grad(v);
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
  vec3 c = tone(L / (1.0 - T) * uExposure);
  vec4 p = uVP * vec4(hit, 1.0);
  float d = clamp((p.z / p.w) * 0.5 + 0.5, 0.0, 0.99999);
  gl_FragDepth = d;
  out_color = vec4(c, 1.0);
  out_z = vec4(1.0 - d);
  out_pickId = vec4(0.0);
}`,wo=`#version 300 es
${ct}
${Zs}
uniform highp sampler3D uPrev;
uniform int uLayer;
uniform int uPass;
uniform uint uSeed;
out vec4 o;

float lightAt(vec3 v) { return texture(uPrev, (v + 0.5) / (uCell * vec3(textureSize(uPrev, 0)))).a; }
// The light arriving at voxel point v from direction -dir (dir: the way the path goes out from it).
vec3 incoming(vec3 v, vec3 dir) {
  vec3 thr = vec3(1.0);
  vec3 L = vec3(0.0);
  for (int bounce = 0; bounce < 3; ++bounce) {
    if (!collide(v, dir, 1.5)) return L + thr * env(dir);
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
}`,yo=`#version 300 es
${ct}
${Zs}
uniform sampler2D uPrevSum;
uniform sampler2D uPrevAux;
uniform mat4 uInvVP;
uniform mat4 uVP;
uniform vec2 uSize;
uniform uint uSeed;
uniform int uRows;
uniform int uRow;
uniform int uMaxBounces;
layout(location = 0) out vec4 oSum;
layout(location = 1) out vec4 oAux;

// The GL depth where the ray first meets tissue (half its light gone), half a voxel a step; 1 for none.
float firstHit(vec3 ov, vec3 dv, vec3 ow, vec3 dw) {
  vec2 sp = span(ov, dv);
  float dt = 0.5 / length(dv);
  float T = 1.0;
  float t = sp.x;
  for (int k = 0; k < 8192; ++k) {
    if (t >= sp.y) break;
    float run = clearRun(ov + dv * t, dv);
    if (run > 0.0) {
      t += max(ceil(run / dt), 1.0) * dt;
      continue;
    }
    T *= exp(-sigma(ow + dw * t, ov + dv * t) * dt);
    if (T <= 0.5) {
      vec4 p = uVP * vec4(ow + dw * t, 1.0);
      return clamp((p.z / p.w) * 0.5 + 0.5, 0.0, 0.99999);
    }
    t += dt;
  }
  return 1.0;
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 sum = texelFetch(uPrevSum, px, 0);
  vec4 aux = texelFetch(uPrevAux, px, 0);
  if (px.y % uRows != uRow) {
    oSum = sum;
    oAux = aux;
    return;
  }
  rs = pcg(uint(px.x) + 8192u * uint(px.y)) ^ pcg(uSeed);
  mat3 lin = mat3(uVoxFromWorld);
  vec2 jitter = aux.g == 0.0 ? vec2(0.5) : vec2(rnd(), rnd());
  vec2 ndc = (vec2(px) + jitter) / uSize * 2.0 - 1.0;
  vec4 a = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvVP * vec4(ndc, 1.0, 1.0);
  vec3 ow = a.xyz / a.w;
  vec3 dir = normalize(b.xyz / b.w - ow);
  vec3 v = (uVoxFromWorld * vec4(ow, 1.0)).xyz;
  if (aux.g == 0.0) aux.r = firstHit(v, lin * dir, ow, dir);
  vec3 L = vec3(0.0);
  vec3 thr = vec3(1.0);
  float alpha = 0.0;
  for (int bounce = 0; bounce <= 16; ++bounce) {
    if (bounce > uMaxBounces) break;
    if (!collide(v, dir, 0.5)) {
      if (bounce > 0) L += thr * env(dir);
      break;
    }
    if (bounce == 0) alpha = 1.0;
    vec3 albedo = tf(tex(v)).rgb * uAlbedo;
    vec3 g = grad(v);
    float gm = length(g);
    if (uInset > 0.0 && gm > 1e-6) {
      // The colour a little way along the gradient, on the more opaque side: the tissue beneath a surface.
      vec3 d = g * (uInset / gm);
      vec4 ca = tf(tex(v + d));
      vec4 cb = tf(tex(v - d));
      albedo = (ca.a >= cb.a ? ca : cb).rgb * uAlbedo;
    }
    float psurf = uShadeMix * (1.0 - exp(-uGradScale * gm));
    vec3 wo = -dir;
    float Tl = transmit(v, uLightDir);
    if (rnd() < psurf) {
      vec3 n = -normalize(transpose(lin) * g);
      if (dot(n, wo) < 0.0) n = -n;
      if (Tl > 0.0) L += thr * brdfCos(n, wo, uLightDir, albedo) * uLightRgb * Tl;
      vec3 nd;
      if (rnd() < uSpecular) {
        vec3 r = normalize(n * (2.0 * dot(n, wo)) - wo);
        float ct = pow(rnd(), 1.0 / (phongExp() + 1.0));
        float st = sqrt(max(0.0, 1.0 - ct * ct));
        float ph = 6.2831853 * rnd();
        nd = normalize(basis(r) * vec3(st * cos(ph), st * sin(ph), ct));
        if (dot(nd, n) <= 0.0) break;
      } else {
        nd = cosdir(n);
        thr *= albedo;
      }
      dir = nd;
    } else {
      if (Tl > 0.0) L += thr * albedo * uLightRgb * (hg(dot(dir, uLightDir), uPhaseG) * Tl);
      thr *= albedo;
      dir = hgdir(dir, uPhaseG);
    }
    if (bounce >= 2) {
      float q = min(0.95, max(thr.x, max(thr.y, thr.z)));
      if (rnd() > q) break;
      thr /= q;
    }
  }
  oSum = sum + vec4(L, alpha);
  oAux = vec4(aux.r, aux.g + 1.0, 0.0, 0.0);
}`,bo=n=>`#version 300 es
precision highp float;
uniform sampler2D uSum;
uniform sampler2D uAux;
uniform vec4 uViewport;
uniform float uExposure;
uniform vec2 uBand;
layout(location = ${n.color}) out vec4 out_color;
layout(location = ${n.z}) out highp vec4 out_z;
layout(location = ${n.pick}) out highp vec4 out_pickId;
${Qs}
void main() {
  float k = noise();
  if (k < uBand.x || k >= uBand.y) discard;
  ivec2 px = ivec2(gl_FragCoord.xy - uViewport.xy);
  vec4 s = texelFetch(uSum, px, 0);
  vec2 a = texelFetch(uAux, px, 0).rg;
  if (a.g < 1.0 || s.a < 0.5 * a.g || a.r >= 1.0) discard;
  gl_FragDepth = a.r;
  out_color = vec4(tone(s.rgb / s.a * uExposure), 1.0);
  out_z = vec4(1.0 - a.r);
  out_pickId = vec4(0.0);
}`;class xo{look;onChange;onRedraw;base="";url="";client;level;gl;program;programFor="";failed=!1;vao;vol;tf;uploaded;tfKey="";occ;bounds;occFor;held;lightRead;lightFill;fb;bake;canBake=!1;traced;traceKey="";stillSince=0;settle;sumRead;sumFill;auxRead;auxFill;traceSize=[0,0];traceFb;tracer;composite;compositeFor="";get text(){const e=this.held;if(!this.base||this.level===void 0||e===void 0||!this.canBake)return this.base;const t=this.traced&&this.traced.samples>=1?`; path-traced, ${Math.floor(this.traced.samples)} samples`:"";return`${this.base}; light ${e.pass>=Te?"done":`${Math.max(0,e.pass-1)} of ${Te-1} passes`}${t}`}async open(e,t=Ys){const s=`${e} ${t}`;if(s!==this.url){e=s.slice(0,s.lastIndexOf(" ")),this.close(),this.url=s;try{this.client=new Ks,this.base="Object: reading the image";const i=await qs(this.client,e,t,ro,o=>this.base=`Object: ${o}`);if(this.url!==s)return;this.setLevel(i,s)}catch(i){if(this.url!==s)return;this.base=`Object: ${i.message}`,this.onChange?.()}finally{this.url===s&&(this.client?.dispose(),this.client=void 0)}}}setLevel(e,t){this.url=t,this.level=e,this.failed=!1,this.held=void 0,this.base=`Object: level ${e.path} (${e.size.join(" × ")})`,this.onChange?.(),Js(e.data,e.size,_e,()=>this.level!==e).then(s=>{this.level===e&&(this.bounds={level:e,data:s},this.onChange?.())})}ready(){return this.level!==void 0&&!this.failed}draw(e,t=1){const s=this.level,i=s&&!this.failed?this.look?.(e):void 0;if(s===void 0||i===void 0)return!1;const o=e.gl;if(this.gl!==o&&this.reset(o),Math.max(...s.size)>o.getParameter(o.MAX_3D_TEXTURE_SIZE))return this.fail("the level is larger than this GPU's 3-D textures");const a=JSON.stringify(e.outputs);if(this.program===void 0||this.programFor!==a){this.program&&o.deleteProgram(this.program),this.program=void 0;try{this.program=De(o,Ue,go(e.outputs)),this.programFor=a}catch(S){return this.fail(S.message)}}const{cell:r,grid:l}=mo(s.size);if(this.uploaded!==s){o.activeTexture(o.TEXTURE6),o.bindTexture(o.TEXTURE_3D,this.vol),o.pixelStorei(o.UNPACK_ALIGNMENT,1),o.texImage3D(o.TEXTURE_3D,0,o.R8,s.size[0],s.size[1],s.size[2],0,o.RED,o.UNSIGNED_BYTE,s.data),o.pixelStorei(o.UNPACK_ALIGNMENT,4);for(const S of[this.lightRead,this.lightFill])o.bindTexture(o.TEXTURE_3D,S),o.texImage3D(o.TEXTURE_3D,0,o.RGBA16F,l[0],l[1],l[2],0,o.RGBA,o.HALF_FLOAT,null);this.uploaded=s,this.tfKey="",this.held=void 0}const c=JSON.stringify([i.preset.domain,i.preset.stops,i.preset.window??null]),u=this.bounds?.level===s?this.bounds.data:void 0;if(this.tfKey!==c||this.occFor!==u){const S=po(i.preset,s);o.activeTexture(o.TEXTURE7),o.bindTexture(o.TEXTURE_2D,this.tf),o.texImage2D(o.TEXTURE_2D,0,o.RGBA16F,H,1,0,o.RGBA,o.FLOAT,S),o.activeTexture(o.TEXTURE5),o.bindTexture(o.TEXTURE_3D,this.occ),o.pixelStorei(o.UNPACK_ALIGNMENT,1);const L=s.size.map(k=>Math.ceil(k/_e));u!==void 0?o.texImage3D(o.TEXTURE_3D,0,o.R8,L[0],L[1],L[2],0,o.RED,o.UNSIGNED_BYTE,fo(u,S)):o.texImage3D(o.TEXTURE_3D,0,o.R8,1,1,1,0,o.RED,o.UNSIGNED_BYTE,new Uint8Array([255])),o.pixelStorei(o.UNPACK_ALIGNMENT,4),this.tfKey=c,this.occFor=u}const d=vo(i.view,i.preset,s),f=i.view.light,m=JSON.stringify([c,d.density,d.albedo,d.phaseG,d.lightRgb,d.envTop,d.envHorizon,d.envBottom,d.envScale,d.clips,d.cropLo,d.cropHi,f?.direction??null,f?.camera_space??!0]);this.held?.key!==m&&(this.held={key:m,lightDir:d.lightDir,envUp:d.envUp,pass:0,layer:0}),d.lightDir=this.held.lightDir,d.envUp=this.held.envUp,this.canBake&&this.held.pass<Te&&this.bakeSome(o,d,r,l);const v=o.getParameter(o.VIEWPORT),w=Math.min(ho,i.view.max_samples??256),_=JSON.stringify([m,Array.from(e.invViewProjection),v[2],v[3],d.shadeMix,d.gradScale,d.roughness,d.specular,d.inset,d.maxBounces,w]),y=performance.now();_!==this.traceKey&&(this.traceKey=_,this.stillSince=y,this.traced=void 0),this.canBake&&!e.moving&&y-this.stillSince>=As?this.traceSome(o,d,e,v[2],v[3],w,r):this.canBake&&(clearTimeout(this.settle),this.settle=setTimeout(()=>this.onRedraw?.(),As+20));const P=Math.min(1,Math.max(0,((this.traced?.samples??0)-4)/28)),T=P*P*(3-2*P);if(T<1){const S=this.program,L=k=>o.getUniformLocation(S,k);o.useProgram(S),this.common(o,S,d,r,u!==void 0),o.uniform4f(L("uViewport"),v[0],v[1],v[2],v[3]),o.uniformMatrix4fv(L("uInvVP"),!1,e.invViewProjection),o.uniformMatrix4fv(L("uVP"),!1,e.viewProjection),o.uniform1f(L("uStep"),e.moving?1:.5),o.uniform1f(L("uExposure"),d.exposure),o.uniform2f(L("uBand"),0,t*(1-T)),o.activeTexture(o.TEXTURE4),o.bindTexture(o.TEXTURE_3D,this.lightRead),o.uniform1i(L("uLight"),4),o.uniform1i(L("uHasLight"),this.canBake&&this.held.pass>=2?1:0),o.bindVertexArray(this.vao),o.drawArrays(o.TRIANGLES,0,3)}if(T>0&&this.compositeProgram(o,e.outputs)){const S=this.composite,L=k=>o.getUniformLocation(S,k);o.useProgram(S),o.uniform4f(L("uViewport"),v[0],v[1],v[2],v[3]),o.uniform1f(L("uExposure"),d.exposure),o.uniform2f(L("uBand"),t*(1-T),t),o.activeTexture(o.TEXTURE2),o.bindTexture(o.TEXTURE_2D,this.sumRead),o.uniform1i(L("uSum"),2),o.activeTexture(o.TEXTURE3),o.bindTexture(o.TEXTURE_2D,this.auxRead),o.uniform1i(L("uAux"),3),o.bindVertexArray(this.vao),o.drawArrays(o.TRIANGLES,0,3)}o.bindVertexArray(null),o.activeTexture(o.TEXTURE0);const z=this.traced!==void 0&&this.traced.samples<w;return this.canBake&&(this.held.pass<Te||z)&&requestAnimationFrame(()=>this.onRedraw?.()),!0}common(e,t,s,i,o){const a=r=>e.getUniformLocation(t,r);e.uniformMatrix4fv(a("uVoxFromWorld"),!1,s.voxFromWorld),e.uniformMatrix4fv(a("uWorldFromVox"),!1,s.worldFromVox),e.uniform3fv(a("uDims"),s.dims),e.uniform3fv(a("uCropLo"),s.cropLo),e.uniform3fv(a("uCropHi"),s.cropHi),e.uniform4fv(a("uClips"),s.clips),e.uniform1i(a("uNClip"),s.nclip),e.uniform1f(a("uDensity"),s.density),e.uniform1f(a("uPhaseG"),s.phaseG),e.uniform1f(a("uAlbedo"),s.albedo),e.uniform1f(a("uShadeMix"),s.shadeMix),e.uniform1f(a("uGradScale"),s.gradScale),e.uniform1f(a("uRoughness"),s.roughness),e.uniform1f(a("uSpecular"),s.specular),e.uniform1f(a("uInset"),s.inset),e.uniform3fv(a("uLightDir"),s.lightDir),e.uniform3fv(a("uLightRgb"),s.lightRgb),e.uniform3fv(a("uEnvTop"),s.envTop),e.uniform3fv(a("uEnvHorizon"),s.envHorizon),e.uniform3fv(a("uEnvBottom"),s.envBottom),e.uniform3fv(a("uEnvUp"),s.envUp),e.uniform1f(a("uEnvScale"),s.envScale),e.uniform1f(a("uCell"),i),e.activeTexture(e.TEXTURE6),e.bindTexture(e.TEXTURE_3D,this.vol),e.uniform1i(a("uVol"),6),e.activeTexture(e.TEXTURE7),e.bindTexture(e.TEXTURE_2D,this.tf),e.uniform1i(a("uTf"),7),e.activeTexture(e.TEXTURE5),e.bindTexture(e.TEXTURE_3D,this.occ),e.uniform1i(a("uOcc"),5),e.uniform1i(a("uHasOcc"),o?1:0)}offscreen(e,t,s,i,o){const a=e.getParameter(e.DRAW_FRAMEBUFFER_BINDING),r=e.getParameter(e.VIEWPORT),l=e.getParameter(e.COLOR_WRITEMASK),c=[e.DEPTH_TEST,e.BLEND,e.SCISSOR_TEST,e.CULL_FACE,e.STENCIL_TEST].filter(u=>e.isEnabled(u));for(const u of c)e.disable(u);e.colorMask(!0,!0,!0,!0),e.bindFramebuffer(e.DRAW_FRAMEBUFFER,t),e.viewport(0,0,s,i),e.bindVertexArray(this.vao),o(),e.bindVertexArray(null),e.bindFramebuffer(e.DRAW_FRAMEBUFFER,a),e.viewport(r[0],r[1],r[2],r[3]),e.colorMask(l[0],l[1],l[2],l[3]);for(const u of c)e.enable(u)}bakeSome(e,t,s,i){const o=this.held;if(this.bake===void 0)try{this.bake=De(e,Ue,wo)}catch(l){this.canBake=!1,this.base+=` (the light could not be held: ${l.message})`;return}const a=this.bake,r=l=>e.getUniformLocation(a,l);this.offscreen(e,this.fb,i[0],i[1],()=>{e.useProgram(a),this.common(e,a,t,s,this.occFor!==void 0);const l=()=>{e.uniform1i(r("uPass"),o.pass),e.uniform1ui(r("uSeed"),o.pass*7919+17),e.activeTexture(e.TEXTURE4),e.bindTexture(e.TEXTURE_3D,this.lightRead),e.uniform1i(r("uPrev"),4)};l();for(let c=0;c<lo&&o.pass<Te;++c)e.framebufferTextureLayer(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,this.lightFill,0,o.layer),e.uniform1i(r("uLayer"),o.layer),e.drawArrays(e.TRIANGLES,0,3),!(++o.layer<i[2])&&(o.layer=0,o.pass++,[this.lightRead,this.lightFill]=[this.lightFill,this.lightRead],l(),this.onChange?.())})}traceSome(e,t,s,i,o,a,r){if(this.tracer===void 0)try{this.tracer=De(e,Ue,yo)}catch(m){this.canBake=!1,this.base+=` (the view could not be path-traced: ${m.message})`;return}if(this.traceSize[0]!==i||this.traceSize[1]!==o){for(const[m,v]of[[this.sumRead,e.RGBA32F],[this.sumFill,e.RGBA32F],[this.auxRead,e.RG32F],[this.auxFill,e.RG32F]])e.bindTexture(e.TEXTURE_2D,m),e.texImage2D(e.TEXTURE_2D,0,v,i,o,0,v===e.RGBA32F?e.RGBA:e.RG,e.FLOAT,null);this.traceSize=[i,o],this.traced=void 0}const l=this.traceFb;this.traced===void 0&&(this.offscreen(e,l,i,o,()=>{e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,this.sumRead,0),e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT1,e.TEXTURE_2D,this.auxRead,0),e.drawBuffers([e.COLOR_ATTACHMENT0,e.COLOR_ATTACHMENT1]),e.clearBufferfv(e.COLOR,0,[0,0,0,0]),e.clearBufferfv(e.COLOR,1,[0,0,0,0])}),this.traced={samples:0,pass:0,rows:2,last:0});const c=this.traced;if(c.samples>=a)return;const u=performance.now();if(c.last>0){const m=u-c.last;m>45&&c.rows<8?c.rows*=2:m<22&&c.rows>1&&(c.rows/=2)}c.last=u;const d=this.tracer,f=m=>e.getUniformLocation(d,m);this.offscreen(e,l,i,o,()=>{e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,this.sumFill,0),e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT1,e.TEXTURE_2D,this.auxFill,0),e.drawBuffers([e.COLOR_ATTACHMENT0,e.COLOR_ATTACHMENT1]),e.useProgram(d),this.common(e,d,t,r,this.occFor!==void 0),e.uniformMatrix4fv(f("uInvVP"),!1,s.invViewProjection),e.uniformMatrix4fv(f("uVP"),!1,s.viewProjection),e.uniform2f(f("uSize"),i,o),e.uniform1ui(f("uSeed"),c.pass*7919+101),e.uniform1i(f("uRows"),c.rows),e.uniform1i(f("uRow"),c.pass%c.rows),e.uniform1i(f("uMaxBounces"),t.maxBounces),e.activeTexture(e.TEXTURE2),e.bindTexture(e.TEXTURE_2D,this.sumRead),e.uniform1i(f("uPrevSum"),2),e.activeTexture(e.TEXTURE3),e.bindTexture(e.TEXTURE_2D,this.auxRead),e.uniform1i(f("uPrevAux"),3),e.drawArrays(e.TRIANGLES,0,3)}),[this.sumRead,this.sumFill]=[this.sumFill,this.sumRead],[this.auxRead,this.auxFill]=[this.auxFill,this.auxRead],c.pass++,c.samples+=1/c.rows,Math.floor(c.samples)!==Math.floor(c.samples-1/c.rows)&&this.onChange?.()}compositeProgram(e,t){const s=JSON.stringify(t);if(this.composite!==void 0&&this.compositeFor===s)return!0;this.composite&&e.deleteProgram(this.composite),this.composite=void 0;try{return this.composite=De(e,Ue,bo(t)),this.compositeFor=s,!0}catch(i){return this.canBake=!1,this.base+=` (the path-traced view could not be drawn: ${i.message})`,!1}}fail(e){return this.failed=!0,this.base=`Object: ${e}`,this.onChange?.(),!1}reset(e){this.gl=e,this.program=void 0,this.programFor="",this.bake=void 0,this.uploaded=void 0,this.tfKey="",this.held=void 0,this.vao=e.createVertexArray();const t=i=>{const o=e.createTexture();return e.bindTexture(i,o),e.texParameteri(i,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(i,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(i,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(i,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texParameteri(i,e.TEXTURE_WRAP_R,e.CLAMP_TO_EDGE),o};this.vol=t(e.TEXTURE_3D),this.tf=t(e.TEXTURE_2D),this.occ=t(e.TEXTURE_3D),this.occFor=void 0,this.canBake=e.getExtension("EXT_color_buffer_float")!==null,this.lightRead=t(e.TEXTURE_3D),this.lightFill=t(e.TEXTURE_3D),this.fb=e.createFramebuffer();const s=()=>{const i=t(e.TEXTURE_2D);return e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),i};[this.sumRead,this.sumFill,this.auxRead,this.auxFill]=[s(),s(),s(),s()],this.traceSize=[0,0],this.traceFb=e.createFramebuffer(),this.tracer=void 0,this.composite=void 0,this.compositeFor="",this.traced=void 0}close(){this.url="",this.base="",this.level=void 0,this.bounds=void 0,this.held=void 0,this.traced=void 0,this.traceKey="",clearTimeout(this.settle),this.failed=!1,this.client?.dispose(),this.client=void 0;const e=this.gl;if(e!==void 0){for(const t of[this.program,this.bake,this.tracer,this.composite])t&&e.deleteProgram(t);for(const t of[this.vol,this.tf,this.occ,this.lightRead,this.lightFill,this.sumRead,this.sumFill,this.auxRead,this.auxFill])t&&e.deleteTexture(t);this.vao&&e.deleteVertexArray(this.vao);for(const t of[this.fb,this.traceFb])t&&e.deleteFramebuffer(t)}this.gl=void 0,this.program=void 0,this.bake=void 0,this.tracer=void 0,this.composite=void 0,this.uploaded=void 0}}function De(n,e,t){const s=(a,r)=>{const l=n.createShader(a);if(n.shaderSource(l,r),n.compileShader(l),!n.getShaderParameter(l,n.COMPILE_STATUS))throw new Error(n.getShaderInfoLog(l)??"shader");return l},i=n.createProgram(),o=[s(n.VERTEX_SHADER,e),s(n.FRAGMENT_SHADER,t)];for(const a of o)n.attachShader(i,a);n.linkProgram(i);for(const a of o)n.deleteShader(a);if(!n.getProgramParameter(i,n.LINK_STATUS)){const a=n.getProgramInfoLog(i);throw n.deleteProgram(i),new Error(a??"link")}return i}function To(n,e,t){const s=e+t;if(e<0||s<0||e>=n.length||s>=n.length)return n.slice();const i=n.slice();return[i[e],i[s]]=[{...n[s],time:n[e].time},{...n[e],time:n[s].time}],i}const Eo=.9,Ms=[{axis:"x",keep:-1,offset:0,on:!1},{axis:"y",keep:-1,offset:0,on:!1},{axis:"z",keep:-1,offset:0,on:!1}];function So(n){const e=i=>Array.isArray(i)&&i.length===3&&i.every(o=>typeof o=="number"&&Number.isFinite(o));if(Array.isArray(n.planes))return n.planes.filter(i=>i&&e(i.normal)&&e(i.point)).map((i,o)=>({name:String(i.name??`Plane ${o+1}`),on:i.on!==!1,normal:i.normal,point:i.point,offset:Number.isFinite(i.offset)?i.offset:0}));const t=n.viewCut;if(!t?.on)return[];const s=t.fixed;return Array.isArray(s)&&s.length===4?[{name:"Plane 1",on:!0,normal:[s[0],s[1],s[2]],point:[-s[3]*s[0],-s[3]*s[1],-s[3]*s[2]],offset:0}]:[{name:"Plane 1",on:!0,normal:[0,0,0],point:[0,0,0],offset:typeof t.offset=="number"?t.offset:0}]}function ks(n){const e=n??{},t=(i,o)=>typeof i=="number"&&Number.isFinite(i)?i:o,s=Array.isArray(e.cuts)&&e.cuts.length===3?e.cuts.map((i,o)=>({...Ms[o],...i})):Ms.map(i=>({...i}));return{on:e.on===!0,where:e.where==="browser"?"browser":"host",layer:typeof e.layer=="string"?e.layer:void 0,labels:typeof e.labels=="string"?e.labels:void 0,preset:typeof e.preset=="string"?e.preset:"",density:typeof e.density=="number"?e.density:void 0,exposure:t(e.exposure,1),windows:Object.fromEntries(Object.entries(e.windows&&typeof e.windows=="object"?e.windows:{}).filter(i=>Array.isArray(i[1])&&i[1].length===2&&i[1].every(o=>typeof o=="number"&&Number.isFinite(o))&&i[1][1]>i[1][0])),volumeAt:Object.fromEntries(Object.entries(e.volumeAt&&typeof e.volumeAt=="object"?e.volumeAt:{}).filter(i=>!!i[1]&&typeof i[1]=="object").map(([i,o])=>[i,{channel:Math.max(0,Math.round(t(o.channel,0))),time:Math.max(0,Math.round(t(o.time,0)))}])),tunings:Object.fromEntries(Object.entries(e.tunings&&typeof e.tunings=="object"?e.tunings:{}).filter(i=>!!i[1]&&typeof i[1]=="object").map(([i,o])=>[i,{shift:t(o.shift,0),scale:t(o.scale,1),stops:Array.isArray(o.stops)?o.stops.filter(a=>a&&typeof a.value=="number"):void 0,warp:Array.isArray(o.warp)?o.warp.filter(a=>a&&Number.isFinite(a.from)&&Number.isFinite(a.to)):void 0}])),lightAzimuth:t(e.lightAzimuth,30),lightElevation:t(e.lightElevation,40),lightMap:typeof e.lightMap=="string"?e.lightMap:"",lightMapRotation:t(e.lightMapRotation,0),lightStyle:typeof e.lightStyle=="string"?e.lightStyle:"",envScale:t(e.envScale,1),lightKey:t(e.lightKey,1),planes:So(e),cuts:s,regions:e.regions===!0,labelMix:t(e.labelMix,.85),keep:Array.isArray(e.keep)?e.keep.filter(i=>typeof i=="number"):[],hidden:Array.isArray(e.hidden)?e.hidden.filter(i=>typeof i=="number"):[],budget:t(e.budget,4e8),detail:e.detail!==!1,detailBudget:t(e.detailBudget,2e8),jar:e.jar===!0,maxSamples:t(e.maxSamples,512),denoise:e.denoise!==!1,restPicture:e.restPicture===!0,objectVoxels:t(e.objectVoxels,Ys),keyframes:Array.isArray(e.keyframes)?e.keyframes.filter(i=>i&&typeof i.time=="number"&&i.view&&typeof i.view=="object"):[],boxes:Array.isArray(e.boxes)?e.boxes.filter(i=>i&&Array.isArray(i.lo)&&Array.isArray(i.hi)).map((i,o)=>({name:String(i.name??`Crop ${o+1}`),on:i.on!==!1,keep:i.keep!==!1,lo:i.lo,hi:i.hi})):e.box?.on?[{name:"Crop 1",on:!0,keep:!0,lo:e.box.lo??[0,0,0],hi:e.box.hi??[1,1,1]}]:[],customPresets:Array.isArray(e.customPresets)?e.customPresets.filter(i=>i&&typeof i.name=="string"):[],rotation:{axis:"vertical",degrees:360,step:2,...e.rotation??{}},movie:{fps:25,width:1280,height:720,samples:128,easing:"smooth",...e.movie??{}},splat:{views:256,size:1024,samples:512,cover:180,steps:3e4,...e.splat??{}}}}const Ce={command:"settings.open",args:{section:"compute"}};function Ls(n){return n.split(/[\s,]+/).filter(Boolean).map(Number).filter(e=>Number.isInteger(e))}function Fs(n,e,t){const s=x("input",{class:"text-input",type:"text",value:n.join(", "),placeholder:"label ids","aria-label":t});return s.onchange=()=>e(Ls(s.value)),s.set=i=>{s.ownerDocument.activeElement!==s&&Ls(s.value).join()!==i.join()&&(s.value=i.join(", "))},s}function pe(n,e){const t=te([],"",n,e);let s="";return t.update=(i,o)=>{const a=JSON.stringify(i);a!==s&&(s=a,t.replaceChildren(...i.map(([r,l])=>x("option",{value:r},l))),t.value=o),t.set(o)},t}function Ie(n,e,t,s){const i=Ns(e(n),o=>{const a=e(o);i.value=String(a),t(a)},s);return i}const _o=`
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
`;function Us(n,e){return new Promise(t=>{const s=setTimeout(t,n);e?.addEventListener("abort",()=>(clearTimeout(s),t()),{once:!0})})}const Po=200,Ds=120;function Cs(n){const e=n[11],t=$s(n);return{eye:Math.abs(e)<1e-12?void 0:[n[8]/e,n[9]/e,n[10]/e],forward:t}}function Ro(n,e){const t=Cs(n),s=Cs(e.invViewProjection);if(t.forward[0]*s.forward[0]+t.forward[1]*s.forward[1]+t.forward[2]*s.forward[2]<Math.cos(20*Math.PI/180))return!0;const o=e.position;if(t.eye&&s.eye){const u=Math.hypot(t.eye[0]-o[0],t.eye[1]-o[1],t.eye[2]-o[2]),d=Math.hypot(s.eye[0]-o[0],s.eye[1]-o[1],s.eye[2]-o[2]);if(d<u/2||d>u*2)return!0}const a=Gs(n),r=a[0]*o[0]+a[4]*o[1]+a[8]*o[2]+a[12],l=a[1]*o[0]+a[5]*o[1]+a[9]*o[2]+a[13],c=a[3]*o[0]+a[7]*o[1]+a[11]*o[2]+a[15];return!(c>0)||Math.abs(r/c)>.8||Math.abs(l/c)>.8}const Is="host",Qe="jobs",Ao=15e3,zs="Movies need ffmpeg on the render computer.",Os="No paired computer has the render service: pair one (Settings › Compute), or render in this browser.";class Mo{constructor(e){this.ctx=e,this.saved=ks(e.state.get()),this.host={name:e.settings.get(Is)?.name||void 0},this.jobs=ki(e.settings.get(Qe)),this.drawer.onFrame=t=>this.onFrame(t),this.drawer.onFading=()=>this.handle?.redraw(),this.drawer.live=this.live,this.live.look=t=>this.liveLook(t),this.live.onChange=()=>{this.handle?.redraw(),this.statusUpdate?.()},this.live.onRedraw=()=>this.handle?.redraw(),this.toggle=e.ui.viewToggle({label:"Render",title:"Path-traced rendering (Anatomical rendering)",value:this.saved.on,onChange:t=>this.setOn(t)}),this.offs.push(e.viewer.onLayersChanged(()=>this.update()),e.viewer.onCursorChanged(()=>{const t=e.viewer.cursor();t.active&&t.position.length>=3&&t.position.slice(0,3).every(Number.isFinite)&&(this.lastCursor=t.position.slice(0,3))}),e.state.onChanged(()=>{this.saved=ks(e.state.get()),this.update()}),e.commands.register("anatomicalRendering.toggle",()=>this.setOn(!this.saved.on)),e.ui.panel(ni,t=>this.panel(t)),this.listen("pagehide",()=>this.closeSession(!0)),this.listen("pageshow",t=>t.persisted&&this.update()),e.hosts.onChanged(()=>{const t=this.link()?.label;this.connecting===void 0&&t!==void 0&&(this.serviceInfo===void 0||t!==this.service?.link.label)&&this.connect(),this.panelUpdate?.()}),()=>clearTimeout(this.settle),()=>this.live.close()),this.connect();try{localStorage.getItem("ngplatform.debug")&&(window.anatomicalRendering=this)}catch{}}saved;host;drawer=new Ri;handle;handleLayer;service;serviceInfo;presets=[];session;opened;reopened=0;stillRunning=!1;jobs;following=new Set;sides=new Map;sessionKey="";counts=new Map;abort;lastKey="";lastScale=1;lastFrame;lastSpec;sending=!1;viewRefused=!1;pendingView;queued;lastLook="";lastCamera="";cameraChanged=0;turning=!1;settle;depth;distance;views=new Map;live=new xo;fixedLight;lastCursor;cursorOffsets(){const e=this.lastFrame,t=this.lastCursor;if(!e||!t)return;const s=ms(e.dimensions),i=[0,1,2].map(a=>t[a]-e.position[a]),o=$s(e.invViewProjection);return{axis:i.map(a=>Math.round(a*s*10)/10),view:Math.round((o[0]*i[0]+o[1]*i[1]+o[2]*i[2])*s*10)/10}}frameText="";problem="";local;localKey="";localText="";toggle;panelUpdate;statusUpdate;offs=[];listen(e,t){return window.addEventListener(e,t),()=>window.removeEventListener(e,t)}save(e){e(this.saved),this.ctx.state.set({...this.saved}),this.handle?.redraw()}setOn(e){const t=this.target(),s=t===void 0?"Anatomical rendering needs an OME-Zarr or N5 image in the scene.":this.axesOf(t).problem;if(e&&s!==void 0){this.toggle.set(!1),this.panelUpdate?.(),this.ctx.ui.toast(s,"error");return}this.save(i=>i.on=e),this.toggle.set(e),e&&this.ensure3d(),this.update()}ensure3d(){const e=JSON.stringify(this.ctx.viewer.getState().layout??"");/3d|4panel/.test(e)||this.ctx.viewer.patchState(t=>void(t.layout="xy-3d"))}images(){return this.ctx.viewer.layers().filter(e=>e.type==="image"&&G(e.sources[0])!==void 0)}segmentations(){return this.ctx.viewer.layers().filter(e=>e.type==="segmentation"&&G(e.sources[0])!==void 0)}target(){const e=this.images();return e.find(t=>t.name===this.saved.layer)??e[0]}axesOf(e){return vs(this.ctx.viewer.layerTransform?.(e.name)?.input,this.saved.where==="browser")}volumeCounts(e){if(this.saved.where==="browser")return;const t=this.axesOf(e),s=G(e.sources[0]),o=(s===void 0?void 0:this.counts.get(s))??{channels:t.channels??1,times:t.times??1};return o.channels>1||o.times>1?o:void 0}volumeAt(e){const t=G(e.sources[0]),s=t===void 0?void 0:this.saved.volumeAt[t],i=this.volumeCounts(e);return s===void 0||i===void 0?{channel:0,time:0}:{channel:Math.min(s.channel,i.channels-1),time:Math.min(s.time,i.times-1)}}setVolumeAt(e,t){const s=G(e.sources[0]);if(s===void 0)return;const i={...this.volumeAt(e),...t};this.save(o=>o.volumeAt[s]=i),this.update()}viewButtons(){const e=this.target(),t=e?G(e.sources[0]):void 0;return t!==void 0&&!this.sides.has(t)&&this.readSides(t),ri(this.lastFrame?.dimensions.names??["x","y","z"],t===void 0?void 0:this.sides.get(t)??void 0)}async readSides(e){this.sides.set(e,null);const t=ci(e);if(!(t===void 0||typeof fetch!="function"))for(const[s,i]of[["zarr.json",o=>o.attributes],[".zattrs",o=>o]])try{const o=await fetch(`${t}/${s}`,{signal:AbortSignal.timeout(8e3)});if(!o.ok)continue;const a=li(i(await o.json()));if(a===void 0)return;this.sides.set(e,a),this.panelUpdate?.();return}catch{}}lookFrom(e){this.ctx.viewer.patchState(t=>void(t.projectionOrientation=hi(e.forward,e.up)))}renderHosts(){return this.ctx.hosts.list().filter(e=>e.info?.services?.render!==void 0)}link(){const e=(this.host.name?this.ctx.hosts.get(this.host.name):void 0)??this.ctx.hosts.pick({service:"render"});return e===void 0?void 0:mi(e.name,e.address,(t,s)=>e.fetch(t,s))}connects=0;connecting;connectProblem="";async connect(){const e=++this.connects;this.connecting=e,this.closeSession();const t=this.link(),s=t===void 0?void 0:new yi(t);this.service=s,this.serviceInfo=void 0,this.problem="",this.connectProblem="",this.statusUpdate?.();let i,o,a="";try{if(s===void 0)throw new Error(Os);i=await s.info(AbortSignal.timeout(8e3)),o=await s.presets()}catch(r){a=s===void 0?Os:`No render service on ${s.link.label}: ${r.message}`}e!==this.connects||this.disposed||(this.connecting=void 0,this.serviceInfo=i,this.connectProblem=a,o!==void 0&&(this.presets=o,!this.saved.preset&&o.length>0&&(this.saved.preset=o[0].name)),this.sessionKey="",this.update(),this.panelUpdate?.(),s!==void 0&&i!==void 0&&this.resumeJobs(s))}async refreshInfo(e=this.service){if(!(e===void 0||e!==this.service||this.serviceInfo===void 0))try{const t=await e.info(AbortSignal.timeout(8e3));if(e!==this.service||this.serviceInfo===void 0||this.disposed)return;this.serviceInfo=t,this.panelUpdate?.()}catch{}}update(){const e=this.target(),t=this.saved.where==="browser",s=e!==void 0&&this.axesOf(e).problem===void 0?e:void 0;if(!this.saved.on||s===void 0||!t&&this.serviceInfo===void 0){this.handle?.dispose(),this.handle=void 0,this.handleLayer=void 0,this.drawer.set(void 0),(!this.saved.on||s===void 0)&&(this.closeSession(),this.closeLocal(),this.live.close()),this.panelUpdate?.();return}this.handleLayer!==s.name&&(this.handle?.dispose(),this.handleLayer=s.name,this.handle=this.ctx.viewer.draw3d(s.name,{draw:i=>this.drawer.draw(i),isReady:()=>this.drawer.isReady(),dispose:()=>{}})),t?(this.closeSession(),this.ensureLocal(s)):(this.closeLocal(),this.ensureSession(s),vs(this.ctx.viewer.layerTransform?.(s.name)?.input,!0).problem===void 0?this.live.open(G(s.sources[0]),this.saved.objectVoxels):this.live.close()),this.handle?.redraw(),this.panelUpdate?.()}presetDomain(){const e=this.saved,s=e.customPresets.find(i=>i.name===e.preset)?.domain??(e.where==="browser"?ve.find(i=>i.name===e.preset)?.domain:this.presets.find(i=>i.name===e.preset)?.domain);return typeof s=="string"?s:void 0}references(){if(this.saved.where==="browser")return[];const e=this.presets.find(s=>s.name===this.saved.preset);return(Array.isArray(e?.reference)?e.reference:[]).map(s=>({title:(s.title??"a photograph").replace(/^File:/,""),page:di(s.page),author:s.author??"unknown",licence:s.licence??""}))}resolved;editor;presetRequest(){const e=this.saved,t=this.target()?G(this.target().sources[0]):void 0;if(this.session?.status!=="ready"||t===void 0)return;const s=e.customPresets.find(o=>o.name===e.preset)??(e.preset||"HiP-CT brain"),i=e.windows[t]&&this.presetDomain()==="window"?{window:e.windows[t]}:{};return{key:JSON.stringify([this.session.id,s,i]),preset:s,overrides:i}}async resolvePreset(){const e=this.presetRequest();if(!(e===void 0||this.resolved?.key===e.key||!this.service))try{const t=await this.service.resolve(this.session.id,e.preset,e.overrides);this.resolved={key:e.key,preset:t},this.panelUpdate?.(),this.lastKey="",this.handle?.redraw()}catch{}}currentTuning(){const e=this.target()?G(this.target().sources[0]):void 0;if(e!==void 0)return{src:e,tuning:this.saved.tunings[e]??{shift:0,scale:1}}}editedStops(){const e=this.presetRequest();if(!this.resolved||e===void 0||this.resolved.key!==e.key)return;const t=this.resolved.preset.stops??[],s=this.currentTuning()?.tuning,i=s?.stops??t,o=t.filter(c=>c.opacity>.01),a=o.length?(o[0].value+o[o.length-1].value)/2:0,r=Ki(i,s?.shift??0,s?.scale??1,a);let l=s?.warp;if(!l){const c=this.session?.volume?.histogram;l=c&&o.length?Hi(c,o[0].value,o[o.length-1].value).map(u=>({from:u,to:u})):[]}return{stops:r,base:i,centre:a,warp:l,data:r.map(c=>({...c,value:Xi(c.value,l)}))}}tunedPreset(){const e=this.currentTuning()?.tuning;if(!e||!e.stops&&e.shift===0&&e.scale===1&&!(e.warp??[]).some(l=>l.to!==l.from))return;const t=this.editedStops();if(!t||!this.resolved)return;const{reference:s,measured:i,histogram:o,design_scan:a,...r}=this.resolved.preset;return{...r,stops:t.data,domain:"data",window:null,histogram:null}}editorUpdate;colourmapEditor(){return this.editor??=new Ji(e=>{const t=this.currentTuning();if(!t)return;const s=this.editedStops(),i=t.tuning.scale||1,o=e.map(a=>({...a,value:(s?s.centre:0)+(a.value-t.tuning.shift-(s?s.centre:0))/i}));this.save(a=>a.tunings[t.src]={...t.tuning,stops:o})},e=>{const t=this.currentTuning();t&&this.save(s=>s.tunings[t.src]={...t.tuning,warp:e})}),this.editor}mapWidth(){const e=this.editedStops()?.base.filter(t=>t.opacity>.01)??[];return e.length&&e[e.length-1].value-e[0].value||1}tune(e,t=!1){const s=this.currentTuning();if(!s)return;const i=o=>{const a={...o.tunings[s.src]??{shift:0,scale:1}};e(a),o.tunings[s.src]=a};t?this.preview(i):this.save(i),this.editorUpdate?.()}preview(e){e(this.saved),this.handle?.redraw()}windowRange(){if(this.presetDomain()!=="window"||this.saved.where==="browser")return;const e=this.target(),t=e?G(e.sources[0]):void 0;if(t===void 0)return;const s=this.session?.volume,i=s?.lo!==void 0&&s.hi!==void 0&&s.hi>s.lo;return{src:t,lo:i?s.lo:0,hi:i?s.hi:65535,step:i?Ci(s.lo,s.hi,s.dtype):1,guess:s?.window??void 0}}setWindow(e,t,s,i){this.save(o=>{const a=o.windows[e]??i??[s,s+1],r=[a[0],a[1]];r[t]=s,r[1]>r[0]&&(o.windows[e]=r)})}labelsSource(){if(!this.saved.regions)return;const e=this.segmentations(),t=e.find(s=>s.name===this.saved.labels)??e[0];return t?G(t.sources[0]):void 0}async ensureSession(e){const t=this.service,s=G(e.sources[0]),i=this.labelsSource(),o=this.saved.detail?this.saved.detailBudget:0,a=this.volumeAt(e),r=JSON.stringify([t.link.base,s,i,this.saved.budget,this.saved.jar,o,a.channel,a.time]);if(r===this.sessionKey)return;this.closeSession(),this.sessionKey=r;const l=new AbortController;this.abort=l;try{let c=await t.open({url:s,budget:this.saved.budget,detail_budget:o,...this.saved.jar?{cylinder:Eo}:{},...a.channel?{channel:a.channel}:{},...a.time?{time:a.time}:{}},i?{url:i}:void 0);if(l.signal.aborted){t.close(c.id).catch(()=>{});return}for(this.opened={service:t,id:c.id},this.session=c;c.status==="loading"&&!l.signal.aborted&&(this.statusUpdate?.(),await new Promise(d=>setTimeout(d,400)),c=await t.session(c.id),!l.signal.aborted);)this.session=c;const u=c.volume;if(c.status==="ready"&&u.channels!==void 0&&u.times!==void 0&&!l.signal.aborted){this.counts.set(s,{channels:u.channels,times:u.times});const d=this.volumeAt(e);if(d.channel!==a.channel||d.time!==a.time)return this.update()}if(this.panelUpdate?.(),c.status!=="ready"||l.signal.aborted)return;this.refreshInfo(t),await this.resolvePreset(),this.lastKey="",this.handle?.redraw(),this.frameLoop(t,c.id,l.signal)}catch(c){if(l.signal.aborted)return;this.problem=c.message,this.statusUpdate?.()}}async ensureLocal(e){const t=G(e.sources[0]),s=JSON.stringify([t,this.saved.objectVoxels]);if(s===this.localKey)return;this.closeLocal(),this.localKey=s;const i=new no;this.local=i,i.onFrame=o=>{this.local===i&&(this.drawer.set({bitmap:o.bitmap,depth:o.depth,camera:o.camera,look:o.tag}),this.frameText=`${o.samples} samples, ${o.width}×${o.height}, ${o.msPerPass.toFixed(0)} ms a pass (this browser)`,this.handle?.redraw(),this.statusUpdate?.())};try{this.localText="Loading in this browser…",this.statusUpdate?.(),this.localText=await i.load(t,this.saved.objectVoxels,o=>{this.localText=o,this.statusUpdate?.()}),i.level!==void 0&&this.live.setLevel(i.level,t),this.lastKey="",this.handle?.redraw()}catch(o){this.localText="",this.problem=`This browser cannot render it: ${o.message}`,this.live.open(t,this.saved.objectVoxels)}this.statusUpdate?.()}closeLocal(){this.local?.dispose(),this.local=void 0,this.localKey="",this.localText=""}closeSession(e=!1){this.abort?.abort(),this.abort=void 0;const t=this.opened;t&&t.service.close(t.id,e).catch(()=>{}),this.opened=void 0,this.session=void 0,this.sessionKey="",this.views.clear(),this.distance=void 0,this.depth=void 0,this.queued=void 0,this.viewRefused=!1,this.lastKey="",this.lastLook="",this.lastScale=1,this.frameText="",clearTimeout(this.settle),this.drawer.set(void 0)}retryJob(){const e=this.refused;this.refused=void 0,this.statusUpdate?.(),e?.retry()}retry(){this.problem="",this.reopened=0,this.viewRefused&&this.session?.status==="ready"?(this.viewRefused=!1,this.lastKey="",this.lastLook="",this.handle?.redraw()):this.saved.where==="browser"?(this.closeLocal(),this.update()):this.serviceInfo===void 0?this.connect():(this.closeSession(),this.update()),this.statusUpdate?.()}sessionLost(){if(this.reopened>=1){this.problem="The render computer closed the session.",this.statusUpdate?.();return}this.reopened+=1,this.opened=void 0,this.closeSession(),this.update()}async sessionFailed(e,t,s){const i=await e.session(t).catch(()=>{});this.opened?.id===t&&(i?.status==="failed"?this.session=i:this.problem=s,this.drawer.set(void 0),this.handle?.redraw(),this.statusUpdate?.())}async frameLoop(e,t,s){let i=0,o=0;for(;!s.aborted;)try{const a=await e.frame(t,i,s,this.distance?.version??-1);if(o>0&&(o=0,this.problem="",this.statusUpdate?.()),a===void 0)continue;this.reopened=0,this.problem="",i=a.number,a.distance!==void 0&&(this.distance=a.distance);let r=this.views.get(a.version);r===void 0&&this.pendingView!==void 0&&(await this.pendingView,r=this.views.get(a.version));const l=r?.camera;if(l!==void 0&&this.distance?.version!==a.version){const u=await e.distance(t).catch(()=>{});u!==void 0&&(this.distance=u)}const c=l&&this.distance&&this.distance.version===a.version?{invViewProjection:l,distance:this.distance}:void 0;if(c===void 0){if(this.drawer.placed()!==void 0){a.bitmap.close?.();continue}if(this.depth===void 0||this.depth.version!==a.version){const u=await e.depth(t);u!==void 0&&(this.depth=u)}}this.drawer.set({bitmap:a.bitmap,alpha:a.alpha?{width:a.width,height:a.height,data:a.alpha}:void 0,depth:c?void 0:this.depth,view:c,camera:l,look:r?.look}),this.frameText=`${a.samples} samples, ${a.width}×${a.height}, ${a.msPerPass.toFixed(0)} ms a pass${a.detail?`
Detail: ${a.detail}`:""}`,this.handle?.redraw(),this.statusUpdate?.()}catch(a){if(s.aborted)return;const r=a instanceof Z?a.status:0;if(r===404)return this.sessionLost();if(r===410)return void this.sessionFailed(e,t,a.message);const l=Ii(++o);if(this.problem=l===void 0?`Lost touch with ${e.link.label??"the render computer"}: ${a.message}`:`${a.message} (trying again in ${Math.round(l/1e3)} s)`,this.statusUpdate?.(),l===void 0)return;await Us(l,s)}}viewSpec(e,t){const s=gs(e.dimensions);if(s===void 0){this.problem=`The 3-D view shows ${e.dimensions.names.join(", ")}; rendering needs x, y and z.`;return}const i=this.saved,o={exposure:i.exposure};i.density!==void 0&&(o.density=i.density);const a=this.target()?G(this.target().sources[0]):void 0;a!==void 0&&i.windows[a]&&this.presetDomain()==="window"&&(o.window=i.windows[a]);const r=this.tunedPreset();return{inv_view_projection:Array.from(e.invViewProjection),width:e.width,height:e.height,scale:t,world_from_physical:s,orbit_center:Array.from(e.position),unit_mm:ms(e.dimensions),preset:r??i.customPresets.find(l=>l.name===i.preset)??(i.preset||"HiP-CT brain"),overrides:r?{exposure:i.exposure,...i.density!==void 0?{density:i.density}:{}}:o,boxes:i.boxes.filter(l=>l.on).map(l=>({lo:l.lo,hi:l.hi,keep:l.keep})),light:this.live.ready()?{direction:this.objectLight(e),camera_space:!1,rgb:[3.2*i.lightKey,3*i.lightKey,2.8*i.lightKey]}:{direction:ws(i.lightAzimuth,i.lightElevation),camera_space:!0,rgb:[3.2*i.lightKey,3*i.lightKey,2.8*i.lightKey]},environment:i.lightMap?{map:i.lightMap,rotation:i.lightMapRotation,scale:i.envScale}:{scale:i.envScale},clips:[...ui(i.cuts,e.position,e.dimensions),...i.planes.filter(l=>l.on&&l.normal.some(c=>c!==0)).map(l=>pi(l,e.dimensions))].slice(0,N.maxClips),labels:i.regions?{show:!0,mix:i.labelMix,keep:i.keep,hidden:i.hidden}:{show:!1},background:[0,0,0,0],max_samples:i.maxSamples,denoise:i.denoise,frame_format:"jpeg"}}onFrame(e){this.lastFrame=e;const t=JSON.stringify([this.saved.boxes,this.saved.customPresets.length,this.saved.preset,this.saved.density,this.saved.exposure,this.saved.windows,this.saved.tunings,this.resolved?.key,this.saved.lightAzimuth,this.saved.lightElevation,this.saved.lightMap,this.saved.lightMapRotation,this.saved.lightStyle,this.saved.envScale,this.saved.lightKey,this.saved.planes,this.saved.cuts,this.saved.regions,this.saved.labelMix,this.saved.keep,this.saved.hidden,this.saved.maxSamples,this.saved.denoise,e.position]);this.drawer.look=t,this.drawer.pictureAtRest=this.saved.restPicture,this.saved.planes.some(m=>m.normal.every(v=>v===0))&&this.save(m=>m.planes=m.planes.map(v=>v.normal.every(w=>w===0)?{...ys(e.invViewProjection,e.position,v.name),on:v.on,offset:v.offset}:v));const s=this.saved.where==="browser"?this.local:void 0,i=s?"local":this.session?.status==="ready"?this.session.id:void 0;if(i===void 0||s&&!s.ready)return;if(this.live.ready()&&!this.saved.restPicture){const m=this.viewSpec(e,1);m!==void 0&&(this.lastSpec=m);return}const o=fi(e.invViewProjection,e.width,e.height),a=performance.now();o!==this.lastCamera&&(this.turning=a-this.cameraChanged<Ds,this.lastCamera=o,this.cameraChanged=a);const r=e.moving||this.turning&&a-this.cameraChanged<Ds,l=o+t,c=r?.5:1;if(l===this.lastKey&&!(this.lastScale<1&&!r))return;const u=t===this.lastLook;this.lastKey=l,this.lastLook=t,this.lastScale=c,clearTimeout(this.settle),c<1&&(this.settle=setTimeout(()=>{const m=this.lastFrame;if(m===void 0||this.lastScale===1)return;const v=this.viewSpec(m,1);v!==void 0&&(this.lastScale=1,this.lastSpec=v,this.send(i,v,this.lastLook))},Po));const d=this.drawer.placed();if(r&&(this.live.ready()||u&&d!==void 0&&!Ro(d,e)))return;const f=this.viewSpec(e,c);f!==void 0&&(c===1&&(this.lastSpec=f),this.send(i,f,t))}objectLight(e){const t=this.saved,s=JSON.stringify([t.lightAzimuth,t.lightElevation]);if(this.fixedLight?.key!==s){const[i,o,a]=rt(Re(e.invViewProjection)),r=ws(t.lightAzimuth,t.lightElevation);this.fixedLight={key:s,direction:[0,1,2].map(l=>r[0]*i[l]+r[1]*o[l]+r[2]*a[l])}}return this.fixedLight.direction}liveLook(e){const t=this.viewSpec(e,1);if(t===void 0)return;const s=this.saved.where!=="browser",i=s?this.presetRequest():void 0,o=i!==void 0&&this.resolved?.key===i.key?this.resolved.preset:void 0,a=c=>(s?this.presets.find(u=>u.name===c):void 0)??ve.find(u=>u.name===c),l={...(typeof t.preset=="object"?t.preset:o??a(t.preset))??ve[0],...t.overrides??{}};return Array.isArray(l.stops)?{view:t,preset:l}:void 0}send(e,t,s){if(e==="local"){this.local?.setView(t,s);return}if(this.sending){this.queued={spec:t,look:s};return}this.sending=!0,this.pendingView=this.opened.service.setView(e,t).then(i=>{if(this.opened?.id===e){this.viewRefused&&(this.viewRefused=!1,this.problem="",this.statusUpdate?.()),this.views.set(i.version,{camera:t.inv_view_projection,look:s});for(const o of this.views.keys())o<i.version-64&&this.views.delete(o)}}).catch(i=>{this.opened?.id===e&&(this.viewRefused=ze(i)!==void 0,this.problem=i.message,this.statusUpdate?.())}).finally(()=>{this.sending=!1,this.pendingView=void 0;const i=this.queued;this.queued=void 0;const o=this.session?.status==="ready"?this.session.id:void 0;i!==void 0&&o!==void 0&&this.send(o,i.spec,i.look)})}camera(){const e=this.ctx.viewer.getState();if(Array.isArray(e?.position))return{position:e.position.slice(),orientation:Array.isArray(e.projectionOrientation)?e.projectionOrientation.slice():[0,0,0,1],scale:typeof e.projectionScale=="number"?e.projectionScale:256}}planeHere(e){const t=this.lastFrame;if(t===void 0){this.ctx.ui.toast("Look at the image in the 3-D view first.","error");return}return ys(t.invViewProjection,this.lastCursor??t.position,e)}addPlane(){const e=new Set(this.saved.planes.map(i=>i.name));let t=this.saved.planes.length+1;for(;e.has(`Plane ${t}`);)t++;const s=this.planeHere(`Plane ${t}`);s!==void 0&&this.saved.planes.length<N.maxClips&&this.save(i=>i.planes.push(s))}setPlaneToView(e){const t=this.planeHere(this.saved.planes[e].name);t!==void 0&&this.save(s=>s.planes[e]=t)}addKeyframe(e){const t=this.lastSpec;if(t===void 0){this.ctx.ui.toast("Render a view first: switch Render on and look at the image in 3-D.","error");return}const s=this.camera(),i={view:{...t,scale:1},...s?{camera:s}:{}};if(e!==void 0)return this.save(a=>a.keyframes[e]={time:a.keyframes[e].time,...i});const o=this.saved.keyframes.at(-1)?.time??-2;this.save(a=>a.keyframes.push({time:o+2,...i}))}goToKeyframe(e){const t=this.saved.keyframes[e]?.camera;if(t===void 0){this.ctx.ui.toast("This keyframe was made before keyframes kept their camera: replace it to go back to it.","error");return}this.ctx.viewer.patchState(s=>{const i=s;i.position=t.position.slice(),i.projectionOrientation=t.orientation.slice(),i.projectionScale=t.scale})}currentSpec(){const e=this.lastFrame;return e?this.viewSpec(e,1):this.lastSpec}centreOnTissue(){const e=this.session?.volume?.tissue_mm,t=this.lastFrame;if(!e||t===void 0){this.ctx.ui.toast("Render first: the tissue's box comes with the rendered image.","error");return}const s=gs(t.dimensions);if(s===void 0)return;const i=c=>[0,1,2].map(u=>s[u]*c[0]+s[4+u]*c[1]+s[8+u]*c[2]+s[12+u]),o=i(e[0]),a=i(e[1]),r=o.map((c,u)=>(c+a[u])/2),l=Math.max(...o.map((c,u)=>Math.abs(a[u]-c)));this.ctx.viewer.patchState(c=>{const u=c,d=Array.isArray(u.position)?u.position.slice():[0,0,0];for(let f=0;f<3;++f)d[f]=r[f];u.position=d,u.projectionScale=l*1.4})}async saveStill(){const e=this.session?.status==="ready"?this.session.id:void 0,t=this.opened?.service,s=this.currentSpec();if(e===void 0||t===void 0||s===void 0)return this.ctx.ui.toast("Render a view on a computer first.","error");if(this.stillRunning)return this.ctx.ui.toast("A still is already rendering.","error");const i=Ke(this.saved.movie),o=Math.min(N.maxSamples,i.samples*2),a=Di(i.width,i.height,o);if(a)return this.ctx.ui.toast(a,"error");this.stillRunning=!0,this.panelUpdate?.();const r=`Still ${i.width} × ${i.height}, ${o} samples`;try{await this.ctx.jobs.run(r,async l=>{const c=await t.still(e,{view:s,width:i.width,height:i.height,samples:o,name:"anatomical-rendering"}),u=await this.follow("still",t,c,r,l);if(u.status!=="done")throw new Error(u.error??u.status);ce(await t.stillFile(c.id),"anatomical-rendering.png")})}catch(l){this.jobFailed("Still",l,()=>void this.saveStill())}finally{this.stillRunning=!1,this.panelUpdate?.()}}refused;jobFailed(e,t,s){const i=ze(t);i?.retry?(this.refused={text:`${e}: ${i.text}`,retry:s},this.statusUpdate?.()):this.ctx.ui.toast(`${e}: ${t.message}`,"error")}recordJob(e){this.jobs=Li(this.jobs,e),this.ctx.settings.set(Qe,this.jobs),this.jobsUpdate?.()}jobsUpdate;async follow(e,t,s,i,o){const a=t.link.label??"",r=`${e}:${a}:${s.id}`,l=d=>({kind:e,id:s.id,host:a,name:i,status:d.status,progress:d.progress,message:d.message,...d.error?{error:d.error}:{},...d.files?{files:d.files}:{},...d.status==="queued"&&(d.jobs_ahead??d.ahead)!==void 0?{ahead:d.jobs_ahead??d.ahead}:{},started:this.jobs.find(f=>f.kind===e&&f.id===s.id&&f.host===a)?.started??Date.now()});let c=l(s);this.recordJob(c),this.refreshInfo(t),this.following.add(r);let u=!1;try{for(;!Ee(c.status)&&!this.disposed;){o?.cancelled&&!u&&(u=!0,await this.cancelJob(t,c)),o?.progress(c.progress,tt(c)),await Us(e==="splat"?2e3:e==="movie"?1e3:500);try{const d=c.status;c=l(e==="still"?await t.stillInfo(s.id):e==="movie"?await t.movieInfo(s.id):await t.splatInfo(s.id)),c.status!==d&&this.refreshInfo(t)}catch(d){if(!(d instanceof Z&&d.status===404))throw d;c={...c,status:"gone"}}this.recordJob(c)}}finally{this.following.delete(r)}return c}cancelJob(e,t){return(t.kind==="still"?e.cancelStill(t.id):t.kind==="movie"?e.cancelMovie(t.id):e.cancelSplat(t.id)).catch(()=>{})}resumeJobs(e){const t=e.link.label??"";for(const s of this.jobs){if(Ee(s.status)||s.host!==t||this.following.has(`${s.kind}:${t}:${s.id}`))continue;const i=`${s.kind==="still"?"Still":s.kind==="movie"?"Movie":"Splat"}: ${s.name}`;this.ctx.jobs.run(i,o=>this.follow(s.kind,e,{...s,error:s.error??null},s.name,o)).catch(o=>this.ctx.log.error(`${i}: ${o.message}`))}}serviceFor(e){return this.service!==void 0&&this.serviceInfo!==void 0&&(this.service.link.label??"")===e.host?this.service:void 0}async download(e){const t=this.serviceFor(e);if(t===void 0)return this.ctx.ui.toast(`Connect to ${e.host} first.`,"error");try{e.kind==="still"?ce(await t.stillFile(e.id),"anatomical-rendering.png"):e.kind==="movie"?ce(await t.movieFile(e.id),`${e.name}.mp4`):ce(new Blob([await t.splatFile(e.id,"scene.splat")]),"anatomical-rendering.splat")}catch(s){s instanceof Z&&s.status===404&&this.recordJob({...e,status:"gone"}),this.ctx.ui.toast(`${e.name}: ${s.message}`,"error")}}async renderRotation(){const e=this.currentSpec();if(e===void 0)return;const t=this.saved.rotation;this.renderMovie({keyframes:[{time:0,view:{...e,scale:1}}],rotation:t,name:`rotation-${t.axis}-${t.degrees}`})}loadPresetFile(){const e=x("input",{type:"file",accept:".json,application/json"});e.onchange=async()=>{const t=e.files?.[0];if(t)try{const s=JSON.parse(await t.text()),i=(Array.isArray(s)?s:[s]).filter(o=>o&&typeof o.name=="string"&&Array.isArray(o.stops));if(i.length===0)throw new Error("no preset in it (a preset has a name and stops)");this.save(o=>{const a=new Set(i.map(r=>r.name));o.customPresets=[...o.customPresets.filter(r=>!a.has(r.name)),...i],o.preset=i[0].name}),this.panelUpdate?.()}catch(s){this.ctx.ui.toast(`Preset file: ${s.message}`,"error")}},e.click()}movieSpec(e,t){const s=Ke(this.saved.movie),i={keyframes:this.saved.keyframes,fps:s.fps,width:s.width,height:s.height,samples:s.samples,easing:s.easing,name:"anatomical-rendering",...e??{}};if(!t)return i;const o=384/Math.max(s.width,s.height,1),a=l=>Math.max(16,2*Math.round(l*Math.min(1,o)/2)),r=e?.rotation;return{...i,width:a(s.width),height:a(s.height),samples:Math.min(8,s.samples),fps:Math.min(12,s.fps),crf:30,name:"preview",...r?{rotation:{...r,step:Math.max(6,(r.step??2)*3)}}:{}}}renderMovie(e){const t=this.session?.id,s=this.service;if(t===void 0||s===void 0)return this.ctx.ui.toast("Connect to a computer and switch Render on first.","error");if(e===void 0&&this.saved.keyframes.length<2)return this.ctx.ui.toast("Add two keyframes or more first.","error");if(this.serviceInfo?.ffmpeg===!1)return this.ctx.ui.toast(zs,"error");const i=Ke(this.saved.movie);let o,a;this.ctx.ui.sheet("Movie preview",(r,l)=>{const c=x("progress",{max:"1",value:"0","aria-label":"Preview"}),u=x("span",{class:"muted"},"Rendering a preview…"),d=x("div",{class:"ar-preview"},c,u),f=C(`Render the movie (${i.width}×${i.height}, ${i.samples} samples)`,()=>{l(),this.movieJob(t,this.movieSpec(e,!1))},void 0,"btn primary");r.append(d,x("div",{class:"row"},f,fe("It renders in the background, its progress in the Movie card and in Activity; the view stays live.","About rendering the movie")));let m=!0;return(async()=>{try{for(o=await s.movie(t,this.movieSpec(e,!0));m&&(o.status==="queued"||o.status==="running");)c.value=o.progress,u.textContent=o.status==="queued"||/^waiting/i.test(o.message)?`Preview ${tt({status:o.status,progress:o.progress,message:o.message,ahead:o.jobs_ahead})}`:o.message||"Rendering a preview…",await new Promise(v=>setTimeout(v,400)),o=await s.movieInfo(o.id);if(!m)return;if(o.status!=="done")throw new Error(o.error??o.status);if(a=URL.createObjectURL(await s.movieFile(o.id)),!m)return;d.replaceChildren(x("video",{src:a,autoplay:!0,loop:!0,muted:!0,playsinline:!0,controls:!0,class:"ar-video"}))}catch(v){if(!m)return;const w=ze(v);d.replaceChildren(x("p",{class:"empty error"},w?w.text:`The preview failed: ${v.message}`)),w?.retry&&d.append(x("div",{class:"row"},C("Retry",()=>(l(),this.renderMovie(e)))))}})(),()=>{m=!1,o&&(o.status==="queued"||o.status==="running")&&s.cancelMovie(o.id).catch(()=>{}),a&&URL.revokeObjectURL(a)}},{wide:!0})}async movieJob(e,t){const s=this.service,i=String(t.name??"movie");try{await this.ctx.jobs.run(`Movie: ${i}`,async o=>{const a=await s.movie(e,t),r=await this.follow("movie",s,a,i,o);if(r.status!=="done")throw new Error(r.error??r.status);ce(await s.movieFile(a.id),`${i}.mp4`)})}catch(o){this.jobFailed("Movie",o,()=>void this.movieJob(this.session?.status==="ready"?this.session.id:e,t))}}async makeSplat(){const e=this.session?.id,t=this.currentSpec();if(e===void 0||t===void 0||this.service===void 0){this.ctx.ui.toast("Render a view on a computer first: the splat is made from it.","error");return}const s=this.saved.splat,i=this.serviceInfo?.splats;if(s.steps>0&&i&&!i.ready&&!await this.ctx.ui.confirm(`This computer cannot fit splats (${i.error??"no splat Python"}). Render the ${s.views} views only? They can be fitted later on a computer that can.`))return;const o=this.service,a=`Splat of ${this.saved.layer??"the view"}`;try{const r=await this.ctx.jobs.run(a,async l=>{const c=await o.splat(e,{view:{...t,scale:1},views:s.views,size:s.size,samples:s.samples,cover:s.cover,steps:s.steps,name:this.saved.layer??"view"}),u=await this.follow("splat",o,c,a,l);if(u.status!=="done")throw new Error(u.error??u.status);return u});r.files?.includes("scene.splat")&&this.ctx.ui.toast(`Splat made: ${r.message}`)}catch(r){this.jobFailed("Splat",r,()=>void this.makeSplat())}}async viewSplat(e){const t=this.serviceFor(e);if(t===void 0)return this.ctx.ui.toast(`Connect to ${e.host} first.`,"error");try{const[s,i]=await Promise.all([t.splatFile(e.id,"scene.splat"),t.splatFile(e.id,"cameras.json")]),o=JSON.parse(new TextDecoder().decode(i)),a=o.frames[0]?{c2w:o.frames[0].c2w,fovy:o.frames[0].fovy,centre:o.centre}:void 0,r=(l,c)=>()=>void t.splatFile(e.id,l).then(u=>ce(new Blob([u]),c));Es(this.ctx.ui.sheet,e.name,Ts(s),a,[["Download .splat",r("scene.splat","anatomical-rendering.splat")],...e.files?.includes("splat.ply")?[["Download .ply",r("splat.ply","anatomical-rendering.ply")]]:[]])}catch(s){this.ctx.ui.toast(`Splat: ${s.message}`,"error")}}openSplatFile(){const e=x("input",{type:"file",accept:".splat,.ply"});e.onchange=async()=>{const t=e.files?.[0];if(t)try{const s=await t.arrayBuffer();Es(this.ctx.ui.sheet,t.name,t.name.toLowerCase().endsWith(".ply")?zi(s):Ts(s),void 0)}catch(s){this.ctx.ui.toast(`Splat file: ${s.message}`,"error")}},e.click()}status(){const e=this.saved.where==="host";if(e&&this.connectProblem&&this.connecting===void 0)return{error:this.connectProblem,action:this.service===void 0?"pair":"retry"};const t=e?this.session:void 0;return this.problem?{error:this.problem,action:"retry"}:t?.status==="failed"?{error:`Failed: ${t.error??"unknown error"}`,action:"retry"}:this.refused?{error:this.refused.text,action:"again"}:this.saved.on?e&&this.connecting!==void 0?{progress:`Connecting to ${this.link()?.label??"the render computer"}…`}:t?.status==="loading"?{progress:`Loading: ${t.message} (${Math.round(t.progress*100)}%)`}:!e&&this.local&&!this.local.ready&&this.localText?{progress:this.localText}:{}:{}}readout(){const e=[],t=this.session;if(this.saved.where==="host"&&t?.status==="ready"){const s=t.volume;e.push(`${t.message}${s.made?s.from_cache?" (made here, from the cache)":" (made here by downsampling)":""}`)}return this.saved.where==="browser"&&this.local?.ready&&e.push(this.localText),this.live.text&&e.push(this.live.text),this.frameText&&e.push(this.frameText),e.join(`
`)}panel(e){const t=this.ctx,s=()=>this.saved,i={label:"Open data…",run:()=>void t.commands.invoke("dataset.add")},o=[],a=h=>(o.push(h),h),r=We("Render",s().on,h=>this.setOn(h)),l=ii(),c=fs("No OME-Zarr or N5 image in this scene.",i),u=Q(h=>[C("Centre",()=>this.centreOnTissue()),...h.map(p=>x("button",{class:"btn outline small",type:"button",title:`Look from ${p.name}`,"aria-label":`Look from ${p.name}`,onclick:()=>this.lookFrom(p)},p.label)),fe(h[0]?.label.startsWith("+")?"Centre moves to the middle of the tissue and zooms to show all of it. The others look from each end of x, y and z: the image's metadata does not give its anatomical orientation (in RAS, +x is right, +y anterior and +z superior).":"Centre moves to the middle of the tissue and zooms to show all of it. The others look from each side of the image, as its metadata names them.","About the view buttons")],{class:"row"}),d=te([["host","A computer's GPU (CUDA)"],["browser","This browser (WebGPU)"]],s().where,h=>{this.save(p=>p.where=h),this.update()},"Where"),f=pe(h=>{this.host={name:h||void 0},t.settings.set(Is,this.host),this.connect()},"Computer"),m=a(x("p",{class:"readout"})),v=C("Reconnect",()=>void this.connect()),w=ee("anatomical.remote","Remote",{open:!0},M("Where",d),a(M("Computer",f)),m,a(x("div",{class:"row"},C("Pair a computer…",()=>void t.commands.invoke(Ce.command,Ce.args)),v))),_=pe(h=>this.save(p=>p.layer=h),"Image"),y=x("p",{class:"hint"});let P,T;const z=Q(h=>{if(P=T=void 0,h===void 0)return null;const p=()=>this.target(),g=p()?this.volumeAt(p()):{channel:0,time:0};return h.channels>1&&(P=te(Array.from({length:h.channels},(E,A)=>[String(A),String(A)]),String(g.channel),E=>{const A=p();A&&this.setVolumeAt(A,{channel:Number(E)})},"Channel")),h.times>1&&(T=O(g.time,{min:0,max:h.times-1,step:1,label:"Time point",onchange:E=>{const A=p();A&&this.setVolumeAt(A,{time:Math.round(E)})}})),[P&&M("Channel",P,{info:`This image has ${h.channels} channels, numbered from 0: one is rendered at a time.`}),T&&M("Time point",T,{info:`This image has ${h.times} time points, numbered from 0: one is rendered at a time.`})]},{class:"stack"}),S=pe(h=>this.save(p=>p.preset=h),"Preset"),L=Q(h=>h.length===0?null:x("p",{class:"hint"},"Colours from ",...h.flatMap((p,g)=>[g?", ":"",p.page?x("a",{href:p.page,target:"_blank",rel:"noopener"},`photo ${g+1}`):`photo ${g+1}`])," ",fe(h.map(p=>`${p.title} (${p.author}${p.licence?`, ${p.licence}`:""})`).join("; "),"About the photographs")));let k;const W=Q(h=>{if(k=void 0,h===void 0)return null;const p=this.saved.windows[h.src]??h.guess,g=(E,A)=>O(p?p[E]:E,{min:h.lo,max:h.hi,step:h.step,label:A,onchange:R=>this.setWindow(h.src,E,R,h.guess)});return k=[g(0,"Window low"),g(1,"Window high")],M("Window",x("div",{class:"stack"},k[0],k[1],x("div",{class:"row"},C("Guess",()=>this.save(E=>delete E.windows[h.src])))),{info:"The image values the preset's colours are spread over, low and high. Guess goes back to the computer's guess: from just past the mounting medium, with the commonest tissue value at the middle."})}),Y=O(0,{min:-1,max:1,step:.01,label:"Shift",oninput:h=>this.tune(p=>p.shift=h*this.mapWidth(),!0),onchange:h=>this.tune(p=>p.shift=h*this.mapWidth())}),j=O(1,{min:.4,max:2.5,step:.01,label:"Compress",oninput:h=>this.tune(p=>p.scale=h,!0),onchange:h=>this.tune(p=>p.scale=h)}),I=Q(h=>h?[M("Colourmap",this.colourmapEditor().element,{info:"The image's histogram (grey) under the preset's colours and opacity. Drag a point: left and right moves it, up and down its opacity. Double-click to colour it, Ctrl-click to add one, right-click to remove one. The blue triangles under the histogram slide and warp it under the colours."}),M("Shift",Y,{info:"Moves the whole map along the values (a fraction of its width)."}),M("Compress",j,{info:"Narrows (below 1) or widens (above 1) the map about its middle."}),x("div",{class:"row"},C("Reset",()=>{const p=this.currentTuning();p&&this.save(g=>delete g.tunings[p.src]),this.editorUpdate?.()}),C("Save as a preset file",()=>{const p=this.tunedPreset()??this.resolved?.preset;if(!p)return;const g=`${String(p.name??"preset")} (tuned)`;ce(new Blob([JSON.stringify([{...p,name:g}],null,1)],{type:"application/json"}),"preset.json")}),fe("Reset goes back to the preset as it falls on this image. Save as a preset file writes the map as tuned, at this image's values, to load again with Load…","About the colourmap's buttons"))]:null,{class:"stack"}),X=O(40,{min:0,max:200,label:"Density",unit:"/mm",oninput:h=>this.preview(p=>p.density=h),onchange:h=>this.save(p=>p.density=h)}),ne=O(1,{min:0,max:5,step:.05,label:"Exposure",oninput:h=>this.preview(p=>p.exposure=h),onchange:h=>this.save(p=>p.exposure=h)}),re=a(ue("Hide the jar",!1,h=>{this.save(p=>p.jar=h),this.update()},{info:"Renders only a cylinder about the scan's axis, leaving out the jar's wall (HiP-CT organs in their jars)."})),lt=ee("anatomical.rendering","Rendering",{open:!0},M("Image",_),y,z,x("div",{class:"row"},M("Preset",S,{info:"A look per modality or organ. Load… reads a preset (or a list of them) from a JSON file: a name, a domain, stops of value, colour and opacity, and the material."}),C("Load…",()=>this.loadPresetFile())),L,W,I,M("Density",X,{info:"How opaque the tissue is: higher gives crisper surfaces, lower more translucent ones."}),M("Exposure",ne),re),ht=fs("No OME-Zarr segmentation in this scene.",i),dt=ue("Colour by region",!1,h=>this.save(p=>p.regions=h)),ut=pe(h=>this.save(p=>p.labels=h),"Segmentation"),pt=O(.85,{min:0,max:1,step:.05,label:"Region colour",oninput:h=>this.preview(p=>p.labelMix=h),onchange:h=>this.save(p=>p.labelMix=h)}),ft=Fs([],h=>this.save(p=>p.hidden=h),"Hidden regions"),mt=Fs([],h=>this.save(p=>p.keep=h),"Kept whole"),vt=x("div",{class:"stack"},M("Segmentation",ut),dt,M("Region colour",pt,{info:"0 keeps the preset's colours; 1 gives each region its own."}),M("Hidden regions",ft,{info:"Label ids left out, with spaces or commas between."}),M("Kept whole",mt,{info:"Label ids that stay whole where the crops cut (vessels through a cut brain)."})),gt=ee("anatomical.regions","Regions",{},ht,vt),wt=O(400,{min:10,max:2e3,step:10,unit:"M voxels",label:"Whole volume",onchange:h=>this.save(p=>p.budget=Math.max(1,h)*1e6)}),yt=a(ue("Finer detail",!0,h=>{this.save(p=>p.detail=h),this.update()},{info:"Where the view comes close, the region in view is read at a finer level; shadows and light from outside it stay at the whole volume's."})),bt=O(200,{min:10,max:2e3,step:10,unit:"M voxels",label:"Detail",onchange:h=>{this.save(p=>p.detailBudget=Math.max(1,h)*1e6),this.update()}}),xt=M("Detail",bt,{info:"The voxels the finer region may hold."}),Tt=ue("Denoise",!0,h=>this.save(p=>p.denoise=h),{info:"Smooths the first frames after the view changes (the computer's denoiser)."}),Et=O(64,{min:8,max:512,step:8,unit:"M voxels",label:"Object",onchange:h=>{this.save(p=>p.objectVoxels=Math.max(1,h)*1e6),this.update()}}),St=ue("Path-traced picture when still",!1,h=>{this.lastKey="",this.save(p=>p.restPicture=h)},{info:"Over the object, the path-traced picture of the view (at the image's full detail) once the camera rests. Off, the view shows the object alone, and the render computer renders only stills, movies and splats."}),_t=O(512,{min:16,max:4096,step:16,label:"Samples per pixel",onchange:h=>this.save(p=>p.maxSamples=Math.max(1,Math.round(h)))}),Ae=x("p",{class:"readout"}),Pt=ee("anatomical.quality","Quality",{},M("Whole volume",wt,{info:"One level of the whole image on the GPU: the finest stored level within this, or one made from a finer level."}),yt,xt,Tt,M("Object",Et,{info:"The voxels of the image this browser holds and draws as the object in the 3-D view: the finest level within this. More is sharper, and takes longer to read and more of this computer's GPU memory."}),St,M("Samples per pixel",_t,{info:"Where a still view stops refining."}),Ae),Ne=pe(h=>this.save(p=>{p.lightStyle=h;const g=bs[h];g&&([p.lightMap,p.envScale,p.lightKey]=[g.map,g.envScale,g.key])}),"Style");Ne.update([["","Custom"],...Object.entries(bs).map(([h,p])=>[h,p.name])],s().lightStyle);const Rt=O(30,{min:-180,max:180,step:5,unit:"°",label:"Around",oninput:h=>this.preview(p=>p.lightAzimuth=h),onchange:h=>this.save(p=>p.lightAzimuth=h)}),At=O(40,{min:-90,max:90,step:5,unit:"°",label:"Up",oninput:h=>this.preview(p=>p.lightElevation=h),onchange:h=>this.save(p=>p.lightElevation=h)}),Mt=O(1,{min:0,max:4,step:.05,label:"Key light",oninput:h=>this.preview(p=>p.lightKey=h),onchange:h=>this.save(p=>(p.lightKey=h,p.lightStyle=""))}),kt=O(1,{min:0,max:3,step:.05,label:"Surroundings",oninput:h=>this.preview(p=>p.envScale=h),onchange:h=>this.save(p=>(p.envScale=h,p.lightStyle=""))}),Lt=pe(h=>this.save(p=>p.lightMap=h),"Light map"),Ft=O(0,{min:-180,max:180,step:5,unit:"°",label:"Turn the light map",oninput:h=>this.preview(p=>p.lightMapRotation=h),onchange:h=>this.save(p=>p.lightMapRotation=h)}),Ut=x("div",{class:"stack"},M("Light map",Lt,{info:"HDR panoramas (CC0, Poly Haven), or the preset's sky colours."}),M("Turn",Ft)),Dt=ee("anatomical.lighting","Lighting",{},a(M("Style",Ne)),M("Around",Rt,{info:"The key light turns with the camera: 0 lights from the camera, 90 from the right, -90 from the left."}),M("Up",At,{info:"90 lights from above, -90 from below."}),a(M("Key light",Mt,{info:"The light that makes shadows."})),a(M("Surroundings",kt,{info:"Light from all round: the light map, or the sky colours."})),Ut),ei=C("Move to the cursor",()=>{const h=this.cursorOffsets();if(!h)return t.ui.toast("Point at the tissue in the 3-D view first.","error");this.save(p=>{const g=this.lastFrame.dimensions.names;for(const E of p.cuts){const A=g.indexOf(E.axis);E.on&&A>=0&&A<3&&(E.offset=h.axis[A])}for(const E of p.planes)!E.on||!this.lastCursor||(E.point=[this.lastCursor[0],this.lastCursor[1],this.lastCursor[2]],E.offset=0)})});let $e=[];const Ct=Q(h=>($e=[],Array.from({length:h},(p,g)=>{const E=this.saved.planes[g],A=We(`Plane ${g+1}`,E.on,D=>this.save(U=>U.planes[g].on=D),{hideLabel:!0}),R=x("input",{class:"text-input ar-grow",type:"text",value:E.name,"aria-label":`Name of plane ${g+1}`});R.onchange=()=>this.save(D=>D.planes[g].name=R.value),R.set=D=>{R.ownerDocument.activeElement!==R&&R.value!==D&&(R.value=D)};const F=O(E.offset,{min:-100,max:100,step:.5,unit:"mm",label:`Plane ${g+1} offset`,unbounded:!0,onchange:D=>this.save(U=>U.planes[g].offset=D)});return $e.push({on:A,name:R,offset:F}),x("div",{class:"ar-box"},x("div",{class:"row"},A,R,le("camera",`Set plane ${g+1} to the view now`,()=>this.setPlaneToView(g)),le("trash",`Remove plane ${g+1}`,()=>this.save(D=>D.planes.splice(g,1)))),M("Offset",F,{info:"Along the plane's own direction (away from the camera when it was set), from where it was set."}))})),{class:"stack"}),It=C("Add a camera plane",()=>this.addPlane()),zt=x("p",{class:"hint"},`At most ${N.maxClips} cuts apply at once (camera planes and axis planes that are on): the first ones.`),Ot=s().cuts.map((h,p)=>{const g=ue(`Across ${h.axis}`,h.on,R=>this.save(F=>{F.cuts[p].on=R;const D=R?this.cursorOffsets():void 0,U=this.lastFrame?.dimensions.names.indexOf(F.cuts[p].axis)??-1;D&&U>=0&&U<3&&(F.cuts[p].offset=D.axis[U])})),E=te([["-1","keep −"],["1","keep +"]],String(h.keep),R=>this.save(F=>F.cuts[p].keep=Number(R)),`Side kept across ${h.axis}`),A=O(h.offset,{min:-100,max:100,step:.5,unit:"mm",label:`Offset across ${h.axis}`,unbounded:!0,onchange:R=>this.save(F=>F.cuts[p].offset=R)});return{on:g,side:E,offset:A,row:x("div",{class:"ar-cut"},g,E,A)}});let Be=[];const Nt=Q(h=>(Be=[],Array.from({length:h},(p,g)=>{const E=this.saved.boxes[g],A=We(`Box ${g+1}`,E.on,U=>this.save(B=>B.boxes[g].on=U),{hideLabel:!0}),R=x("input",{class:"text-input ar-grow",type:"text",value:E.name,"aria-label":`Name of box ${g+1}`});R.onchange=()=>this.save(U=>U.boxes[g].name=R.value),R.set=U=>{R.ownerDocument.activeElement!==R&&R.value!==U&&(R.value=U)};const F=te([["keep","keep inside"],["cut","cut out"]],E.keep?"keep":"cut",U=>this.save(B=>B.boxes[g].keep=U==="keep"),`Box ${g+1} keeps`),D=["x","y","z"].map((U,B)=>[O(E.lo[B],{min:0,max:1,step:.005,label:`Box ${g+1} low ${U}`,onchange:de=>this.save(ie=>ie.boxes[g].lo[B]=Math.min(de,ie.boxes[g].hi[B]-.005))}),O(E.hi[B],{min:0,max:1,step:.005,label:`Box ${g+1} high ${U}`,onchange:de=>this.save(ie=>ie.boxes[g].hi[B]=Math.max(de,ie.boxes[g].lo[B]+.005))})]);return Be.push({on:A,name:R,keep:F,ends:D}),x("div",{class:"ar-box"},x("div",{class:"row"},A,R,F,le("trash",`Remove box ${g+1}`,()=>this.save(U=>U.boxes.splice(g,1)))),x("div",{class:"ar-box-axes"},...D.flatMap(([U,B],de)=>[x("span",{},"xyz"[de]),U,B])))})),{class:"stack"}),$t=C("Add a box",()=>{this.saved.boxes.length>=N.maxBoxes||this.save(h=>h.boxes.push({name:`Box ${h.boxes.length+1}`,on:!0,keep:!0,lo:[0,0,0],hi:[1,1,1]}))}),Bt=ee("anatomical.crops","Crops",{info:`Camera planes, axis planes and boxes. A camera plane is a cut across the view as it is when the plane is added, through the point the cursor was last over in the 3-D view, keeping what lies beyond; it stays fixed as the camera moves, and the camera button sets it again from the view then. An axis plane turned on starts through the point the cursor was last over; Move to the cursor moves the planes that are on there. Boxes (up to ${N.maxBoxes}) are fractions of the volume along x, y and z; what shows is inside any box that keeps and in none that cuts out.`},x("div",{class:"row"},ei),x("h4",{class:"section-title"},"Camera planes"),Ct,x("div",{class:"row"},It),zt,x("h4",{class:"section-title"},"Axis planes"),...Ot.map(h=>h.row),x("h4",{class:"section-title"},"Boxes"),Nt,x("div",{class:"row"},$t)),Ve=(h,p,g,E,A)=>{const R=Ie(p(s().movie),g,F=>this.save(D=>E(D.movie,F)),{"aria-label":h,...A});return{input:R,field:M(h,R)}},Vt=Ve("Width",h=>h.width,me,(h,p)=>h.width=p,{min:"8",max:"8192",step:"2"}),Gt=Ve("Height",h=>h.height,me,(h,p)=>h.height=p,{min:"8",max:"8192",step:"2"}),Xt=Ve("Samples",h=>h.samples,h=>ae(h,1,N.maxSamples),(h,p)=>h.samples=p,{min:"1",max:String(N.maxSamples)}),Ge=C("Save still (PNG)",()=>void this.saveStill()),Ht=x("p",{class:"hint"},zs),Xe=h=>Q(p=>p.map(g=>{const E=this.serviceFor(g),A=[];return!Ee(g.status)&&E&&A.push(C("Cancel",()=>void this.cancelJob(E,g))),g.status==="done"&&g.kind==="splat"&&g.files?.includes("scene.splat")&&A.push(C("View",()=>void this.viewSplat(g))),g.status==="done"&&(g.kind!=="splat"||g.files?.includes("scene.splat"))&&A.push(C("Download",()=>void this.download(g))),Ee(g.status)&&A.push(le("close",`Remove ${g.name} from the list`,()=>(this.jobs=Fi(this.jobs,g),t.settings.set(Qe,this.jobs),this.jobsUpdate?.()))),x("li",{class:"ar-job"},x("span",{class:"readout"},Ui(g)),...A)}),{class:"list"}),jt=Xe(),Wt=ee("anatomical.output","Output",{info:"The size and samples of stills and movies. A still is path-traced on the computer to twice the samples, as a job: its progress here and in Activity, and it downloads when done."},x("div",{class:"row"},Vt.field,Gt.field,Xt.field),x("div",{class:"row"},Ge),a(Ht),jt);let He=[];const Kt=Q(h=>(He=[],Array.from({length:h},(p,g)=>{const E=Ns(this.saved.keyframes[g].time,R=>this.save(F=>F.keyframes[g].time=R),{step:"0.5","aria-label":`Time of keyframe ${g+1}`});He.push(E);const A=R=>()=>this.save(F=>F.keyframes=To(F.keyframes,g,R));return x("li",{class:"row"},x("span",{class:"muted"},`#${g+1} at`),E,x("span",{class:"muted"},"s"),C("Go to",()=>this.goToKeyframe(g)),C("Replace",()=>this.addKeyframe(g)),le("arrow-up",`Move keyframe ${g+1} earlier`,A(-1),{disabled:g===0}),le("arrow-down",`Move keyframe ${g+1} later`,A(1),{disabled:g===h-1}),le("trash",`Remove keyframe ${g+1}`,()=>this.save(R=>R.keyframes.splice(g,1))))})),{class:"list"}),qt=Ie(s().movie.fps,h=>ae(h,1,N.maxFps),h=>this.save(p=>p.movie.fps=h),{min:"1",max:String(N.maxFps),"aria-label":"Frames a second"}),Jt=te([["smooth","slows at keyframes"],["linear","steady"]],s().movie.easing,h=>this.save(p=>p.movie.easing=h),"Camera"),Yt=te([["vertical","the vertical"],["horizontal","the horizontal"]],s().rotation.axis,h=>this.save(p=>p.rotation.axis=h),"About"),Zt=te([["360","full turn"],["180","half turn"]],String(s().rotation.degrees),h=>this.save(p=>p.rotation.degrees=Number(h)),"Turn"),Qt=Ie(s().rotation.step,h=>Math.min(90,Math.max(.25,h)),h=>this.save(p=>p.rotation.step=h),{step:"1",min:"0.25",max:"90","aria-label":"Step (degrees)"}),es=Xe(),ts=ee("anatomical.movie","Movie",{info:"Add keyframes as you move, set each one's time, then preview: a small, quick version plays in a window, and from there the movie renders in the background at the Output card's size and samples. Go to moves the view back to a keyframe; Replace puts the view now in its place."},Kt,x("div",{class:"row"},C("Add keyframe",()=>this.addKeyframe()),M("fps",qt),M("Camera",Jt)),x("div",{class:"row"},C("Preview movie…",()=>this.renderMovie())),x("h4",{class:"section-title"},"Rotation"),x("div",{class:"row"},M("About",Yt),M("Turn",Zt),M("Step °",Qt)),x("div",{class:"row"},C("Preview rotation…",()=>void this.renderRotation())),es),Me=a(x("p",{class:"hint"})),ke=(h,p,g,E,A,R)=>{const F=Ie(p(s().splat),D=>ae(D,g,E),D=>this.save(U=>A(U.splat,D)),{min:String(g),max:String(E),"aria-label":h});return{input:F,field:M(h,F,R?{info:R}:void 0)}},ss=ke("Views",h=>h.views,8,4096,(h,p)=>h.views=p),is=ke("Size",h=>h.size,64,4096,(h,p)=>h.size=p,"Pixels along the longer side of each view."),os=ke("Samples",h=>h.samples,1,8192,(h,p)=>h.samples=p),as=ke("Fit steps",h=>h.steps,0,2e5,(h,p)=>h.steps=p,"0 renders the views only."),ns=te([["180","every side"],["90","this half"],["50","near this side"]],String(s().splat.cover),h=>this.save(p=>p.splat.cover=Number(h)),"From"),rs=Xe(),cs=ee("anatomical.splat","Splat",{info:"The look now, path-traced from all round and fitted with 3-D Gaussians that any browser, phone or headset draws at full speed."},Me,x("div",{class:"row"},ss.field,is.field,os.field,M("From",ns),as.field),x("div",{class:"row"},C("Make splat",()=>void this.makeSplat()),C("Open file…",()=>this.openSplatFile()),fe("Make splat runs on the computer that renders. Open file… views a .splat or a 3-D Gaussian splatting .ply from this device.","About splats")),rs);e.append(x("div",{class:"row"},r),c,l,u,w,lt,gt,Pt,Dt,Bt,Wt,ts,cs);let ls="";this.statusUpdate=()=>{const h=this.status(),p=JSON.stringify(h);p!==ls&&(ls=p,h.error!==void 0?l.error(h.error,h.action==="pair"?{label:"Pair a computer…",run:()=>void t.commands.invoke(Ce.command,Ce.args)}:h.action==="again"?{label:"Retry",run:()=>this.retryJob()}:{label:"Retry",run:()=>this.retry()}):h.progress!==void 0?l.progress(h.progress):l.clear());const g=this.readout();Ae.textContent!==g&&(Ae.textContent=g),Ae.hidden=g===""},this.jobsUpdate=()=>{for(const[h,p]of[["still",jt],["movie",es],["splat",rs]])p.update(this.jobs.filter(g=>g.kind===h))},this.editorUpdate=()=>{const h=this.editedStops(),p=this.session?.volume?.histogram;h&&this.editor&&!this.editor.dragging&&this.editor.set(p,h.stops,h.warp)};let hs=!0;const je=()=>{const h=this.saved,p=this.images(),g=this.target(),E=h.where==="host",A=g?this.axesOf(g):{};for(const b of o)b.hidden=!E;r.set(h.on),r.input.disabled=p.length===0,c.hidden=p.length>0,u.update(p.length?this.viewButtons():[]),u.hidden=p.length===0;const R=!E||this.serviceInfo!==void 0;!R&&hs&&this.connecting===void 0&&(w.open=!0),hs=R||this.connecting!==void 0,d.set(h.where);const F=this.renderHosts(),D=this.link()?.label;f.update([["",`Automatic${!this.host.name&&D?`: ${D}`:""}`],...F.map(b=>[b.name,`${b.name}${b.info?.hostname&&b.info.hostname!==b.name?` (${b.info.hostname})`:""}${b.available?"":": not answering"}`])],F.some(b=>b.name===this.host.name)?this.host.name:"");const U=this.serviceInfo?.gpu;m.textContent=this.serviceInfo===void 0?"":wi(this.serviceInfo),m.hidden=!E||U===void 0,v.hidden=F.length===0,lt.hidden=p.length===0,_.update(p.map(b=>[b.name,b.name]),g?.name??""),y.textContent=A.problem??"";const B=g&&A.problem===void 0?this.volumeCounts(g):void 0;if(z.update(B),z.hidden=B===void 0,g&&B){const b=this.volumeAt(g);P?.set(String(b.channel)),T?.set(b.time)}y.hidden=y.textContent==="",y.className=A.problem!==void 0?"hint error":"hint";const ie=[...h.where==="browser"?ve.map(b=>({name:b.name,modality:b.modality??""})):this.presets,...h.customPresets.map(b=>({name:String(b.name),modality:"from a file"}))];S.update(ie.map(b=>[b.name,b.modality?`${b.name} (${b.modality})`:b.name]),h.preset),S.disabled=ie.length===0,L.update(this.references());const Le=this.windowRange();if(W.update(Le),Le&&k){const b=h.windows[Le.src]??Le.guess;b&&k.forEach((K,q)=>K.set(b[q]))}const Fe=E&&this.session?.status==="ready"?this.currentTuning():void 0;if(I.update(Fe!==void 0),Fe){const b=this.mapWidth();Y.set(b?Fe.tuning.shift/b:0),j.set(Fe.tuning.scale),this.editorUpdate?.(),this.resolvePreset()}X.set(h.density??Number(this.presets.find(b=>b.name===h.preset)?.density??40)),ne.set(h.exposure),re.set(h.jar);const ge=this.segmentations();gt.hidden=!E||p.length===0,ht.hidden=ge.length>0,vt.hidden=ge.length===0,ut.update(ge.map(b=>[b.name,b.name]),ge.find(b=>b.name===h.labels)?.name??ge[0]?.name??""),dt.set(h.regions),pt.set(h.labelMix),ft.set(h.hidden),mt.set(h.keep),Pt.hidden=p.length===0,wt.set(h.budget/1e6),yt.set(h.detail),xt.hidden=!E||!h.detail,bt.set(h.detailBudget/1e6),Tt.set(h.denoise),St.set(h.restPicture),Et.set(h.objectVoxels/1e6),_t.set(h.maxSamples),Dt.hidden=p.length===0,Ne.set(h.lightStyle),Rt.set(h.lightAzimuth),At.set(h.lightElevation),Mt.set(h.lightKey),kt.set(h.envScale);const us=this.serviceInfo?.lightmaps??[];Ut.hidden=!E||us.length===0,Lt.update([["","Sky colours"],...us.map(b=>[b,b])],h.lightMap),Ft.set(h.lightMapRotation),Bt.hidden=p.length===0,Ct.update(h.planes.length),$e.forEach((b,K)=>{const q=h.planes[K];b.on.set(q.on),b.name.set(q.name),b.offset.set(q.offset)}),It.disabled=h.planes.length>=N.maxClips,zt.hidden=h.planes.filter(b=>b.on).length+h.cuts.filter(b=>b.on).length<=N.maxClips,Ot.forEach((b,K)=>{b.on.set(h.cuts[K].on),b.side.set(String(h.cuts[K].keep)),b.offset.set(h.cuts[K].offset)}),Nt.update(h.boxes.length),Be.forEach((b,K)=>{const q=h.boxes[K];b.on.set(q.on),b.name.set(q.name),b.keep.set(q.keep?"keep":"cut"),b.ends.forEach(([ti,si],ps)=>(ti.set(q.lo[ps]),si.set(q.hi[ps])))}),$t.disabled=h.boxes.length>=N.maxBoxes,Wt.hidden=ts.hidden=cs.hidden=p.length===0,Vt.input.set(me(h.movie.width)),Gt.input.set(me(h.movie.height)),Xt.input.set(ae(h.movie.samples,1,N.maxSamples)),Ge.disabled=this.stillRunning,Ge.textContent=this.stillRunning?"Rendering still…":"Save still (PNG)",Ht.hidden=!E||this.serviceInfo?.ffmpeg!==!1,Kt.update(h.keyframes.length),He.forEach((b,K)=>b.set(h.keyframes[K].time)),qt.set(ae(h.movie.fps,1,N.maxFps)),Jt.set(h.movie.easing),Yt.set(h.rotation.axis),Zt.set(String(h.rotation.degrees)),Qt.set(h.rotation.step);const we=this.serviceInfo?.splats;Me.textContent=we&&!we.ready?`Views only: this computer cannot fit (${we.error??"no splat Python"}).`:we?.warning?`${we.warning}.`:"",Me.hidden=!E||Me.textContent==="",ss.input.set(h.splat.views),is.input.set(h.splat.size),os.input.set(h.splat.samples),as.input.set(h.splat.steps),ns.set(String(h.splat.cover)),this.jobsUpdate?.(),this.statusUpdate?.()};this.panelUpdate=je,je();const ds=setInterval(()=>{if(this.panelUpdate!==je)return clearInterval(ds);this.saved.where==="host"&&!document.hidden&&this.refreshInfo()},Ao);return()=>{clearInterval(ds),this.panelUpdate=void 0,this.statusUpdate=void 0,this.jobsUpdate=void 0,this.editorUpdate=void 0}}disposed=!1;dispose(){this.disposed=!0,this.panelUpdate=this.statusUpdate=this.jobsUpdate=this.editorUpdate=void 0,this.closeSession(),this.closeLocal(),clearTimeout(this.settle),this.handle?.dispose(),this.drawer.dispose(),this.toggle.dispose();for(const e of this.offs)e()}}const Co={activate(n){const e=document.createElement("style");e.textContent=_o,(document.head??document.body).append(e),n.subscriptions.push(()=>e.remove());const t=new Mo(n);n.subscriptions.push(()=>t.dispose())}};export{Ro as farFrom,To as moveKeyframe,Ls as parseIds,Co as plugin,ks as readSaved};
