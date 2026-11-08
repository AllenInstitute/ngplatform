import{e as f,b as L,f as _,n as z,d as K,s as I,c as ue}from"./dom-DGHT0epZ.js";import{V as pe}from"./volume_client-D4_Q21h6.js";import{R as me}from"./manifest-C3aSv9QB.js";import"./worker_rpc-BGQIcfWl.js";function fe(h,e,s){return{base:`${e.replace(/\/+$/,"")}/svc/render`,token:"",viaRunner:!0,hostFetch:s,label:h}}function $(h,e,s={},t=!1){if(h.hostFetch){const i=new Headers(s.headers);return t&&i.set("Content-Type","application/json"),h.hostFetch(`render${e}`,{...s,headers:i})}return fetch(`${h.base}${e}`,{...s,headers:{...ge(h,t),...s.headers}})}function ve(h,e,s){const t=h.trim().replace(/\/+$/,"");return{base:s?`${t}/svc/render`:t,token:e.trim(),viaRunner:s}}function ge(h,e){const s={};return h.token&&(h.viaRunner?s.Authorization=`Bearer ${h.token}`:s["X-NGP-Service-Token"]=h.token),e&&(s["Content-Type"]="application/json"),s}class G extends Error{}async function D(h,e,s,t,i){const n=await $(h,s,{method:e,body:t===void 0?void 0:JSON.stringify(t),signal:i},t!==void 0),o=await n.text();let a;try{a=o?JSON.parse(o):void 0}catch{a=o}if(!n.ok){const l=a?.error??`${n.status} ${n.statusText}`;throw new G(`${e} ${s}: ${l}`)}return a}class ye{constructor(e){this.link=e}info(e){return D(this.link,"GET","/info",void 0,e)}resolve(e,s,t={}){return D(this.link,"POST",`/sessions/${e}/resolve`,{preset:s,overrides:t})}presets(){return D(this.link,"GET","/presets")}open(e,s){return D(this.link,"POST","/sessions",{volume:e,labels:s})}session(e){return D(this.link,"GET",`/sessions/${e}`)}close(e){return D(this.link,"DELETE",`/sessions/${e}`)}setView(e,s){return D(this.link,"PUT",`/sessions/${e}/view`,s)}async still(e,s){const t=await $(this.link,`/sessions/${e}/still`,{method:"POST",body:JSON.stringify(s)},!0);if(!t.ok)throw new G(`still: ${(await t.json().catch(()=>({}))).error??t.status}`);return t.blob()}movie(e,s){return D(this.link,"POST",`/sessions/${e}/movies`,s)}movieInfo(e){return D(this.link,"GET",`/movies/${e}`)}cancelMovie(e){return D(this.link,"DELETE",`/movies/${e}`)}async movieFile(e){const s=await $(this.link,`/movies/${e}/file`);if(!s.ok)throw new G(`movie file: ${s.status}`);return s.blob()}async frame(e,s,t){const i=await $(this.link,`/sessions/${e}/frame?after=${s}&timeout=20`,{signal:t});if(i.status===204)return;if(!i.ok)throw new G(`frame: ${i.status}`);const n=await i.blob(),o=u=>Number(i.headers.get(u)??0),a=o("X-Alpha-Offset"),[l,c]=await Promise.all([createImageBitmap(a?n.slice(0,a,"image/jpeg"):n,{premultiplyAlpha:"none"}),a?new Response(n.slice(a).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer().then(u=>new Uint8Array(u)):void 0]);return{bitmap:l,alpha:c,detail:i.headers.get("X-Detail")??void 0,number:o("X-Frame"),samples:o("X-Samples"),version:o("X-Version"),width:o("X-Width"),height:o("X-Height"),msPerPass:o("X-Ms-Per-Pass")}}async depth(e){const s=await $(this.link,`/sessions/${e}/depth`);if(s.status===204||!s.ok)return;const t=Number(s.headers.get("X-Width")),i=Number(s.headers.get("X-Height")),n=Number(s.headers.get("X-Version")),o=s.body.pipeThrough(new DecompressionStream("deflate")),a=new Uint8Array(await new Response(o).arrayBuffer());return{version:n,width:t,height:i,data:we(new Uint16Array(a.buffer,a.byteOffset,a.byteLength>>1))}}}function we(h){const e=new Float32Array(h.length);for(let s=0;s<h.length;++s){const t=h[s],i=t&32768?-1:1,n=t>>10&31,o=t&1023;e[s]=n===0?i*o*2**-24:n===31?o?NaN:i*(1/0):i*(1+o/1024)*2**(n-15)}return e}const be=`#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`,xe=h=>`#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform highp sampler2D uDepth;
uniform sampler2D uAlpha;
uniform vec4 uViewport;
uniform float uHasDepth;
uniform float uHasAlpha;
layout(location = ${h.color}) out vec4 out_color;
layout(location = ${h.z}) out highp vec4 out_z;
layout(location = ${h.pick}) out highp vec4 out_pickId;
void main() {
  vec2 uv = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw;
  uv.y = 1.0 - uv.y;
  vec4 c = texture(uColor, uv);
  // A JPEG frame's alpha comes apart, and its colour is not premultiplied.
  if (uHasAlpha > 0.5) c = vec4(c.rgb * texture(uAlpha, uv).r, texture(uAlpha, uv).r);
  if (c.a < 0.5) discard;
  float d = uHasDepth > 0.5 ? texture(uDepth, uv).r : 0.5;
  d = clamp(d, 0.0, 0.99999);
  gl_FragDepth = d;
  out_color = vec4(c.rgb / max(c.a, 1e-3), 1.0);
  out_z = vec4(1.0 - d);
  out_pickId = vec4(0.0);
}`;class Pe{onFrame;picture;uploaded;uploadedDepth;uploadedAlpha;gl;program;programFor="";vao;color;depth;alpha;set(e){this.picture=e}isReady(){return this.picture!==void 0}draw(e){this.onFrame?.(e);const s=this.picture;if(s===void 0)return;const t=e.gl;this.gl!==t&&this.reset(t);const i=this.compile(t,e.outputs);if(i===void 0)return;this.uploaded!==s&&(t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,this.color),t.pixelStorei(t.UNPACK_FLIP_Y_WEBGL,!1),t.pixelStorei(t.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),t.texImage2D(t.TEXTURE_2D,0,t.RGBA8,t.RGBA,t.UNSIGNED_BYTE,s.bitmap),this.uploaded=s),s.depth!==void 0&&this.uploadedDepth!==s.depth&&(t.activeTexture(t.TEXTURE1),t.bindTexture(t.TEXTURE_2D,this.depth),t.pixelStorei(t.UNPACK_ALIGNMENT,4),t.texImage2D(t.TEXTURE_2D,0,t.R32F,s.depth.width,s.depth.height,0,t.RED,t.FLOAT,s.depth.data),this.uploadedDepth=s.depth),s.alpha!==void 0&&this.uploadedAlpha!==s.alpha&&(t.activeTexture(t.TEXTURE2),t.bindTexture(t.TEXTURE_2D,this.alpha),t.pixelStorei(t.UNPACK_ALIGNMENT,1),t.texImage2D(t.TEXTURE_2D,0,t.R8,s.alpha.width,s.alpha.height,0,t.RED,t.UNSIGNED_BYTE,s.alpha.data),t.pixelStorei(t.UNPACK_ALIGNMENT,4),this.uploadedAlpha=s.alpha),t.useProgram(i);const n=t.getParameter(t.VIEWPORT);t.uniform4f(t.getUniformLocation(i,"uViewport"),n[0],n[1],n[2],n[3]),t.uniform1f(t.getUniformLocation(i,"uHasDepth"),s.depth!==void 0?1:0),t.uniform1f(t.getUniformLocation(i,"uHasAlpha"),s.alpha!==void 0?1:0),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,this.color),t.uniform1i(t.getUniformLocation(i,"uColor"),0),t.activeTexture(t.TEXTURE1),t.bindTexture(t.TEXTURE_2D,this.depth),t.uniform1i(t.getUniformLocation(i,"uDepth"),1),t.activeTexture(t.TEXTURE2),t.bindTexture(t.TEXTURE_2D,this.alpha),t.uniform1i(t.getUniformLocation(i,"uAlpha"),2),t.bindVertexArray(this.vao),t.drawArrays(t.TRIANGLES,0,3),t.bindVertexArray(null),t.activeTexture(t.TEXTURE0)}reset(e){this.gl=e,this.program=void 0,this.programFor="",this.uploaded=void 0,this.uploadedDepth=void 0,this.uploadedAlpha=void 0,this.vao=e.createVertexArray();const s=t=>{const i=e.createTexture();return e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),i};this.color=s(e.LINEAR),this.depth=s(e.NEAREST),this.alpha=s(e.LINEAR)}compile(e,s){const t=JSON.stringify(s);if(this.program!==void 0&&this.programFor===t)return this.program;const i=(o,a)=>{const l=e.createShader(o);if(e.shaderSource(l,a),e.compileShader(l),!e.getShaderParameter(l,e.COMPILE_STATUS))throw new Error(e.getShaderInfoLog(l)??"shader");return l},n=e.createProgram();if(e.attachShader(n,i(e.VERTEX_SHADER,be)),e.attachShader(n,i(e.FRAGMENT_SHADER,xe(s))),e.linkProgram(n),!e.getProgramParameter(n,e.LINK_STATUS))throw new Error(e.getProgramInfoLog(n)??"link");return this.program=n,this.programFor=t,n}dispose(){const e=this.gl;e!==void 0&&(this.program&&e.deleteProgram(this.program),this.color&&e.deleteTexture(this.color),this.depth&&e.deleteTexture(this.depth),this.vao&&e.deleteVertexArray(this.vao),this.gl=void 0)}}function _e(h,e=14){if(h.length<=e)return h.map((i,n)=>n);const s=new Set([0,h.length-1]);for(let i=1;i<h.length;++i)if(h[i].tissue!==h[i-1].tissue&&(s.add(i-1),s.add(i)),i<h.length-1){const n=h[i].opacity-h[i-1].opacity,o=h[i+1].opacity-h[i].opacity;Math.abs(n-o)>.15&&s.add(i)}let t=[...s].sort((i,n)=>i-n);for(;t.length>e;){let i=1,n=1/0;for(let o=1;o<t.length-1;++o){const a=h[t[o+1]].value-h[t[o-1]].value;a<n&&([i,n]=[o,a])}t.splice(i,1)}if(t.length<Math.min(e,6)){const i=(h.length-1)/(Math.min(e,6)-1);t=[...new Set([...t,...Array.from({length:Math.min(e,6)},(n,o)=>Math.round(o*i))])].sort((n,o)=>n-o)}return t}function Te(h,e,s,t){const i=e.indexOf(s),n=i>0?h[e[i-1]].value:-1/0,o=i<e.length-1?h[e[i+1]].value:1/0,a=Math.min(Math.max(t,n+1e-6),o-1e-6),l=h[s].value;return h.map((c,u)=>u===s?{...c,value:a}:i>0&&u>e[i-1]&&u<s?{...c,value:n+(c.value-n)*(a-n)/(l-n||1)}:i<e.length-1&&u>s&&u<e[i+1]?{...c,value:o-(o-c.value)*(o-a)/(o-l||1)}:i===0&&u<s?{...c,value:c.value+(a-l)}:i===e.length-1&&u>s?{...c,value:c.value+(a-l)}:c)}function ee(h,e,s,t){const i=e.indexOf(s),n=i>0?e[i-1]:s,o=i<e.length-1?e[i+1]:s,a=h[s];return h.map((l,c)=>{if(c<n||c>o)return l;const u=c===s?1:c<s?(l.value-h[n].value)/(a.value-h[n].value||1):(h[o].value-l.value)/(h[o].value-a.value||1),p={...l};return t.opacity!==void 0&&(p.opacity=Math.min(1,Math.max(0,l.opacity+u*(t.opacity-a.opacity)))),t.color&&(p.color=l.color.map((m,g)=>Math.min(1,Math.max(0,m+u*(t.color[g]-a.color[g]))))),p})}function Ee(h,e,s,t){return e===0&&s===1?h:h.map(i=>({...i,value:t+(i.value-t)*s+e}))}const Y=h=>"#"+h.map(e=>Math.round(Math.min(1,Math.max(0,e))*255).toString(16).padStart(2,"0")).join(""),Se=h=>[1,3,5].map(e=>parseInt(h.slice(e,e+2),16)/255);class Re{constructor(e){this.onChange=e,this.canvas=f("canvas",{width:"420",height:"150",style:"width: 100%; cursor: crosshair; border: 1px solid #555; border-radius: 3px"}),this.element=f("div",{},this.canvas),this.canvas.addEventListener("pointerdown",s=>this.down(s)),this.canvas.addEventListener("pointermove",s=>this.move(s)),this.canvas.addEventListener("pointerup",()=>this.drag=void 0),this.canvas.addEventListener("dblclick",s=>this.recolour(s)),this.canvas.addEventListener("contextmenu",s=>this.remove(s))}element;canvas;stops=[];points=[];range=[0,1];counts=[];hlo=0;hhi=1;drag;get dragging(){return this.drag!==void 0}set(e,s){if(this.dragging)return;this.stops=s.map(a=>({...a})),this.points=_e(this.stops),e&&([this.counts,this.hlo,this.hhi]=[e.counts,e.lo,e.hi]);const i=(this.stops.filter(a=>a.opacity>.01)[0]??this.stops[0])?.value??this.hlo,n=this.stops[this.stops.length-1]?.value??this.hhi,o=(n-i)*.12||1;this.range=[i-o,n+o],this.draw()}x(e){return(e-this.range[0])/(this.range[1]-this.range[0])*this.canvas.width}v(e){return this.range[0]+e/this.canvas.width*(this.range[1]-this.range[0])}y(e){return 10+(1-e)*(this.canvas.height-40)}draw(){const e=this.canvas.getContext("2d"),s=this.canvas.width,t=this.canvas.height;if(e.fillStyle="#1e1e1e",e.fillRect(0,0,s,t),this.counts.length){const i=this.counts.length,n=Math.log1p(Math.max(...this.counts));e.fillStyle="#5a5a5a";for(let o=0;o<i;++o){const a=this.hlo+(this.hhi-this.hlo)*o/i,l=this.hlo+(this.hhi-this.hlo)*(o+1)/i,c=this.x(a),u=this.x(l);if(u<0||c>s)continue;const p=Math.log1p(this.counts[o])/n*(t-40);e.fillRect(c,t-30-p,Math.max(1,u-c),p)}}for(let i=0;i<s;++i){const n=this.at(this.v(i));e.fillStyle=Y(n.color.map(o=>Math.min(1,o*1.6))),e.fillRect(i,t-24,1,18)}e.strokeStyle="#e8e8e8",e.lineWidth=1.5,e.beginPath(),this.stops.forEach((i,n)=>n?e.lineTo(this.x(i.value),this.y(i.opacity)):e.moveTo(this.x(i.value),this.y(i.opacity))),e.stroke();for(const i of this.points){const n=this.stops[i];e.fillStyle=Y(n.color.map(o=>Math.min(1,o*1.6))),e.strokeStyle="#fff",e.beginPath(),e.arc(this.x(n.value),this.y(n.opacity),5,0,Math.PI*2),e.fill(),e.stroke()}}at(e){const s=this.stops;if(!s.length)return{color:[0,0,0],opacity:0};if(e<=s[0].value)return{color:s[0].color,opacity:s[0].opacity};for(let i=1;i<s.length;++i)if(e<=s[i].value){const n=(e-s[i-1].value)/(s[i].value-s[i-1].value||1);return{color:s[i].color.map((o,a)=>s[i-1].color[a]+n*(o-s[i-1].color[a])),opacity:s[i-1].opacity+n*(s[i].opacity-s[i-1].opacity)}}const t=s[s.length-1];return{color:t.color,opacity:t.opacity}}pos(e){const s=this.canvas.getBoundingClientRect();return[(e.clientX-s.left)/s.width*this.canvas.width,(e.clientY-s.top)/s.height*this.canvas.height]}near(e){const[s,t]=this.pos(e);let i,n=9;for(const o of this.points){const a=Math.hypot(this.x(this.stops[o].value)-s,this.y(this.stops[o].opacity)-t);a<n&&([i,n]=[o,a])}return i}down(e){if(e.button!==0)return;const s=this.near(e);if(s!==void 0){this.drag=s,this.canvas.setPointerCapture(e.pointerId);return}if(e.ctrlKey||e.metaKey){const[t]=this.pos(e),i=this.v(t),n=this.at(i),o=this.stops.findIndex(c=>c.value>i),a=o<0?this.stops.length:o,l=this.stops[Math.min(a,this.stops.length-1)];this.stops.splice(a,0,{...l,value:i,color:n.color,opacity:n.opacity}),this.points=[...new Set([...this.points.map(c=>c>=a?c+1:c),a])].sort((c,u)=>c-u),this.changed()}}move(e){if(this.drag===void 0)return;const[s,t]=this.pos(e),i=this.drag;this.stops=Te(this.stops,this.points,i,this.v(s));const n=Math.min(1,Math.max(0,1-(t-10)/(this.canvas.height-40)));this.stops=ee(this.stops,this.points,i,{opacity:n}),this.changed()}recolour(e){const s=this.near(e);if(s===void 0)return;const t=f("input",{type:"color",value:Y(this.stops[s].color)});t.oninput=()=>{this.stops=ee(this.stops,this.points,s,{color:Se(t.value)}),this.changed()},t.click()}remove(e){const s=this.near(e);s!==void 0&&(e.preventDefault(),!(this.stops.length<=2)&&(this.stops.splice(s,1),this.points=this.points.filter(t=>t!==s).map(t=>t>s?t-1:t),this.changed()))}changed(){this.draw(),this.onChange(this.stops.map(e=>({...e})))}}const ke=[{name:"MR T1 brain",modality:"MR",description:"A T1-weighted brain: the cortex's surface in warm grey, white matter paler beneath it.",domain:"percentile",stops:[{value:0,color:[.55,.42,.38],opacity:0},{value:20,color:[.62,.45,.4],opacity:0},{value:40,color:[.8,.62,.55],opacity:.35},{value:70,color:[.9,.78,.7],opacity:.8},{value:99.5,color:[.98,.95,.9],opacity:1}],density:40,shade_mix:.85,gradient_scale:30,roughness:.5,specular:.12,albedo:.95},{name:"HiP-CT brain",modality:"HiP-CT",description:"A HiP-CT brain in fixative: tissue in ivory, vessels and dense structure brighter.",domain:"percentile",stops:[{value:0,color:[.75,.7,.62],opacity:0},{value:10,color:[.8,.74,.66],opacity:0},{value:30,color:[.88,.8,.7],opacity:.4},{value:70,color:[.95,.88,.78],opacity:.8},{value:99.9,color:[1,.97,.92],opacity:1}],density:40,shade_mix:.85,gradient_scale:30,roughness:.45,specular:.15,albedo:.95},{name:"Histology (BigBrain)",modality:"histology",description:"Merker-stained sections: tissue in stain blue-grey, darker where cells are dense.",domain:"percentile",stops:[{value:0,color:[.55,.58,.72],opacity:0},{value:10,color:[.55,.58,.72],opacity:0},{value:35,color:[.62,.64,.78],opacity:.5},{value:80,color:[.8,.8,.88],opacity:.85},{value:99.9,color:[.95,.95,.98],opacity:1}],density:40,shade_mix:.85,gradient_scale:30,roughness:.5,specular:.1,albedo:.95},{name:"Translucent tissue",modality:"",description:"Any volume as a translucent, scattering solid: deep structure shows through the surface.",domain:"percentile",stops:[{value:0,color:[.9,.75,.65],opacity:0},{value:15,color:[.9,.75,.65],opacity:0},{value:50,color:[.95,.8,.7],opacity:.05},{value:95,color:[1,.92,.85],opacity:.4},{value:99.9,color:[1,1,1],opacity:.8}],density:12,shade_mix:.3,gradient_scale:30,roughness:.6,specular:.05,phase_g:.3,albedo:.98},{name:"Regions (labels)",modality:"labels",description:"Each region of a co-registered segmentation in its own colour, on the image's tissue.",domain:"percentile",stops:[{value:0,color:[1,1,1],opacity:0},{value:15,color:[1,1,1],opacity:0},{value:40,color:[1,1,1],opacity:.6},{value:99.9,color:[1,1,1],opacity:1}],density:40,shade_mix:.85,gradient_scale:30,roughness:.5,specular:.1,albedo:.95}],Me=[{name:"INVVP",size:16,about:"clip -> display (world) coordinates, column-major"},{name:"VP",size:16,about:"world -> clip, column-major"},{name:"VOX_FROM_WORLD",size:12,about:"3x4 row-major: voxel index coordinates (x fastest) from world"},{name:"WORLD_NORMAL",size:9,about:"3x3 row-major: the transpose of VOX_FROM_WORLD's linear part"},{name:"DIMS",size:3,about:"volume size in voxels, x, y, z"},{name:"BRICK",size:1,about:"majorant brick size in voxels"},{name:"MGRID",size:3,about:"majorant grid size, x, y, z"},{name:"DENSITY",size:1,about:"extinction per display unit at opacity 1"},{name:"SHADE_MIX",size:1,about:"0: volume scattering only .. 1: surfaces where gradients are strong"},{name:"GRAD_SCALE",size:1,about:"how quickly the gradient's magnitude makes a surface (per texture unit per voxel)"},{name:"ROUGHNESS",size:1,about:""},{name:"SPECULAR",size:1,about:""},{name:"PHASE_G",size:1,about:""},{name:"ALBEDO",size:1,about:"scales the transfer function's colour"},{name:"LIGHT_DIR",size:3,about:"direction towards the key light, world, unit"},{name:"LIGHT_RGB",size:3,about:"key light radiance (irradiance at normal incidence)"},{name:"ENV_TOP",size:3,about:'environment: colour above (world "up")'},{name:"ENV_HORIZON",size:3,about:""},{name:"ENV_BOTTOM",size:3,about:""},{name:"ENV_UP",size:3,about:"world up for the environment, unit"},{name:"ENV_SCALE",size:1,about:""},{name:"BG",size:4,about:"background shown where primary rays leave (alpha 0: transparent)"},{name:"EXPOSURE",size:1,about:""},{name:"MAX_BOUNCES",size:1,about:""},{name:"NCLIP",size:1,about:""},{name:"CLIPS",size:24,about:"up to 6 planes, (nx, ny, nz, d) in world: kept where n.x + d >= 0"},{name:"CROP_LO",size:3,about:"crop box in voxel coordinates (inclusive), x, y, z"},{name:"CROP_HI",size:3,about:""},{name:"HAS_LABELS",size:1,about:""},{name:"LABEL_FROM_WORLD",size:12,about:"3x4 row-major: label voxel coordinates from world"},{name:"LDIMS",size:3,about:""},{name:"NLUT",size:1,about:""},{name:"LABEL_MIX",size:1,about:"0: the transfer function's colour .. 1: the label's colour"},{name:"STEP",size:1,about:"depth pass: step in voxels"},{name:"FRAME",size:1,about:"pass number, for the random sequence"},{name:"APERTURE",size:1,about:"thin lens: aperture radius in display units (0: pinhole)"},{name:"FOCUS",size:1,about:"thin lens: focal distance in display units"},{name:"OPAQUE_LIMIT",size:1,about:"depth pass: accumulated opacity where the surface is"},{name:"ENVMAP",size:1,about:"1: the environment is a light map (a texture), 0: the three colours"},{name:"ENV_RIGHT",size:3,about:"light map frame: right (world, unit)"},{name:"ENV_BACK",size:3,about:"light map frame: back (world, unit); up is ENV_UP"},{name:"ENV_ROT",size:1,about:"light map turned about up, radians"},{name:"INSET",size:1,about:"voxels along the gradient at which a collision takes its colour, on the more opaque side (0: where it is), so a surface shows the tissue beneath it, not the values between it and the medium"},{name:"FAST",size:1,about:"1: frames while the camera moves; through dense bricks the tracking steps a voxel at a time, summing optical depth (approximate, its cost bounded by the voxels crossed, not the density), 0: exact delta and ratio tracking"},{name:"DETAIL",size:1,about:"1 when a finer level's region (the detail) is held beside the coarse level"},{name:"DETAIL_FROM_WORLD",size:12,about:"3x4 row-major: the detail's voxel index coordinates from world"},{name:"DETAIL_NORMAL",size:9,about:"3x3 row-major: the transpose of DETAIL_FROM_WORLD's linear part"},{name:"DETAIL_DIMS",size:3,about:"the detail's size in voxels, x, y, z"},{name:"DETAIL_MGRID",size:3,about:"the detail's majorant grid size, x, y, z"},{name:"DETAIL_GSCALE",size:1,about:"coarse voxel size over detail voxel size: gradients per detail voxel to per coarse voxel"}],Ae={fields:Me},ze=`// The path tracer in WGSL, for WebGPU in the page: the same method and parameter block as the
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
`,V=globalThis,A=new Proxy({},{get:(h,e)=>V.GPUBufferUsage[e]}),te=new Proxy({},{get:(h,e)=>V.GPUTextureUsage[e]}),Oe=new Proxy({},{get:(h,e)=>V.GPUShaderStage[e]}),se=new Proxy({},{get:(h,e)=>V.GPUMapMode[e]}),B=1024,N=4,Q={},ie=(()=>{let h=0;for(const e of Ae.fields)Q[e.name]=h,h+=e.size;return h})(),j=ke,Ue={top:[.85,.9,1],horizon:[.55,.55,.6],bottom:[.12,.11,.1],scale:.6};function Le(h){const e=new Float64Array(256);for(let p=0;p<h.length;++p)e[h[p]]++;let s=0;for(let p=1;p<25;++p)e[p]>e[s]&&(s=p);let t=s;for(;t+1<256&&e[t+1]<=e[t];)t++;const i=Float64Array.from(e);for(let p=0;p<=t;++p)i[p]=0;let n=i.reduce((p,m)=>p+m,0);const o=n>0?i:e;n===0&&(n=e.reduce((p,m)=>p+m,0));const a=new Map,l=[.5,1,2,5,10,20,30,40,50,60,70,80,90,95,98,99,99.5,99.9];let c=0,u=0;for(let p=0;p<256&&u<l.length;++p)for(c+=o[p];u<l.length&&c/n>=l[u]/100;)a.set(l[u++],p);for(;u<l.length;)a.set(l[u++],255);return a.set(0,t+1),a}function Ie(h,e,s,t){if(Math.min(e,s,t)<8)return;const i=new Float64Array(256),n=new Float64Array(256);for(let y=0;y<s;y+=2)for(let w=0;w<e;w+=2){const b=Math.hypot((y-(s-1)/2)/(s/2),(w-(e-1)/2)/(e/2));if(b>=.9)continue;const x=b>.75;for(let U=0;U<t;U+=2){const T=h[(U*s+y)*e+w];n[T]++,x&&i[T]++}}i[0]=0,n[0]=0;const o=i.map((y,w)=>{let b=0;for(let x=w-2;x<=w+2;++x)x>=0&&x<256&&(b+=i[x]);return b/5});let a=0;for(let y=1;y<256;++y)o[y]>o[a]&&(a=y);if(o[a]===0)return;let l=a;for(;l>0&&o[l]>.2*o[a];)l--;let c=a;for(;c<255&&o[c]>.2*o[a];)c++;const u=Math.max(a-l,c-a,1);let p=0,m=0;for(let y=a+u;y<256;++y)p+=n[y];for(let y=0;y<a-u;++y)m+=n[y];const g=y=>{let w=-1;for(let v=0;v<y.length;++v)y[v]>0&&(w=v);if(w<0)return 1;const b=Math.max(5,Math.floor((w+1)/40))|1,x=new Float64Array(y.length);for(let v=0;v<y.length;++v){let k=0;for(let P=v-(b>>1);P<=v+(b>>1);++P)P>=0&&P<y.length&&(k+=y[P]);x[v]=k/b}const U=Math.max(...x);let T=-1,S=1/0;for(let v=0;v<b-(b>>1)-1;++v)S=Math.min(S,x[v]);for(let v=b;v<x.length-1;++v)S=Math.min(S,x[v-(b>>1)-1]),x[v]>=x[v-1]&&x[v]>x[v+1]&&x[v]>1.3*S&&x[v]>.05*U&&(T<0||x[v]>x[T])&&(T=v);if(T<0){const v=y.reduce((P,O)=>P+O,0);let k=0;T=y.length-1;for(let P=0;P<y.length;++P)if((k+=y[P])/v>=.99){T=P;break}T=Math.floor(T/2)}return Math.max(T,1)};if(p>=m&&p>0)return[a+u,a+u+2*g(n.slice(a+u))];if(m>0){const y=Math.max(0,a-u);return[y-2*g(n.slice(0,y).reverse()),y]}}function J(h,e,s){if(h<=e[0])return s[0];for(let t=1;t<e.length;++t)if(h<=e[t])return s[t-1]+(s[t]-s[t-1])*(h-e[t-1])/(e[t]-e[t-1]||1);return s[s.length-1]}function De(h,e,s){const t=[...e.keys()].sort((c,u)=>c-u),i=s??[0,255],n=c=>(h.domain==="percentile"?J(c,t,t.map(u=>e.get(u))):h.domain==="window"?i[0]+c*(i[1]-i[0]):c)/255,o=h.stops.map(c=>({x:n(c.value),c:c.color,a:c.opacity})).sort((c,u)=>c.x-u.x),a=o.map(c=>c.x),l=new Float32Array(B*4);for(let c=0;c<B;++c){const u=c/(B-1);for(let p=0;p<3;++p)l[4*c+p]=J(u,a,o.map(m=>m.c[p]));l[4*c+3]=J(u,a,o.map(p=>p.a))}return l}const Ne=(h,e)=>{const s=new Array(16).fill(0);for(let t=0;t<4;++t)for(let i=0;i<4;++i)for(let n=0;n<4;++n)s[4*t+i]+=h[4*t+n]*e[4*n+i];return s};function ne(h){const e=h.slice(),s=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];for(let t=0;t<4;++t){let i=t;for(let o=t+1;o<4;++o)Math.abs(e[4*o+t])>Math.abs(e[4*i+t])&&(i=o);for(let o=0;o<4;++o)[e[4*t+o],e[4*i+o]]=[e[4*i+o],e[4*t+o]],[s[4*t+o],s[4*i+o]]=[s[4*i+o],s[4*t+o]];const n=e[4*t+t];for(let o=0;o<4;++o)e[4*t+o]/=n,s[4*t+o]/=n;for(let o=0;o<4;++o){if(o===t)continue;const a=e[4*o+t];for(let l=0;l<4;++l)e[4*o+l]-=a*e[4*t+l],s[4*o+l]-=a*s[4*t+l]}}return s}const oe=h=>{const e=new Array(16);for(let s=0;s<4;++s)for(let t=0;t<4;++t)e[4*s+t]=h[4*t+s];return e};function Ce(h){const e=(c,u,p)=>{const m=[0,1,2,3].map(g=>h[4*g]*c+h[4*g+1]*u+h[4*g+2]*p+h[4*g+3]);return[m[0]/m[3],m[1]/m[3],m[2]/m[3]]},s=(c,u)=>c.map((p,m)=>p-u[m]),t=c=>{const u=Math.hypot(...c);return c.map(p=>p/u)},i=(c,u)=>c[0]*u[0]+c[1]*u[1]+c[2]*u[2],n=e(0,0,-1),o=t(s(e(0,0,1),n));let a=s(e(1,0,-1),n);a=t(a.map((c,u)=>c-o[u]*i(a,o)));const l=[a[1]*o[2]-a[2]*o[1],a[2]*o[0]-a[0]*o[2],a[0]*o[1]-a[1]*o[0]];return[a,l,o.map(c=>-c)]}async function $e(){const h=navigator.gpu;if(h!==void 0)return await h.requestAdapter({powerPreference:"high-performance"})??void 0}class Be{onFrame;status="";device;pipelines={};layout;tex;sampler;bounds;maj;nbricks=0;grid=[1,1,1];size=[1,1,1];voxelToRas=[];pct=new Map;window;params;tf;accum;out;depth;uni;W=0;H=0;bind;view;version=0;applied=-1;samples=0;frameNo=0;maxSamples=256;running=!1;disposed=!1;client;adapterName="";async load(e,s,t){const i=await $e();if(i===void 0)throw new Error("This browser has no WebGPU adapter.");const n=i.info;this.adapterName=[n?.vendor,n?.architecture,n?.description].filter(Boolean).join(" ")||"WebGPU";const o=i.limits,a=await i.requestDevice({requiredLimits:{maxStorageBufferBindingSize:Math.min(o.maxStorageBufferBindingSize,1<<30),maxBufferSize:Math.min(o.maxBufferSize,1<<30)}});this.device=a,this.client?.dispose(),this.client=new pe;const{levels:l}=await this.client.open([e.endsWith("/")?e:`${e}/`],void 0),c=a.limits.maxTextureDimension3D,u=l.filter(v=>v.size[0]*v.size[1]*v.size[2]<=s&&Math.max(...v.size)<=c),p=u.length?l.indexOf(u[0]):l.length-1,m=l[p];t?.(`reading level ${m.path} (${m.size.join(" × ")})`);const{data:g,size:y}=await this.client.volume(p,(v,k)=>t?.(`reading level ${m.path}: ${v}/${k} chunks`));this.size=y,this.voxelToRas=Array.from(m.voxelToRas),this.pct=Le(g),this.window=Ie(g,y[0],y[1],y[2]);const[w,b,x]=y;this.tex=a.createTexture({size:[w,b,x],dimension:"3d",format:"r8unorm",usage:te.TEXTURE_BINDING|te.COPY_DST});const U=Math.ceil(w/256)*256;if(U===w)a.queue.writeTexture({texture:this.tex},g,{bytesPerRow:w,rowsPerImage:b},[w,b,x]);else{const v=new Uint8Array(U*b*x);for(let k=0;k<x;++k)for(let P=0;P<b;++P)v.set(g.subarray((k*b+P)*w,(k*b+P+1)*w),(k*b+P)*U);a.queue.writeTexture({texture:this.tex},v,{bytesPerRow:U,rowsPerImage:b},[w,b,x])}this.sampler=a.createSampler({magFilter:"linear",minFilter:"linear",addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge",addressModeW:"clamp-to-edge"});const T=[Math.ceil(w/N),Math.ceil(b/N),Math.ceil(x/N)];this.grid=T,this.nbricks=T[0]*T[1]*T[2];const S=new Float32Array(this.nbricks*2);for(let v=0;v<this.nbricks;++v)S[2*v]=1,S[2*v+1]=0;for(let v=0;v<x;++v){const k=Math.floor(Math.max(0,v-1)/N),P=Math.floor(Math.min(x-1,v+1)/N);for(let O=0;O<b;++O){const r=Math.floor(Math.max(0,O-1)/N),d=Math.floor(Math.min(b-1,O+1)/N),R=(v*b+O)*w;for(let E=0;E<w;++E){const M=g[R+E]/255,X=Math.floor(Math.max(0,E-1)/N),de=Math.floor(Math.min(w-1,E+1)/N);for(let H=k;H<=P;++H)for(let W=r;W<=d;++W)for(let q=X;q<=de;++q){const F=(H*T[1]+W)*T[0]+q;M<S[2*F]&&(S[2*F]=M),M>S[2*F+1]&&(S[2*F+1]=M)}}}}return this.bounds=a.createBuffer({size:S.byteLength,usage:A.STORAGE|A.COPY_DST}),a.queue.writeBuffer(this.bounds,0,S),this.maj=a.createBuffer({size:this.nbricks*4,usage:A.STORAGE}),this.params=a.createBuffer({size:ie*4,usage:A.STORAGE|A.COPY_DST}),this.tf=a.createBuffer({size:B*16,usage:A.STORAGE|A.COPY_DST}),this.uni=a.createBuffer({size:16,usage:A.UNIFORM|A.COPY_DST}),this.compile(a),this.applied=-1,`level ${m.path} (${y.join(" × ")}) on ${this.adapterName}`}compile(e){const s=`const TF_SIZE: u32 = ${B}u;
`+Object.entries(Q).map(([o,a])=>`const P_${o}: u32 = ${a}u;`).join(`
`)+`
`,t=e.createShaderModule({code:s+ze}),i=Oe.COMPUTE;this.layout=e.createBindGroupLayout({entries:[{binding:0,visibility:i,buffer:{type:"read-only-storage"}},{binding:1,visibility:i,texture:{sampleType:"float",viewDimension:"3d"}},{binding:2,visibility:i,sampler:{type:"filtering"}},{binding:3,visibility:i,buffer:{type:"read-only-storage"}},{binding:4,visibility:i,buffer:{type:"storage"}},{binding:5,visibility:i,buffer:{type:"storage"}},{binding:6,visibility:i,buffer:{type:"storage"}},{binding:7,visibility:i,buffer:{type:"storage"}},{binding:8,visibility:i,buffer:{type:"read-only-storage"}},{binding:9,visibility:i,buffer:{type:"uniform"}}]});const n=e.createPipelineLayout({bindGroupLayouts:[this.layout]});for(const o of["trace","firsthit","majorant","tonemap"])this.pipelines[o]=e.createComputePipeline({layout:n,compute:{module:t,entryPoint:o}})}resize(e,s){const t=this.device;e===this.W&&s===this.H&&this.accum||(this.accum?.destroy(),this.out?.destroy(),this.depth?.destroy(),this.W=e,this.H=s,this.accum=t.createBuffer({size:e*s*16,usage:A.STORAGE|A.COPY_DST}),this.out=t.createBuffer({size:e*s*4,usage:A.STORAGE|A.COPY_SRC}),this.depth=t.createBuffer({size:e*s*4,usage:A.STORAGE|A.COPY_SRC}),this.bind=t.createBindGroup({layout:this.layout,entries:[{binding:0,resource:{buffer:this.params}},{binding:1,resource:this.tex.createView({dimension:"3d"})},{binding:2,resource:this.sampler},{binding:3,resource:{buffer:this.tf}},{binding:4,resource:{buffer:this.maj}},{binding:5,resource:{buffer:this.accum}},{binding:6,resource:{buffer:this.out}},{binding:7,resource:{buffer:this.depth}},{binding:8,resource:{buffer:this.bounds}},{binding:9,resource:{buffer:this.uni}}]}))}setView(e){this.view=e,this.version++,this.maxSamples=e.max_samples??256,this.running||this.loop()}pack(e,s,t){const i=Q,n=new Float32Array(ie),o=oe(e.inv_view_projection),a=ne(o),l=(d,R)=>n.set(Array.from(R),i[d]),c=d=>{const R=new Array(16);for(let E=0;E<4;++E)for(let M=0;M<4;++M)R[4*M+E]=d[4*E+M];return R};l("INVVP",c(o)),l("VP",c(a));const u=e.world_from_physical?oe(e.world_from_physical):[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],p=Ne(u,this.voxelToRas),m=ne(p);l("VOX_FROM_WORLD",m.slice(0,12)),l("WORLD_NORMAL",[m[0],m[4],m[8],m[1],m[5],m[9],m[2],m[6],m[10]]),l("DIMS",this.size),n[i.BRICK]=N,l("MGRID",this.grid);const g=typeof e.preset=="string"?e.preset:String(e.preset.name??""),w={...(typeof e.preset=="object"?e.preset:j.find(d=>d.name===g))??j[0],...e.overrides??{}};n[i.DENSITY]=w.density*(e.unit_mm??1),n[i.SHADE_MIX]=w.shade_mix??.8,n[i.GRAD_SCALE]=w.gradient_scale??40,n[i.ROUGHNESS]=w.roughness??.45,n[i.SPECULAR]=w.specular??.15,n[i.PHASE_G]=w.phase_g??0,n[i.ALBEDO]=w.albedo??.9,n[i.INSET]=w.surface_inset??0;const[b,x,U]=Ce(o),T=e.light?.direction??[.4,.7,.6];let S=e.light?.camera_space===!1?T:[0,1,2].map(d=>T[0]*b[d]+T[1]*x[d]+T[2]*U[d]);const v=Math.hypot(...S);S=S.map(d=>d/v),l("LIGHT_DIR",S);const k=w.light_scale??1;l("LIGHT_RGB",(e.light?.rgb??[3.2,3,2.8]).map(d=>d*k));const P={...Ue,...w.environment??{}};l("ENV_TOP",P.top),l("ENV_HORIZON",P.horizon),l("ENV_BOTTOM",P.bottom),l("ENV_UP",x),n[i.ENV_SCALE]=P.scale??1,l("BG",e.background??[0,0,0,0]),n[i.EXPOSURE]=w.exposure??1,n[i.MAX_BOUNCES]=e.max_bounces??4;const O=(e.clips??[]).slice(0,6);n[i.NCLIP]=O.length,O.forEach((d,R)=>n.set(d,i.CLIPS+4*R));const r=e.crop_fraction;return l("CROP_LO",r?r[0].map((d,R)=>d*this.size[R]-.5):[-1e9,-1e9,-1e9]),l("CROP_HI",r?r[1].map((d,R)=>d*this.size[R]-.5):[1e9,1e9,1e9]),n[i.STEP]=.5,n[i.APERTURE]=e.aperture??0,n[i.FOCUS]=e.focus??0,n[i.OPAQUE_LIMIT]=.5,{P:n,preset:w}}async loop(){this.running=!0;const e=this.device;let s=0,t;try{for(;!this.disposed;){const i=this.view;if(i===void 0||this.applied===this.version&&this.samples>=this.maxSamples)break;const n=Math.max(8,Math.round(i.width*(i.scale??1))),o=Math.max(8,Math.round(i.height*(i.scale??1)));if(this.applied!==this.version){const p=this.version;this.resize(n,o);const{P:m,preset:g}=this.pack(i,n,o);e.queue.writeBuffer(this.params,0,m),e.queue.writeBuffer(this.tf,0,De(g,this.pct,this.window)),e.queue.writeBuffer(this.uni,0,new Uint32Array([n,o,0,0]));const y=e.createCommandEncoder();y.clearBuffer(this.accum);let w=y.beginComputePass();w.setBindGroup(0,this.bind),w.setPipeline(this.pipelines.majorant),w.dispatchWorkgroups(Math.ceil(this.nbricks/64)),w.setPipeline(this.pipelines.firsthit),w.dispatchWorkgroups(Math.ceil(n/8),Math.ceil(o/8)),w.end();const b=e.createBuffer({size:n*o*4,usage:A.COPY_DST|A.MAP_READ});y.copyBufferToBuffer(this.depth,0,b,0,n*o*4),e.queue.submit([y.finish()]),await b.mapAsync(se.READ),t={width:n,height:o,data:new Float32Array(b.getMappedRange().slice(0)),version:p},b.unmap(),b.destroy(),this.applied=p,this.samples=0,s=0}const a=performance.now(),l=1;for(let p=0;p<l;++p){this.frameNo++,this.samples++,e.queue.writeBuffer(this.uni,0,new Uint32Array([n,o,this.frameNo,this.samples]));const m=e.createCommandEncoder(),g=m.beginComputePass();g.setBindGroup(0,this.bind),g.setPipeline(this.pipelines.trace),g.dispatchWorkgroups(Math.ceil(n/8),Math.ceil(o/8)),g.end(),e.queue.submit([m.finish()])}await e.queue.onSubmittedWorkDone();const c=(performance.now()-a)/l,u=this.samples;((u&u-1)===0||performance.now()-s>250||u>=this.maxSamples)&&(await this.publish(n,o,c,t),s=performance.now())}}catch(i){this.status=`WebGPU: ${i.message}`}finally{this.running=!1}}async publish(e,s,t,i){const n=this.device,o=n.createCommandEncoder(),a=o.beginComputePass();a.setBindGroup(0,this.bind),a.setPipeline(this.pipelines.tonemap),a.dispatchWorkgroups(Math.ceil(e/8),Math.ceil(s/8)),a.end();const l=n.createBuffer({size:e*s*4,usage:A.COPY_DST|A.MAP_READ});o.copyBufferToBuffer(this.out,0,l,0,e*s*4),n.queue.submit([o.finish()]),await l.mapAsync(se.READ);const c=new Uint8ClampedArray(l.getMappedRange().slice(0));l.unmap(),l.destroy();const u=await createImageBitmap(new ImageData(c,e,s),{premultiplyAlpha:"none"});this.onFrame?.({bitmap:u,depth:i,samples:this.samples,width:e,height:s,msPerPass:t,version:this.applied})}dispose(){this.disposed=!0,this.client?.dispose(),this.tex?.destroy(),this.device?.destroy()}}function he(h){return h==="m"?1:.001}function ae(h){const e=new Array(16).fill(0);e[15]=1;for(let s=0;s<3;++s){const t=["x","y","z"].indexOf(h.names[s]);if(t===-1)return;e[4*s+t]=.001/(h.scales[s]*he(h.units[s]))}return Fe(e)}function ce(h){return h.scales[0]*he(h.units[0])*1e3}function Fe(h){const e=new Array(16);for(let s=0;s<4;++s)for(let t=0;t<4;++t)e[4*t+s]=h[4*s+t];return e}function Ge(h,e,s){const t=[];for(const i of h){if(!i.on)continue;const n=s.names.indexOf(i.axis);if(n===-1||n>2)continue;const o=[0,0,0];o[n]=i.keep;const a=e[n]+i.offset/ce(s);t.push([o[0],o[1],o[2],-i.keep*a])}return t}function je(h,e){const s=h*Math.PI/180,t=e*Math.PI/180;return[Math.sin(s)*Math.cos(t),Math.sin(t),Math.cos(s)*Math.cos(t)]}function C(h){if(h===void 0)return;let e=h.trim();const s=/^n5:\/\/(.*?)(\|n5:?)?\/?$/i.exec(e);if(s)return/^(https?|gs|s3):\/\//.test(s[1])||s[1].startsWith("/")?`n5://${s[1].replace(/\/+$/,"")}`:void 0;const t=/^(zarr2?|zarr3):\/\//i.exec(e),i=/\|zarr[23]?(:[^|]*)?$/i.exec(e);if(!(t===null&&i===null&&!/\.ome\.zarr\/?$/i.test(e))&&(t&&(e=e.slice(t[0].length)),i&&(e=e.slice(0,i.index)),!(!/^(https?|gs|s3):\/\//.test(e)&&!e.startsWith("/"))))return e.replace(/\/+$/,"")}function Ve(h,e){const s=g=>{const y=Math.hypot(...g);return g.map(w=>w/y)},t=s(h),i=s(e),n=s([t[1]*i[2]-t[2]*i[1],t[2]*i[0]-t[0]*i[2],t[0]*i[1]-t[1]*i[0]]),o=[t[1]*n[2]-t[2]*n[1],t[2]*n[0]-t[0]*n[2],t[0]*n[1]-t[1]*n[0]],a=[[n[0],o[0],t[0]],[n[1],o[1],t[1]],[n[2],o[2],t[2]]],l=a[0][0]+a[1][1]+a[2][2];let c,u,p,m;if(l>0){const g=Math.sqrt(l+1)*2;m=g/4,c=(a[2][1]-a[1][2])/g,u=(a[0][2]-a[2][0])/g,p=(a[1][0]-a[0][1])/g}else if(a[0][0]>a[1][1]&&a[0][0]>a[2][2]){const g=Math.sqrt(1+a[0][0]-a[1][1]-a[2][2])*2;m=(a[2][1]-a[1][2])/g,c=g/4,u=(a[0][1]+a[1][0])/g,p=(a[0][2]+a[2][0])/g}else if(a[1][1]>a[2][2]){const g=Math.sqrt(1+a[1][1]-a[0][0]-a[2][2])*2;m=(a[0][2]-a[2][0])/g,c=(a[0][1]+a[1][0])/g,u=g/4,p=(a[1][2]+a[2][1])/g}else{const g=Math.sqrt(1+a[2][2]-a[0][0]-a[1][1])*2;m=(a[1][0]-a[0][1])/g,c=(a[0][2]+a[2][0])/g,u=(a[1][2]+a[2][1])/g,p=g/4}return[c,u,p,m]}const Xe=[{name:"Left",forward:[1,0,0],up:[0,0,1]},{name:"Right",forward:[-1,0,0],up:[0,0,1]},{name:"Anterior",forward:[0,-1,0],up:[0,0,1]},{name:"Posterior",forward:[0,1,0],up:[0,0,1]},{name:"Superior",forward:[0,0,-1],up:[0,1,0]},{name:"Inferior",forward:[0,0,1],up:[0,1,0]}];function He(h,e,s){let t=`${e}x${s}`;for(let i=0;i<16;++i)t+=`,${Number(h[i]).toPrecision(6)}`;return t}const We=.9,re=[{axis:"x",keep:-1,offset:0,on:!1},{axis:"y",keep:-1,offset:0,on:!1},{axis:"z",keep:-1,offset:0,on:!1}];function le(h){const e=h??{},s=(i,n)=>typeof i=="number"&&Number.isFinite(i)?i:n,t=Array.isArray(e.cuts)&&e.cuts.length===3?e.cuts.map((i,n)=>({...re[n],...i})):re.map(i=>({...i}));return{on:e.on===!0,where:e.where==="browser"?"browser":"host",layer:typeof e.layer=="string"?e.layer:void 0,labels:typeof e.labels=="string"?e.labels:void 0,preset:typeof e.preset=="string"?e.preset:"",density:typeof e.density=="number"?e.density:void 0,exposure:s(e.exposure,1),windows:Object.fromEntries(Object.entries(e.windows&&typeof e.windows=="object"?e.windows:{}).filter(i=>Array.isArray(i[1])&&i[1].length===2&&i[1].every(n=>typeof n=="number"&&Number.isFinite(n))&&i[1][1]>i[1][0])),tunings:Object.fromEntries(Object.entries(e.tunings&&typeof e.tunings=="object"?e.tunings:{}).filter(i=>!!i[1]&&typeof i[1]=="object").map(([i,n])=>[i,{shift:s(n.shift,0),scale:s(n.scale,1),stops:Array.isArray(n.stops)?n.stops.filter(o=>o&&typeof o.value=="number"):void 0}])),lightAzimuth:s(e.lightAzimuth,30),lightElevation:s(e.lightElevation,40),lightMap:typeof e.lightMap=="string"?e.lightMap:"",lightMapRotation:s(e.lightMapRotation,0),cuts:t,regions:e.regions===!0,labelMix:s(e.labelMix,.85),keep:Array.isArray(e.keep)?e.keep.filter(i=>typeof i=="number"):[],hidden:Array.isArray(e.hidden)?e.hidden.filter(i=>typeof i=="number"):[],budget:s(e.budget,4e8),detail:e.detail!==!1,detailBudget:s(e.detailBudget,2e8),jar:e.jar===!0,maxSamples:s(e.maxSamples,512),denoise:e.denoise!==!1,keyframes:Array.isArray(e.keyframes)?e.keyframes:[],box:{on:e.box?.on===!0,lo:e.box?.lo??[0,0,0],hi:e.box?.hi??[1,1,1]},customPresets:Array.isArray(e.customPresets)?e.customPresets.filter(i=>i&&typeof i.name=="string"):[],rotation:{axis:"vertical",degrees:360,step:2,...e.rotation??{}},movie:{fps:25,width:1280,height:720,samples:128,easing:"smooth",...e.movie??{}}}}const Z="host";function qe(h){const e=h.trim(),s=e.includes("#")?e.slice(e.indexOf("#")+1):"";if(s.includes("runner=")){const t=new URLSearchParams(s);return{address:t.get("runner")??"",token:t.get("token")??"",viaRunner:!0}}return{address:e}}class Ke{constructor(e){this.ctx=e,this.saved=le(e.state.get()),this.host={address:"http://127.0.0.1:8765",token:"",viaRunner:!0,...e.settings.get(Z)??{}},this.drawer.onFrame=s=>this.onFrame(s),this.toggle=e.ui.viewToggle({label:"Render",title:"Path-traced rendering (Anatomical rendering)",value:this.saved.on,onChange:s=>this.setOn(s)}),this.offs.push(e.viewer.onLayersChanged(()=>this.update()),e.state.onChanged(()=>{this.saved=le(e.state.get()),this.update()}),e.commands.register("anatomicalRendering.toggle",()=>this.setOn(!this.saved.on)),e.ui.panel(me,s=>this.panel(s)),e.hosts.onChanged(()=>{this.link().label!==void 0&&this.serviceInfo===void 0&&!this.connecting&&this.connect(),this.panelUpdate?.()})),this.connect()}saved;host;drawer=new Pe;handle;handleLayer;service;serviceInfo;presets=[];session;sessionKey="";abort;lastKey="";lastScale=1;lastFrame;lastSpec;sending=!1;queued;settle;depth;frameText="";problem="";movie;local;localKey="";localText="";toggle;panelUpdate;statusUpdate;offs=[];save(e){e(this.saved),this.ctx.state.set({...this.saved}),this.handle?.redraw()}setOn(e){this.save(s=>s.on=e),this.toggle.set(e),e&&this.ensure3d(),this.update()}ensure3d(){const e=JSON.stringify(this.ctx.viewer.getState().layout??"");/3d|4panel/.test(e)||this.ctx.viewer.patchState(s=>void(s.layout="xy-3d"))}images(){return this.ctx.viewer.layers().filter(e=>e.type==="image"&&C(e.sources[0])!==void 0)}segmentations(){return this.ctx.viewer.layers().filter(e=>e.type==="segmentation"&&C(e.sources[0])!==void 0)}target(){const e=this.images();return e.find(s=>s.name===this.saved.layer)??e[0]}renderHosts(){return this.ctx.hosts.list().filter(e=>e.info?.services?.render!==void 0)}link(){const e=this.host.name??this.ctx.hosts.pick({service:"render"})?.name,s=e?this.ctx.hosts.get(e):void 0;return s!==void 0?fe(s.name,s.address,(t,i)=>s.fetch(t,i)):ve(this.host.address,this.host.token,this.host.viaRunner)}connecting=!1;async connect(){this.connecting=!0,this.service=new ye(this.link()),this.serviceInfo=void 0,this.problem="";try{this.serviceInfo=await this.service.info(AbortSignal.timeout(8e3)),this.presets=await this.service.presets(),!this.saved.preset&&this.presets.length>0&&(this.saved.preset=this.presets[0].name)}catch(e){const s=this.link();this.problem=`No render service ${s.label?`on ${s.label}`:`at ${s.base}`}: ${e.message}`}this.connecting=!1,this.sessionKey="",this.update(),this.panelUpdate?.()}update(){const e=this.target(),s=this.saved.where==="browser";if(!this.saved.on||e===void 0||!s&&this.serviceInfo===void 0){this.handle?.dispose(),this.handle=void 0,this.handleLayer=void 0,this.drawer.set(void 0),this.saved.on||(this.closeSession(),this.closeLocal()),this.panelUpdate?.();return}this.handleLayer!==e.name&&(this.handle?.dispose(),this.handleLayer=e.name,this.handle=this.ctx.viewer.draw3d(e.name,{draw:t=>this.drawer.draw(t),isReady:()=>this.drawer.isReady(),dispose:()=>{}})),s?(this.closeSession(),this.ensureLocal(e)):(this.closeLocal(),this.ensureSession(e)),this.handle?.redraw(),this.panelUpdate?.()}presetDomain(){const e=this.saved,t=e.customPresets.find(i=>i.name===e.preset)?.domain??(e.where==="browser"?j.find(i=>i.name===e.preset)?.domain:this.presets.find(i=>i.name===e.preset)?.domain);return typeof t=="string"?t:void 0}referenceNote(){const e=this.presets.find(t=>t.name===this.saved.preset),s=Array.isArray(e?.reference)?e.reference:[];return this.saved.where==="browser"||s.length===0?"":f("p",{class:"muted",style:"font-size: 11px; margin: 2px 0 6px"},"Colours measured on: ",...s.flatMap((t,i)=>[i?"; ":"",f("a",{href:t.page??"#",target:"_blank",rel:"noopener"},(t.title??"a photograph").replace(/^File:/,"")),` (${t.author??"unknown"}, ${t.licence??""})`]))}resolved;editor;presetRequest(){const e=this.saved,s=this.target()?C(this.target().sources[0]):void 0;if(this.session?.status!=="ready"||s===void 0)return;const t=e.customPresets.find(n=>n.name===e.preset)??(e.preset||"HiP-CT brain"),i=e.windows[s]&&this.presetDomain()==="window"?{window:e.windows[s]}:{};return{key:JSON.stringify([this.session.id,t,i]),preset:t,overrides:i}}async resolvePreset(){const e=this.presetRequest();if(!(e===void 0||this.resolved?.key===e.key||!this.service))try{const s=await this.service.resolve(this.session.id,e.preset,e.overrides);this.resolved={key:e.key,preset:s},this.editorUpdate?.(),this.lastKey="",this.handle?.redraw()}catch{}}currentTuning(){const e=this.target()?C(this.target().sources[0]):void 0;if(e!==void 0)return{src:e,tuning:this.saved.tunings[e]??{shift:0,scale:1}}}editedStops(){const e=this.presetRequest();if(!this.resolved||e===void 0||this.resolved.key!==e.key)return;const s=this.resolved.preset.stops??[],t=this.currentTuning()?.tuning,i=t?.stops??s,n=s.filter(a=>a.opacity>.01),o=n.length?(n[0].value+n[n.length-1].value)/2:0;return{stops:Ee(i,t?.shift??0,t?.scale??1,o),base:i,centre:o}}tunedPreset(){const e=this.currentTuning()?.tuning;if(!e||!e.stops&&e.shift===0&&e.scale===1)return;const s=this.editedStops();if(!s||!this.resolved)return;const{reference:t,measured:i,histogram:n,design_scan:o,...a}=this.resolved.preset;return{...a,stops:s.stops,domain:"data",window:null,histogram:null}}editorUpdate;editorField(){if(this.saved.where!=="host")return"";const e=this.currentTuning();if(!e)return"";this.editor||(this.editor=new Re(a=>{const l=this.currentTuning();if(!l)return;const c=this.editedStops(),u=l.tuning.scale||1,p=a.map(m=>({...m,value:(c?c.centre:0)+(m.value-l.tuning.shift-(c?c.centre:0))/u}));this.save(m=>m.tunings[l.src]={...l.tuning,stops:p})}));const s=this.session?.volume?.histogram;this.editorUpdate=()=>{const a=this.editedStops();a&&!this.editor.dragging&&this.editor.set(s,a.stops)},this.editorUpdate(),this.resolvePreset();const t=e.tuning,i=(()=>{const l=this.editedStops()?.base.filter(c=>c.opacity>.01)??[];return l.length?l[l.length-1].value-l[0].value:1})(),n=a=>{this.save(l=>{const c={...l.tunings[e.src]??{shift:0,scale:1}};a(c),l.tunings[e.src]=c}),this.editorUpdate?.()},o=(a,l,c,u,p,m)=>{const g=f("input",{type:"range",min:String(l),max:String(c),step:String(u),value:String(a),style:"width: 130px",title:m});return g.oninput=()=>p(Number(g.value)),g};return f("div",{style:"margin: 6px 0"},f("div",{class:"muted",style:"font-size: 11px; margin-bottom: 3px"},"Colourmap for this image, over its histogram: drag a point (left-right moves it, up-down its opacity), double-click to colour it, Ctrl-click to add one, right-click to remove one"),this.editor.element,f("div",{style:"display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 4px"},f("label",{},"Shift ",o(i?t.shift/i:0,-1,1,.01,a=>n(l=>l.shift=a*i),"Move the whole map along the values (a fraction of its width)")),f("label",{},"Compress ",o(t.scale,.4,2.5,.01,a=>n(l=>l.scale=a),"Narrow (below 1) or widen (above 1) the map about its middle")),L("Reset",()=>{this.save(a=>delete a.tunings[e.src]),this.editorUpdate?.()},"Back to the preset as it falls on this image"),L("Save as a preset file",()=>{const a=this.tunedPreset()??this.resolved?.preset;if(!a)return;const l=`${String(a.name??"preset")} (tuned)`;K(new Blob([JSON.stringify([{...a,name:l}],null,1)],{type:"application/json"}),"preset.json")},"The map as tuned, at this image's values (load it with Load a preset file…)")))}windowField(){if(this.presetDomain()!=="window")return"";if(this.saved.where==="browser")return _("Window",f("span",{class:"muted"},"Guessed in this browser (from just past the mounting medium; the commonest tissue value at its middle)"));const e=this.target(),s=e?C(e.sources[0]):void 0;if(s===void 0)return"";const t=this.session?.volume,i=t?.window??void 0,n=this.saved.windows[s]??i,o=(l,c)=>this.save(u=>{const p=u.windows[s]??i??[c,c+1],m=[p[0],p[1]];m[l]=c,m[1]>m[0]&&(u.windows[s]=m)}),a=t&&t.hi!==void 0&&t.lo!==void 0?String(Math.max(1,Math.round((t.hi-t.lo)/1e3))):"1";return _("Window (low, high)",f("div",{style:"display: flex; gap: 6px; align-items: center"},z(n?n[0]:0,l=>o(0,l),{step:a,style:"width: 80px"}),z(n?n[1]:1,l=>o(1,l),{step:a,style:"width: 80px"}),L("Guess",()=>this.save(l=>delete l.windows[s]),"Back to the host's guess: from just past the mounting medium, with the commonest tissue value at the middle")),this.saved.windows[s]?"The image's values the preset's colours are spread over":"The host's guess: from just past the mounting medium, the commonest tissue value at the middle; change it to fit")}labelsSource(){if(!this.saved.regions)return;const e=this.segmentations(),s=e.find(t=>t.name===this.saved.labels)??e[0];return s?C(s.sources[0]):void 0}async ensureSession(e){const s=this.service,t=C(e.sources[0]),i=this.labelsSource(),n=this.saved.detail?this.saved.detailBudget:0,o=JSON.stringify([s.link.base,t,i,this.saved.budget,this.saved.jar,n]);if(o===this.sessionKey)return;this.closeSession(),this.sessionKey=o;const a=new AbortController;this.abort=a;try{let l=await s.open({url:t,budget:this.saved.budget,detail_budget:n,...this.saved.jar?{cylinder:We}:{}},i?{url:i}:void 0);if(a.signal.aborted){s.close(l.id).catch(()=>{});return}for(this.session=l;l.status==="loading"&&!a.signal.aborted&&(this.statusUpdate?.(),await new Promise(c=>setTimeout(c,400)),l=await s.session(l.id),!a.signal.aborted);)this.session=l;if(this.statusUpdate?.(),l.status!=="ready"||a.signal.aborted)return;await this.resolvePreset(),this.lastKey="",this.handle?.redraw(),this.frameLoop(l.id,a.signal)}catch(l){this.problem=l.message,this.statusUpdate?.()}}async ensureLocal(e){const s=C(e.sources[0]),t=JSON.stringify([s,this.saved.budget]);if(t===this.localKey)return;this.closeLocal(),this.localKey=t;const i=new Be;this.local=i,i.onFrame=n=>{this.local===i&&(this.drawer.set({bitmap:n.bitmap,depth:n.depth}),this.frameText=`${n.samples} samples, ${n.width}×${n.height}, ${n.msPerPass.toFixed(0)} ms a pass (this browser)`,this.handle?.redraw(),this.statusUpdate?.())};try{this.localText="Loading in this browser…",this.statusUpdate?.(),this.localText=await i.load(s,Math.min(this.saved.budget,64e6),n=>{this.localText=n,this.statusUpdate?.()}),this.lastKey="",this.handle?.redraw()}catch(n){this.localText=`This browser cannot render it: ${n.message}`}this.statusUpdate?.()}closeLocal(){this.local?.dispose(),this.local=void 0,this.localKey="",this.localText=""}closeSession(){this.abort?.abort(),this.abort=void 0;const e=this.session;e&&this.service&&this.service.close(e.id).catch(()=>{}),this.session=void 0,this.sessionKey="",this.depth=void 0,this.drawer.set(void 0)}async frameLoop(e,s){const t=this.service;let i=0;for(;!s.aborted;)try{const n=await t.frame(e,i,s);if(n===void 0)continue;if(i=n.number,this.depth===void 0||this.depth.version!==n.version){const o=await t.depth(e);o!==void 0&&(this.depth=o)}this.drawer.set({bitmap:n.bitmap,alpha:n.alpha?{width:n.width,height:n.height,data:n.alpha}:void 0,depth:this.depth}),this.frameText=`${n.samples} samples, ${n.width}×${n.height}, ${n.msPerPass.toFixed(0)} ms a pass${n.detail?`
Detail: ${n.detail}`:""}`,this.handle?.redraw(),this.statusUpdate?.()}catch(n){if(s.aborted)return;this.problem=n.message,this.statusUpdate?.(),await new Promise(o=>setTimeout(o,1e3))}}viewSpec(e,s){const t=ae(e.dimensions);if(t===void 0){this.problem=`The 3-D view shows ${e.dimensions.names.join(", ")}; rendering needs x, y and z.`;return}const i=this.saved,n={exposure:i.exposure};i.density!==void 0&&(n.density=i.density);const o=this.target()?C(this.target().sources[0]):void 0;o!==void 0&&i.windows[o]&&this.presetDomain()==="window"&&(n.window=i.windows[o]);const a=this.tunedPreset();return{inv_view_projection:Array.from(e.invViewProjection),width:e.width,height:e.height,scale:s,world_from_physical:t,orbit_center:Array.from(e.position),unit_mm:ce(e.dimensions),preset:a??i.customPresets.find(l=>l.name===i.preset)??(i.preset||"HiP-CT brain"),overrides:a?{exposure:i.exposure,...i.density!==void 0?{density:i.density}:{}}:n,crop_fraction:i.box.on?[i.box.lo,i.box.hi]:void 0,light:{direction:je(i.lightAzimuth,i.lightElevation),camera_space:!0},environment:i.lightMap?{map:i.lightMap,rotation:i.lightMapRotation}:void 0,clips:Ge(i.cuts,e.position,e.dimensions),labels:i.regions?{show:!0,mix:i.labelMix,keep:i.keep,hidden:i.hidden}:{show:!1},background:[0,0,0,0],max_samples:i.maxSamples,denoise:i.denoise,frame_format:"jpeg"}}onFrame(e){this.lastFrame=e;const s=this.saved.where==="browser"?this.local:void 0,t=s?"local":this.session?.status==="ready"?this.session.id:void 0;if(t===void 0||s&&!this.localText.startsWith("level"))return;const i=JSON.stringify([this.saved.box,this.saved.customPresets.length,this.saved.preset,this.saved.density,this.saved.exposure,this.saved.windows,this.saved.tunings,this.resolved?.key,this.saved.lightAzimuth,this.saved.lightElevation,this.saved.lightMap,this.saved.lightMapRotation,this.saved.cuts,this.saved.regions,this.saved.labelMix,this.saved.keep,this.saved.hidden,this.saved.maxSamples,this.saved.denoise,e.position]),n=He(e.invViewProjection,e.width,e.height)+i,o=e.moving?.5:1;if(n===this.lastKey&&!(this.lastScale<1&&!e.moving))return;this.lastKey=n,this.lastScale=o;const a=this.viewSpec(e,o);a!==void 0&&(o===1&&(this.lastSpec=a),this.send(t,a),clearTimeout(this.settle),o<1&&(this.settle=setTimeout(()=>{const l=this.lastFrame;if(l===void 0||this.lastScale===1)return;const c=this.viewSpec(l,1);c!==void 0&&(this.lastScale=1,this.lastSpec=c,this.send(t,c))},250)))}send(e,s){if(e==="local"){this.local?.setView(s);return}if(this.sending){this.queued=s;return}this.sending=!0,this.service.setView(e,s).catch(t=>{this.problem=t.message,this.statusUpdate?.()}).finally(()=>{this.sending=!1;const t=this.queued;this.queued=void 0,t!==void 0&&this.send(e,t)})}addKeyframe(){const e=this.lastSpec;if(e===void 0){this.ctx.ui.toast("Render a view first: switch Render on and look at the image in 3-D.","error");return}const s=this.saved.keyframes.at(-1)?.time??-2;this.save(t=>t.keyframes.push({time:s+2,view:{...e,scale:1}})),this.panelUpdate?.()}currentSpec(){const e=this.lastFrame;return e?this.viewSpec(e,1):this.lastSpec}centreOnTissue(){const e=this.session?.volume?.tissue_mm,s=this.lastFrame;if(!e||s===void 0){this.ctx.ui.toast("Render first: the tissue's box comes with the rendered image.","error");return}const t=ae(s.dimensions);if(t===void 0)return;const i=c=>[0,1,2].map(u=>t[u]*c[0]+t[4+u]*c[1]+t[8+u]*c[2]+t[12+u]),n=i(e[0]),o=i(e[1]),a=n.map((c,u)=>(c+o[u])/2),l=Math.max(...n.map((c,u)=>Math.abs(o[u]-c)));this.ctx.viewer.patchState(c=>{const u=c,p=Array.isArray(u.position)?u.position.slice():[0,0,0];for(let m=0;m<3;++m)p[m]=a[m];u.position=p,u.projectionScale=l*1.4})}async saveStill(){const e=this.session?.id,s=this.currentSpec();if(e===void 0||s===void 0)return;const t=this.saved.movie;this.ctx.ui.toast(`Rendering a ${t.width} × ${t.height} still at ${t.samples*2} samples on the host…`);try{const i=await this.service.still(e,{view:s,width:t.width,height:t.height,samples:t.samples*2,name:"anatomical-rendering"});K(i,"anatomical-rendering.png")}catch(i){this.ctx.ui.toast(`Still: ${i.message}`,"error")}}async renderRotation(){const e=this.currentSpec();if(e===void 0)return;const s=this.saved.rotation;await this.renderMovie({keyframes:[{time:0,view:{...e,scale:1}}],rotation:s,name:`rotation-${s.axis}-${s.degrees}`})}loadPresetFile(){const e=f("input",{type:"file",accept:".json,application/json"});e.onchange=async()=>{const s=e.files?.[0];if(s)try{const t=JSON.parse(await s.text()),i=(Array.isArray(t)?t:[t]).filter(n=>n&&typeof n.name=="string"&&Array.isArray(n.stops));if(i.length===0)throw new Error("no preset in it (a preset has a name and stops)");this.save(n=>{const o=new Set(i.map(a=>a.name));n.customPresets=[...n.customPresets.filter(a=>!o.has(a.name)),...i],n.preset=i[0].name}),this.panelUpdate?.()}catch(t){this.ctx.ui.toast(`Preset file: ${t.message}`,"error")}},e.click()}async renderMovie(e){const s=this.session?.id;if(s===void 0||e===void 0&&this.saved.keyframes.length<1)return;const t=this.saved.movie;try{let i=await this.service.movie(s,{keyframes:this.saved.keyframes,fps:t.fps,width:t.width,height:t.height,samples:t.samples,easing:t.easing,name:"anatomical-rendering",...e??{}});for(this.movie=i,this.panelUpdate?.();i.status==="queued"||i.status==="running";)await new Promise(n=>setTimeout(n,1e3)),i=await this.service.movieInfo(i.id),this.movie=i,this.statusUpdate?.();this.panelUpdate?.()}catch(i){this.ctx.ui.toast(`Movie: ${i.message}`,"error")}}status(){const e=[],s=this.saved.where==="host"?this.serviceInfo?.gpu:void 0;s&&e.push(s.backend==="cuda"?`GPU: ${s.name} (${Math.round((s.free_mb??0)/1024)} of ${Math.round((s.total_mb??0)/1024)} GB free)`:`No GPU: ${s.error??""}`);const t=this.session;if(t)if(t.status==="loading")e.push(`Loading: ${t.message} (${Math.round(t.progress*100)}%)`);else if(t.status==="failed")e.push(`Failed: ${t.error}`);else{const i=t.volume;e.push(`${t.message}${i.made?i.from_cache?" (made here, from the cache)":" (made here by downsampling)":""}`)}return this.saved.where==="browser"&&this.localText&&e.push(this.localText),this.frameText&&e.push(this.frameText),this.movie&&e.push(`Movie: ${this.movie.status} ${Math.round(this.movie.progress*100)}% ${this.movie.message}${this.movie.error?` (${this.movie.error})`:""}`),this.problem&&e.push(this.problem),e.join(`
`)}panel(e){const s=f("pre",{class:"muted",style:"white-space: pre-wrap; font-size: 11px; margin: 6px 0"});this.statusUpdate=()=>void(s.textContent=this.status());const t=()=>{const o=this.saved,a=this.images(),l=this.segmentations(),p=[...o.where==="browser"?j.map(r=>({name:r.name,modality:r.modality??"",density:r.density})):this.presets,...o.customPresets.map(r=>({name:String(r.name),modality:"from a file",density:Number(r.density??40)}))].map(r=>[r.name,r.modality?`${r.name} (${r.modality})`:r.name]),m=f("input",{type:"text",value:this.host.address,style:"width: 100%",title:"The runner's address (or a pairing link), e.g. http://localhost:7000 at the end of an SSH tunnel"}),g=f("input",{type:"password",value:this.host.token,style:"width: 100%",placeholder:"pairing token"}),y=f("input",{type:"checkbox"});y.checked=this.host.viaRunner;const w=()=>{const r=qe(m.value);this.host={name:"",address:r.address??m.value,token:r.token??g.value,viaRunner:r.viaRunner??y.checked},this.ctx.settings.set(Z,this.host),this.connect()},b=r=>{const d=o.cuts[r],R=f("input",{type:"checkbox"});return R.checked=d.on,R.onchange=()=>this.save(E=>E.cuts[r].on=R.checked),f("div",{style:"display: flex; gap: 6px; align-items: center"},R,f("span",{},`Cut across ${d.axis}`),I([["-1","keep −"],["1","keep +"]],String(d.keep),E=>this.save(M=>M.cuts[r].keep=Number(E))),(()=>{const E=f("input",{type:"range",min:"-100",max:"100",step:"0.5",value:String(d.offset),style:"width: 90px",title:"Offset from the position (mm)"});return E.onchange=()=>this.save(M=>M.cuts[r].offset=Number(E.value)),E})(),z(d.offset,E=>this.save(M=>M.cuts[r].offset=E),{step:"1",style:"width: 56px",title:"Offset from the position (mm)"}))},x=f("input",{type:"checkbox"});x.checked=o.regions,x.onchange=()=>this.save(r=>r.regions=x.checked);const U=r=>r.split(/[\s,]+/).filter(Boolean).map(Number).filter(d=>Number.isInteger(d)),T=o.keyframes.map((r,d)=>f("div",{style:"display: flex; gap: 6px; align-items: center"},f("span",{},`#${d+1} at`),z(r.time,R=>this.save(E=>E.keyframes[d].time=R),{step:"0.5",style:"width: 60px"}),f("span",{},"s"),L("Remove",()=>{this.save(R=>R.keyframes.splice(d,1)),t()}))),S=this.movie,v=this.renderHosts(),k=this.host.name??this.ctx.hosts.pick({service:"render"})?.name??"",P=I([...v.map(r=>[r.name,`${r.name}${r.info?.hostname?` (${r.info.hostname})`:""}${r.available?"":": not answering"}`]),["","An address…"]],v.some(r=>r.name===k)?k:"",r=>{this.host={...this.host,name:r||void 0},r||(this.host.name=""),this.ctx.settings.set(Z,this.host),this.connect(),t()}),O=!v.some(r=>r.name===k);ue(e,f("h3",{},"Anatomical rendering"),f("p",{class:"muted"},"Path-traced views of an OME-Zarr image, rendered on a GPU through a runner (this computer, or another over SSH)."),_("Host",P,v.length?"Computers paired in the Jobs tab whose runner has the render service":"Pair a computer in the Jobs tab (its runner started with the render service), or give an address"),O?_("Address",m,"The runner's address, or paste its pairing link"):"",O?_("Token",g):"",O?f("label",{style:"display: flex; gap: 6px; align-items: center"},y,"Through a runner (/svc/render)"):"",L(O?"Connect":"Reconnect",O?w:()=>void this.connect()),f("hr"),_("Where",I([["host","On the host (CUDA, through the runner)"],["browser","In this browser (WebGPU)"]],o.where,r=>{this.save(d=>d.where=r),this.update(),t()})),f("label",{style:"display: flex; gap: 6px; align-items: center"},(()=>{const r=f("input",{type:"checkbox"});return r.checked=o.on,r.onchange=()=>this.setOn(r.checked),r})(),f("b",{},"Render")),_("Image",a.length?I(a.map(r=>[r.name,r.name]),this.target()?.name??"",r=>this.save(d=>d.layer=r)):f("span",{class:"muted"},"No OME-Zarr image in the scene")),_("Preset",p.length?I(p,o.preset,r=>this.save(d=>d.preset=r)):f("span",{class:"muted"},"(connect first)")),this.referenceNote(),L("Load a preset file…",()=>this.loadPresetFile(),"A JSON preset (or a list of them): name, domain, stops of value, colour and opacity, and material"),this.windowField(),this.editorField(),o.where==="host"?f("label",{style:"display: flex; gap: 6px; align-items: center",title:"Render only a cylinder about the scan's axis, leaving out the jar's wall (HiP-CT organs in their jars)"},(()=>{const r=f("input",{type:"checkbox"});return r.checked=o.jar,r.onchange=()=>{this.save(d=>d.jar=r.checked),this.update()},r})(),"Hide the jar"):"",_("Density (per mm)",z(o.density??Number(this.presets.find(r=>r.name===o.preset)?.density??40),r=>this.save(d=>d.density=r),{step:"1",min:"0"})),_("Exposure",z(o.exposure,r=>this.save(d=>d.exposure=r),{step:"0.1",min:"0"})),_("Light (azimuth, elevation °)",f("div",{style:"display: flex; gap: 6px"},z(o.lightAzimuth,r=>this.save(d=>d.lightAzimuth=r),{step:"10",style:"width: 70px"}),z(o.lightElevation,r=>this.save(d=>d.lightElevation=r),{step:"10",style:"width: 70px"}))),o.where==="host"&&(this.serviceInfo?.lightmaps?.length??0)>0?_("Light map",f("div",{style:"display: flex; gap: 6px"},I([["","sky colours (the preset's)"],...this.serviceInfo.lightmaps.map(r=>[r,r])],o.lightMap,r=>this.save(d=>d.lightMap=r)),z(o.lightMapRotation,r=>this.save(d=>d.lightMapRotation=r),{step:"15",style:"width: 60px",title:"Turn the light map (degrees)"})),"Image-based light: HDR panoramas (CC0, Poly Haven)"):"",f("h4",{},"View"),f("div",{style:"display: flex; gap: 4px; flex-wrap: wrap"},L("Centre on the tissue",()=>this.centreOnTissue(),"Move the position to the middle of the tissue and zoom to show all of it"),...Xe.map(r=>L(r.name,()=>this.ctx.viewer.patchState(d=>void(d.projectionOrientation=Ve(r.forward,r.up)))))),f("h4",{},"Cuts (through the position)"),b(0),b(1),b(2),f("label",{style:"display: flex; gap: 6px; align-items: center"},(()=>{const r=f("input",{type:"checkbox"});return r.checked=o.box.on,r.onchange=()=>this.save(d=>d.box.on=r.checked),r})(),"Clip box (fractions of the volume)"),...o.box.on?["x","y","z"].map((r,d)=>{const R=E=>{const M=f("input",{type:"range",min:"0",max:"1",step:"0.01",value:String(o.box[E][d]),style:"width: 90px",title:`${E==="lo"?"Low":"High"} ${r}`});return M.onchange=()=>this.save(X=>X.box[E][d]=Number(M.value)),M};return f("div",{style:"display: flex; gap: 6px; align-items: center"},f("span",{style:"width: 14px"},r),R("lo"),R("hi"))}):[],f("h4",{},"Regions"),f("label",{style:"display: flex; gap: 6px; align-items: center"},x,"Colour by a segmentation's regions"),l.length?_("Segmentation",I(l.map(r=>[r.name,r.name]),l.find(r=>r.name===o.labels)?.name??l[0].name,r=>this.save(d=>d.labels=r))):f("p",{class:"muted"},"No OME-Zarr segmentation in the scene."),_("Region colour",z(o.labelMix,r=>this.save(d=>d.labelMix=r),{step:"0.05",min:"0",max:"1"}),"0: the preset's colours, 1: the regions'"),_("Hidden regions",(()=>{const r=f("input",{type:"text",value:o.hidden.join(", "),placeholder:"label ids"});return r.onchange=()=>this.save(d=>d.hidden=U(r.value)),r})()),_("Kept through cuts",(()=>{const r=f("input",{type:"text",value:o.keep.join(", "),placeholder:"label ids"});return r.onchange=()=>this.save(d=>d.keep=U(r.value)),r})()),f("h4",{},"Quality"),_("Whole volume (million voxels on the GPU)",z(o.budget/1e6,r=>this.save(d=>d.budget=Math.max(1,r)*1e6),{step:"50",min:"1"}),"One level of the whole image: the finest stored level within this, or one made from a finer level"),o.where==="host"?f("label",{style:"display: flex; gap: 6px; align-items: center",title:"When the view comes close, the region in view is read at a finer level and rendered from it; the rest of the volume (shadows, light scattered from outside the view) stays at the whole volume's level"},(()=>{const r=f("input",{type:"checkbox"});return r.checked=o.detail,r.onchange=()=>{this.save(d=>d.detail=r.checked),this.update()},r})(),"Finer detail where you zoom"):"",o.where==="host"&&o.detail?_("Detail where you look (million voxels)",z(o.detailBudget/1e6,r=>{this.save(d=>d.detailBudget=Math.max(1,r)*1e6),this.update()},{step:"50",min:"1"}),"The finest stored level whose region in view fits this, and no finer than a pixel there"):"",f("label",{style:"display: flex; gap: 6px; align-items: center"},(()=>{const r=f("input",{type:"checkbox"});return r.checked=o.denoise,r.onchange=()=>this.save(d=>d.denoise=r.checked),r})(),"Smooth the first frames after a change (host)"),_("Samples per pixel",z(o.maxSamples,r=>this.save(d=>d.maxSamples=Math.max(1,Math.round(r))),{step:"64",min:"1"})),f("h4",{},"Movie"),...T,L("Add keyframe from the view",()=>this.addKeyframe()),f("div",{style:"display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px"},_("fps",z(o.movie.fps,r=>this.save(d=>d.movie.fps=r),{style:"width: 50px"})),_("width",z(o.movie.width,r=>this.save(d=>d.movie.width=r),{style:"width: 70px"})),_("height",z(o.movie.height,r=>this.save(d=>d.movie.height=r),{style:"width: 70px"})),_("samples",z(o.movie.samples,r=>this.save(d=>d.movie.samples=r),{style:"width: 60px"})),_("camera",I([["smooth","slows at keyframes"],["linear","steady"]],o.movie.easing,r=>this.save(d=>d.movie.easing=r)))),f("div",{style:"display: flex; gap: 6px; flex-wrap: wrap"},L("Save still (PNG)",()=>void this.saveStill(),"The view now at the movie's size, path-traced to twice its samples"),L("Render movie on the host",()=>void this.renderMovie()),S?.status==="running"?L("Cancel",()=>void this.service?.cancelMovie(S.id)):"",S?.status==="done"?L("Download",()=>void this.service.movieFile(S.id).then(r=>K(r,"anatomical-rendering.mp4"))):""),f("div",{style:"display: flex; gap: 6px; flex-wrap: wrap; align-items: end; margin-top: 4px"},_("rotate",I([["vertical","about the vertical"],["horizontal","about the horizontal"]],o.rotation.axis,r=>this.save(d=>d.rotation.axis=r))),_("circle",I([["360","full"],["180","half"]],String(o.rotation.degrees),r=>this.save(d=>d.rotation.degrees=Number(r)))),_("step °",z(o.rotation.step,r=>this.save(d=>d.rotation.step=Math.max(.25,r)),{step:"1",style:"width: 50px"})),L("Render rotation",()=>void this.renderRotation(),"A turn about the position from the view now, at the movie's size and samples")),s),this.statusUpdate?.()};let i=!1,n=!0;return this.panelUpdate=()=>{i||(i=!0,setTimeout(()=>{i=!1,n&&t()},0))},t(),()=>{n=!1,this.panelUpdate=void 0,this.statusUpdate=void 0}}dispose(){this.closeSession(),this.handle?.dispose(),this.drawer.dispose(),this.toggle.dispose();for(const e of this.offs)e()}}const et={activate(h){const e=new Ke(h);h.subscriptions.push(()=>e.dispose())}};export{qe as parseHostText,et as plugin,le as readSaved};
