/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function x(e,t,r,n,a,l){let u=0,d=0,o=1,p=1;for(let s=0;s<3;++s){const g=a[s],f=n[s],y=Math.floor(g/f),b=g%f;u+=y*o,o*=Math.ceil(r[s]/f),d+=b*p,p*=f}const w=t+u*2,h=e[w],m=e[w+1];let i=h&16777215;const c=h>>24&255;if(c>0){const g=(t+m&16777215)+Math.floor(d*c/32),f=e[g],y=d*c%32,b=f>>y&(1<<c)-1;i+=l*b}return i}function v(e,t){return BigInt(e[t])|BigInt(e[t+1])<<32n}function N(e,t,r,n,a){return e[x(e,t,r,n,a,1)+t]}function k(e,t,r,n,a){return v(e,x(e,t,r,n,a,2)+t)}function L(e,t,r,n,a){let l,u;e instanceof Uint32Array?(l=1,u=i=>t[i]):(l=2,u=i=>v(t,i));const d=n[0]*n[1]*n[2];if(d!==e.length)throw new Error(`Output length ${e.length} is not equal to expected length ${d}.`);const o=n[0],p=n[1],w=n[2],h=[0,0,0];let m=0;for(let i=0;i<w;++i){h[2]=i;for(let c=0;c<p;++c){h[1]=c;for(let s=0;s<o;++s){h[0]=s;const g=x(t,r,n,a,h,l)+r;e[m++]=u(g)}}}return e}function A(e,t,r,n,a){const l=n[0]*n[1]*n[2],u=l*n[3];if(u!==e.length)throw new Error(`Output length ${e.length} is not equal to expected length ${u}.`);const d=n[3];for(let o=0;o<d;++o)L(e.subarray(l*o,l*(o+1)),t,r+t[o],n,a);return e}function T(e,t={}){return JSON.stringify(t.revalidate?{plugins:e,revalidate:!0}:{plugins:e})}function B(e){const t=e.fetch.bind(e);e.fetch=(r,n)=>t(r,{cache:"no-cache",...n})}const V="luxar.panel",O="luxar",E={id:"org.ngplatform.luxar",name:"Luxar rendering",version:"0.1.0",kind:"tool",enabledByDefault:!1,description:"Draws chosen Zarr Vectors layers the way the Luxar viewer does (glowing HDR lines with mitred joins, tone mapped), in Neuroglancer's own 2-D and 3-D views.",guide:`Luxar renders lines and points as light: smooth thick lines with mitred joins, added up in HDR and tone mapped, or as emission and absorption. This plugin draws a Zarr Vectors layer (a tractogram, skeletons, a point cloud, or a \`.trk\`, \`.tck\`, \`.trx\` or SWC file opened in place) that way **in Neuroglancer's own views**: the 3-D view and the 2-D sections, in one viewer, with everything else drawn as before.

## Switching it on
- In the **Luxar** tab, tick a layer. That layer is then drawn by this plugin instead of by Neuroglancer; other layers (the image under a tractogram, say) are untouched, so a Luxar tractogram can sit on a plain or volume-rendered image.
- Or select the layer and run **Luxar rendering of the selected layer on or off** from the command palette.
- Hiding the layer hides its Luxar drawing too. Without this plugin, the same link shows the layer drawn by Neuroglancer as usual.

## Settings (per layer)
- **Blending**: *Glow* adds the lines' light up, hidden by what is in front; *Glow through* shows it over everything; *Emission and absorption* also darkens what is behind dense bundles; *Solid tubes* draws opaque shaded lines.
- **Colour**: by direction (x red, y green, z blue), each object its own colour, a vertex attribute through a colormap, or one colour.
- **Width** (pixels), **Brightness** (stops before tone mapping), **Sharpness** (soft to hard edged), **Tone map**.
- **2-D slab**: in a 2-D view, lines within half this distance of the section show, fading away from it.
- **Detail**: about how many vertices to read for a view. Like Neuroglancer, the plugin reads the coarsest level first and finer levels as you zoom in, only the chunks in view.

Nothing is converted and no files are written: the store (or the file read in place) is read directly.`,links:[{title:"Luxar (royerlab/luxar)",url:"https://github.com/royerlab/luxar"},{title:"This plugin's source",url:"https://github.com/AllenInstitute/ngplatform/tree/main/plugins/luxar"}],license:"Apache-2.0",requires:{plugins:["org.ngplatform.zarr-vectors"]},activation:["onStartup"],contributes:{panels:[{id:V,title:"Luxar",slot:"left",order:55}],commands:[{id:"luxar.toggle",title:"Luxar rendering of the selected layer on or off",group:"View",when:"sourceFormat == zarr-vectors"},{id:"luxar.show",title:"Show the Luxar rendering settings",group:"View"}],appState:{key:O,version:1}}};export{E as L,k as a,N as b,V as c,A as d,B as r,T as w};
