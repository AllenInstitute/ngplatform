/**
 * The rendered image in Neuroglancer's 3-D view: drawn over the whole
 * panel with the depth where each pixel's ray first meets tissue, so
 * Neuroglancer's own layers (tracts, meshes, annotations, sections) are
 * hidden behind tissue and show in front of it.  Pixels where the ray
 * met nothing are left to the view.
 */
import type { Drawer3d, Frame3d } from "@ngplatform/sdk";

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = (o: Frame3d["outputs"]) => `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform highp sampler2D uDepth;
uniform vec4 uViewport;
uniform float uHasDepth;
layout(location = ${o.color}) out vec4 out_color;
layout(location = ${o.z}) out highp vec4 out_z;
layout(location = ${o.pick}) out highp vec4 out_pickId;
void main() {
  vec2 uv = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw;
  uv.y = 1.0 - uv.y;
  vec4 c = texture(uColor, uv);
  if (c.a < 0.5) discard;
  float d = uHasDepth > 0.5 ? texture(uDepth, uv).r : 0.5;
  d = clamp(d, 0.0, 0.99999);
  gl_FragDepth = d;
  out_color = vec4(c.rgb / max(c.a, 1e-3), 1.0);
  out_z = vec4(1.0 - d);
  out_pickId = vec4(0.0);
}`;

export interface Picture {
  bitmap: ImageBitmap;
  depth?: { width: number; height: number; data: Float32Array };
}

export class PictureDrawer implements Drawer3d {
  /** Called at each frame, before drawing, with the frame: the plugin sends the view from it. */
  onFrame: ((frame: Frame3d) => void) | undefined;
  private picture: Picture | undefined;
  private uploaded: Picture | undefined;
  private uploadedDepth: Picture["depth"] | undefined;
  private gl: WebGL2RenderingContext | undefined;
  private program: WebGLProgram | undefined;
  private programFor = "";
  private vao: WebGLVertexArrayObject | undefined;
  private color: WebGLTexture | undefined;
  private depth: WebGLTexture | undefined;

  set(picture: Picture | undefined): void {
    this.picture = picture;
  }

  isReady(): boolean {
    return this.picture !== undefined;
  }

  draw(frame: Frame3d): void {
    this.onFrame?.(frame);
    const pic = this.picture;
    if (pic === undefined) return;
    const gl = frame.gl;
    if (this.gl !== gl) this.reset(gl);
    const program = this.compile(gl, frame.outputs);
    if (program === undefined) return;
    if (this.uploaded !== pic) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.color!);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, pic.bitmap);
      this.uploaded = pic;
    }
    if (pic.depth !== undefined && this.uploadedDepth !== pic.depth) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.depth!);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, pic.depth.width, pic.depth.height, 0, gl.RED, gl.FLOAT, pic.depth.data);
      this.uploadedDepth = pic.depth;
    }
    gl.useProgram(program);
    const vp = gl.getParameter(gl.VIEWPORT) as Int32Array;
    gl.uniform4f(gl.getUniformLocation(program, "uViewport"), vp[0], vp[1], vp[2], vp[3]);
    gl.uniform1f(gl.getUniformLocation(program, "uHasDepth"), pic.depth !== undefined ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.color!);
    gl.uniform1i(gl.getUniformLocation(program, "uColor"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depth!);
    gl.uniform1i(gl.getUniformLocation(program, "uDepth"), 1);
    gl.bindVertexArray(this.vao!);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  private reset(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.program = undefined;
    this.programFor = "";
    this.uploaded = undefined;
    this.uploadedDepth = undefined;
    this.vao = gl.createVertexArray()!;
    const tex = (filter: number) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.color = tex(gl.LINEAR);
    this.depth = tex(gl.NEAREST);
  }

  private compile(gl: WebGL2RenderingContext, outputs: Frame3d["outputs"]): WebGLProgram | undefined {
    const key = JSON.stringify(outputs);
    if (this.program !== undefined && this.programFor === key) return this.program;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS(outputs)));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    this.program = p;
    this.programFor = key;
    return p;
  }

  dispose(): void {
    const gl = this.gl;
    if (gl === undefined) return;
    if (this.program) gl.deleteProgram(this.program);
    if (this.color) gl.deleteTexture(this.color);
    if (this.depth) gl.deleteTexture(this.depth);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.gl = undefined;
  }
}
