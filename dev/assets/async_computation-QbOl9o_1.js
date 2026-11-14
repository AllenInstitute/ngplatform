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
 */function d(e){return{id:e}}const r=new Map;function g(e){self.onmessage=async o=>{const{t:s,id:t,args:l}=o.data;try{const n=r.get(s);if(n===void 0)throw new Error(`Internal error: async computation operation ${JSON.stringify(s)} is not registered.  Registered handlers: ${JSON.stringify(Array.from(r.keys()))}`);const{value:u,transfer:a}=await n(...l);let c=0;for(const i of a??[])i instanceof ArrayBuffer&&(c+=i.byteLength);const y=c>=33554432?!0:void 0;e.postMessage({id:t,value:u,retire:y},{transfer:a})}catch(n){e.postMessage({id:t,error:n})}},self.postMessage(null)}g(self);function f(e,o){r.set(e.id,o)}const p=d("decodeBlosc");f(p,async e=>{const{default:o}=await import("./blosc-CrUiACa7.js"),t=await o.fromConfig({id:"blosc"}).decode(e);return{value:t,transfer:[t.buffer]}});const m=d("decodeZstd");f(m,async e=>{const{default:o}=await import("./zstd-u5eweWyS.js"),t=await o.fromConfig({id:"blosc"}).decode(e);return{value:t,transfer:[t.buffer]}});var E=Object.freeze({__proto__:null});export{d as a,E as b,f as r};
