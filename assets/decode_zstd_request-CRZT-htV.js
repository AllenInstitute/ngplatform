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
 */function d(e){return{id:e}}const r=new Map;function g(e){self.onmessage=async t=>{const{t:n,id:s,args:f}=t.data;try{const o=r.get(n);if(o===void 0)throw new Error(`Internal error: async computation operation ${JSON.stringify(n)} is not registered.  Registered handlers: ${JSON.stringify(Array.from(r.keys()))}`);const{value:l,transfer:a}=await o(...f);let c=0;for(const i of a??[])i instanceof ArrayBuffer&&(c+=i.byteLength);const u=c>=33554432?!0:void 0;e.postMessage({id:s,value:l,retire:u},{transfer:a})}catch(o){e.postMessage({id:s,error:o})}},self.postMessage(null)}g(self);function y(e,t){r.set(e.id,t)}const p=d("decodeBlosc");y(p,async e=>{const{default:t}=await import("./blosc-CrUiACa7.js"),s=await t.fromConfig({id:"blosc"}).decode(e);return{value:s,transfer:[s.buffer]}});const E=d("decodeZstd");export{d as a,E as d,y as r};
