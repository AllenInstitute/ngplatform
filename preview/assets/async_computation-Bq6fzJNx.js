/**
 * @license
 * Copyright 2019 Google Inc.
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
 */function a(e){return{id:e}}/**
 * @license
 * Copyright 2019 Google Inc.
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
 */const r=new Map;function l(e){self.onmessage=async s=>{const{t:o,id:t,args:d}=s.data;try{const n=r.get(o);if(n===void 0)throw new Error(`Internal error: async computation operation ${JSON.stringify(o)} is not registered.  Registered handlers: ${JSON.stringify(Array.from(r.keys()))}`);const{value:i,transfer:f}=await n(...d);e.postMessage({id:t,value:i},{transfer:f})}catch(n){e.postMessage({id:t,error:n})}},self.postMessage(null)}l(self);function c(e,s){r.set(e.id,s)}const u=a("decodeBlosc");c(u,async e=>{const{default:s}=await import("./blosc-CrUiACa7.js"),t=await s.fromConfig({id:"blosc"}).decode(e);return{value:t,transfer:[t.buffer]}});const g=a("decodeZstd");c(g,async e=>{const{default:s}=await import("./zstd-u5eweWyS.js"),t=await s.fromConfig({id:"blosc"}).decode(e);return{value:t,transfer:[t.buffer]}});var p=Object.freeze({__proto__:null});export{a,p as b,c as r};
