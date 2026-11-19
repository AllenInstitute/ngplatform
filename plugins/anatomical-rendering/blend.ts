/**
 * Draws with the colour output blended by alpha while the depth and pick outputs are written as they are, so a
 * picture's pixels less than covered (a surface less than opaque, a dendrite thinner than a pixel) are as clear as
 * they are rather than cut at a threshold (which left them speckled).
 *
 * With OES_draw_buffers_indexed (blending one output alone) and blending off: one draw. Otherwise two, choosing the
 * outputs with drawBuffers (WebGL 2's own): the depth and pick outputs first, not blended; then the colour alone,
 * blended, where the first pass left the depth (LEQUAL, the depth not written again). Every state touched is put back.
 */
type Indexed = {
  enableiOES(t: number, i: number): void;
  disableiOES(t: number, i: number): void;
  blendFuncSeparateiOES(i: number, a: number, b: number, c: number, d: number): void;
  blendEquationiOES(i: number, m: number): void;
};

/** `premultiplied`: the colour is already times alpha (ONE, ONE_MINUS_SRC_ALPHA); else SRC_ALPHA. */
export function drawColourBlended(gl: WebGL2RenderingContext, color: number, draw: () => void, premultiplied: boolean): void {
  const src = premultiplied ? gl.ONE : gl.SRC_ALPHA;
  const ext = gl.getExtension("OES_draw_buffers_indexed") as Indexed | null;
  const blendWasOn = gl.isEnabled(gl.BLEND);
  if (ext !== null && !blendWasOn) {
    ext.enableiOES(gl.BLEND, color);
    ext.blendEquationiOES(color, gl.FUNC_ADD);
    ext.blendFuncSeparateiOES(color, src, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    draw();
    ext.disableiOES(gl.BLEND, color);
    return;
  }
  const count = gl.getParameter(gl.MAX_DRAW_BUFFERS) as number;
  const buffers: number[] = [];
  for (let i = 0; i < count; ++i) buffers.push(gl.getParameter(gl.DRAW_BUFFER0 + i) as number);
  // The default framebuffer takes only BACK or NONE: there is one output, so one draw, blended.
  const fbo = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const last = buffers.reduce((n, b, i) => (b !== gl.NONE ? i + 1 : n), 0);
  const saved = {
    func: [gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA].map((p) => gl.getParameter(p) as number),
    eq: [gl.getParameter(gl.BLEND_EQUATION_RGB) as number, gl.getParameter(gl.BLEND_EQUATION_ALPHA) as number],
    depthFunc: gl.getParameter(gl.DEPTH_FUNC) as number,
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
  };
  const blended = () => {
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(src, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
  };
  if (fbo === null || color >= last) {
    blended();
    draw();
  } else {
    const active = buffers.slice(0, last);
    // The depth and pick outputs, not blended.
    gl.disable(gl.BLEND);
    gl.drawBuffers(active.map((b, i) => (i === color ? gl.NONE : b)));
    draw();
    // The colour alone, blended, over the depth just written.
    gl.drawBuffers(active.map((b, i) => (i === color ? b : gl.NONE)));
    blended();
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    draw();
    gl.drawBuffers(active);
    gl.depthFunc(saved.depthFunc);
    gl.depthMask(saved.depthMask);
  }
  gl.blendFuncSeparate(saved.func[0], saved.func[1], saved.func[2], saved.func[3]);
  gl.blendEquationSeparate(saved.eq[0], saved.eq[1]);
  if (blendWasOn) gl.enable(gl.BLEND);
  else gl.disable(gl.BLEND);
}
