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
 */function B(e,t,o,n,c,u){let f=0,d=0,l=1,V=1;for(let s=0;s<3;++s){const h=c[s],p=n[s],x=Math.floor(h/p),w=h%p;f+=x*l,l*=Math.ceil(o[s]/p),d+=w*V,V*=p}const O=t+f*2,g=e[O],b=e[O+1];let r=g&16777215;const i=g>>24&255;if(i>0){const h=(t+b&16777215)+Math.floor(d*i/32),p=e[h],x=d*i%32,w=p>>x&(1<<i)-1;r+=u*w}return r}function C(e,t){return BigInt(e[t])|BigInt(e[t+1])<<32n}function y(e,t,o,n,c){return e[B(e,t,o,n,c,1)+t]}function U(e,t,o,n,c){return C(e,B(e,t,o,n,c,2)+t)}function a(e,t,o,n,c){let u,f;e instanceof Uint32Array?(u=1,f=r=>t[r]):(u=2,f=r=>C(t,r));const d=n[0]*n[1]*n[2];if(d!==e.length)throw new Error(`Output length ${e.length} is not equal to expected length ${d}.`);const l=n[0],V=n[1],O=n[2],g=[0,0,0];let b=0;for(let r=0;r<O;++r){g[2]=r;for(let i=0;i<V;++i){g[1]=i;for(let s=0;s<l;++s){g[0]=s;const h=B(t,o,n,c,g,u)+o;e[b++]=f(h)}}}return e}function $(e,t,o,n,c){const u=n[0]*n[1]*n[2],f=u*n[3];if(f!==e.length)throw new Error(`Output length ${e.length} is not equal to expected length ${f}.`);const d=n[3];for(let l=0;l<d;++l)a(e.subarray(u*l,u*(l+1)),t,o+t[l],n,c);return e}export{y as a,$ as d,U as r};
