import React, { useEffect, useRef } from "react";

const VERT = `
  attribute vec2 a_pos;
  void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
  precision mediump float;
  uniform vec2  u_res;
  uniform vec2  u_mouse;
  uniform float u_time;
  uniform float u_activity;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_res;
    uv.y = 1.0 - uv.y;
    float asp = u_res.x / u_res.y;
    vec2 st = vec2(uv.x * asp, uv.y);
    vec2 m  = vec2(u_mouse.x / u_res.x * asp, 1.0 - u_mouse.y / u_res.y);

    /* ── Rotated diamond grid ───────────────────────────────────── */
    float sc = 7.0;
    vec2 g   = st * sc;
    vec2 dg  = vec2(g.x + g.y, g.x - g.y);
    vec2 ci  = floor(dg);
    vec2 cf  = fract(dg) - 0.5;

    float r  = hash(ci);
    float r2 = hash(ci + vec2(3.7, 1.9));

    /* ── Triangular sub-facet normal (4 per diamond cell) ──────── */
    vec2 fn;
    if      (cf.x >= 0.0 && cf.y >= 0.0) fn = vec2( 1.0,  1.0);
    else if (cf.x <  0.0 && cf.y >= 0.0) fn = vec2(-1.0,  1.0);
    else if (cf.x <  0.0 && cf.y <  0.0) fn = vec2(-1.0, -1.0);
    else                                   fn = vec2( 1.0, -1.0);
    fn = normalize(fn + vec2(r - 0.5, r2 - 0.5) * 0.28);

    /* ── Lighting from mouse ────────────────────────────────────── */
    vec2  ld = normalize(m - st + vec2(0.0001));
    float d  = max(dot(fn, ld), 0.0);
    float md = length(m - st);
    float fo = 1.0 / (1.0 + md * md * 5.5);

    /* ── Palette ────────────────────────────────────────────────── */
    vec3 bg   = vec3(0.941, 0.933, 0.918);  /* #f0eeea  */
    vec3 ruby = vec3(0.929, 0.047, 0.282);  /* #ED0C48  */
    vec3 deep = vec3(0.502, 0.016, 0.165);  /* deep ruby */

    /* ── Facet edge lines ───────────────────────────────────────── */
    float edge = max(abs(cf.x), abs(cf.y));
    float line = smoothstep(0.455, 0.500, edge);

    vec3 col = bg * (1.0 - line * 0.013);

    /* ── Mouse-driven ruby sparkle (gated by activity) ─────────── */
    float spec = pow(d * fo, 2.2) * 2.8;
    col += mix(deep, ruby, d) * spec * 0.60 * u_activity;

    /* ── Slow ambient pulse (gated by activity) ─────────────────── */
    float pulse = (sin(u_time * 0.38 + r * 6.28318) * 0.5 + 0.5) * fo;
    col += ruby * pulse * 0.055 * u_activity;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export default function DiamondShader(): JSX.Element {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const mouseRef   = useRef({ x: -9999, y: -9999 });
  const lastMoveRef = useRef(0);
  const actRef     = useRef(0);
  const rafRef     = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;

    const gl = canvas.getContext("webgl");
    if (!gl) return;

    /* compile + link */
    const mkShader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, mkShader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, mkShader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    /* full-screen quad */
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const ap = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(ap);
    gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);

    const uRes      = gl.getUniformLocation(prog, "u_res");
    const uMouse    = gl.getUniformLocation(prog, "u_mouse");
    const uTime     = gl.getUniformLocation(prog, "u_time");
    const uActivity = gl.getUniformLocation(prog, "u_activity");

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width  = canvas.offsetWidth  * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    /* track movement within the parent element only */
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const dpr  = window.devicePixelRatio || 1;
      mouseRef.current   = { x: (e.clientX - rect.left) * dpr, y: (e.clientY - rect.top) * dpr };
      lastMoveRef.current = performance.now();
    };
    const onLeave = () => { lastMoveRef.current = 0; };

    parent?.addEventListener("mousemove", onMove);
    parent?.addEventListener("mouseleave", onLeave);

    const t0 = performance.now();
    const draw = () => {
      /* smooth activity: 1 while moving, fades out after 300 ms idle / on leave */
      const timeSince = (performance.now() - lastMoveRef.current) / 1000;
      const target   = lastMoveRef.current > 0 && timeSince < 0.3 ? 1.0 : 0.0;
      const lerpRate = target > actRef.current ? 0.025 : 0.06;
      actRef.current += (target - actRef.current) * lerpRate;

      gl.uniform2f(uRes,      canvas.width, canvas.height);
      gl.uniform2f(uMouse,    mouseRef.current.x, mouseRef.current.y);
      gl.uniform1f(uTime,     (performance.now() - t0) / 1000);
      gl.uniform1f(uActivity, actRef.current);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      rafRef.current = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      parent?.removeEventListener("mousemove", onMove);
      parent?.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "block",
        pointerEvents: "none",
      }}
    />
  );
}
