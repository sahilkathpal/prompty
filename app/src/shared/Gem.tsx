// The gem — Ruby's character. A faceted ruby whose face + motion carry every
// expressive state ("the character lives in the gem, never in extra
// interruptions"). One component, three variants:
//   variant="mini"  → small faceless ruby for titlebars / headers
//   variant="bare"  → a faced gem with no chrome
//   variant="pill"  → the dark vertical glass capsule (gem + waveform + grille)
//
// SVG polygon points and face paths are lifted from the design north-star
// prototype. Faces are inline fills; animation rides on CSS classes in gem.css.

import React from "react";
import "./gem.css";

export type GemState =
  | "idle"
  | "call-detected"
  | "listening"
  | "thinking"
  | "worth-asking"
  | "saved"
  | "attention";

// The faceted ruby body (shared by every variant). viewBox is 0 0 100 100.
function GemBody(): JSX.Element {
  return (
    <>
      <polygon points="30,18 70,18 85,38 15,38" fill="#ff5c7d" />
      <polygon points="30,18 42,38 15,38" fill="#ff8fa6" opacity="0.85" />
      <polygon points="70,18 85,38 58,38" fill="#e0204e" />
      <polygon points="15,38 42,38 50,88" fill="#b01238" />
      <polygon points="85,38 58,38 50,88" fill="#d8164a" />
      <polygon points="42,38 58,38 50,88" fill="#ff4d70" />
      <circle cx="38" cy="27" r="2.4" fill="#fff" opacity="0.95" />
    </>
  );
}

// Open-eye group (whites + pupils). The `.eyes` / `.pupil` classes let gem.css
// animate blink / look / sparkle when the parent pgem is `.alive` / `.excited`.
function Eyes(props: {
  rx?: number;
  ry?: number;
  pr?: number;
  py?: number;
}): JSX.Element {
  const { rx = 7.5, ry = 8.5, pr = 3.6, py = 52 } = props;
  return (
    <g className="eyes">
      <ellipse cx="39" cy="51" rx={rx} ry={ry} fill="#fff" />
      <ellipse cx="61" cy="51" rx={rx} ry={ry} fill="#fff" />
      <circle className="pupil" cx="40" cy={py} r={pr} fill="#2a1218" />
      <circle className="pupil" cx="62" cy={py} r={pr} fill="#2a1218" />
    </g>
  );
}

// The per-state face. Brows + eyes (or closed-eye arcs) drawn over the body.
function Face({ state }: { state: GemState }): JSX.Element | null {
  switch (state) {
    case "idle":
      // Asleep: two gentle closed-eye arcs.
      return (
        <>
          <path d="M31 50 q8 7 16 0" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" />
          <path d="M53 50 q8 7 16 0" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" />
        </>
      );
    case "saved":
      // Content: closed-eye happy arcs curving up.
      return (
        <>
          <path d="M31 52 q8 -8 16 0" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" />
          <path d="M53 52 q8 -8 16 0" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" />
        </>
      );
    case "call-detected":
      return (
        <>
          <path d="M30 35 q9 -7 17 -3" stroke="#2a1218" strokeWidth="3.5" fill="none" strokeLinecap="round" />
          <path d="M53 32 q8 -4 17 3" stroke="#2a1218" strokeWidth="3.5" fill="none" strokeLinecap="round" />
          <Eyes />
        </>
      );
    case "listening":
      return <Eyes />;
    case "thinking":
      return (
        <>
          <path d="M31 40 q8 -3 16 -1" stroke="#2a1218" strokeWidth="3.5" fill="none" strokeLinecap="round" />
          <path d="M53 33 q8 -4 16 2" stroke="#2a1218" strokeWidth="3.5" fill="none" strokeLinecap="round" />
          <Eyes py={48} />
        </>
      );
    case "worth-asking":
      return (
        <>
          <path d="M29 31 q9 -7 18 -4" stroke="#2a1218" strokeWidth="3.5" fill="none" strokeLinecap="round" />
          <path d="M53 27 q9 -3 18 4" stroke="#2a1218" strokeWidth="3.5" fill="none" strokeLinecap="round" />
          <Eyes rx={8} ry={9.5} pr={4} py={51} />
        </>
      );
    case "attention":
      return (
        <>
          <path d="M30 41 q9 -2 16 -6" stroke="#2a1218" strokeWidth="3.5" fill="none" strokeLinecap="round" />
          <path d="M54 35 q8 4 16 6" stroke="#2a1218" strokeWidth="3.5" fill="none" strokeLinecap="round" />
          <Eyes pr={3.2} py={53} />
        </>
      );
    default:
      return null;
  }
}

// Animation classes applied to the faced gem per state.
function pgemMotion(state: GemState): string {
  switch (state) {
    case "call-detected":
      return "alive bounce";
    case "listening":
      return "alive";
    case "worth-asking":
      return "excited";
    default:
      return "";
  }
}

function FacedGem({
  state,
  className,
  size,
}: {
  state: GemState;
  className?: string;
  size?: number;
}): JSX.Element {
  const dims = size ? { width: size, height: size } : undefined;
  return (
    <svg
      className={`pgem ${pgemMotion(state)}${className ? ` ${className}` : ""}`}
      viewBox="0 0 100 100"
      style={dims}
      aria-hidden
    >
      <GemBody />
      <Face state={state} />
    </svg>
  );
}

export interface GemProps {
  state?: GemState;
  variant?: "mini" | "bare" | "pill";
  /** Pixel size of the gem svg (mini defaults 13, bare defaults 30). */
  size?: number;
  /** For the pill: override whether the waveform animates (defaults from state). */
  waveActive?: boolean;
  className?: string;
}

export function Gem({
  state = "idle",
  variant = "bare",
  size,
  waveActive: waveActiveProp,
  className,
}: GemProps): JSX.Element {
  if (variant === "mini") {
    // Faceless simplified ruby for titlebars and headers.
    const px = size ?? 13;
    return (
      <svg
        className={`gem-mini${className ? ` ${className}` : ""}`}
        viewBox="0 0 100 100"
        style={{ width: px, height: px }}
        aria-hidden
      >
        <polygon points="30,18 70,18 85,38 15,38" fill="#ff5c7d" />
        <polygon points="15,38 85,38 50,88" fill="#d8164a" />
      </svg>
    );
  }

  if (variant === "bare") {
    return <FacedGem state={state} className={`gem-bare ${className ?? ""}`} size={size ?? 30} />;
  }

  // variant === "pill": dark glass capsule with gem + middle indicator + grille.
  const waveActive = waveActiveProp ?? (state === "listening" || state === "worth-asking" || state === "saved");
  const middle =
    state === "thinking" ? (
      <div className="gem-think">
        <i />
        <i />
        <i />
      </div>
    ) : (
      <div className={`gem-wave${waveActive ? "" : " flat"}`}>
        <span />
        <span />
        <span />
        <span />
      </div>
    );

  return (
    <div className={`gem-pill is-${state}${className ? ` ${className}` : ""}`}>
      <FacedGem state={state} size={26} />
      {middle}
      <div className="gem-dots6">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      {state === "saved" && <div className="gem-badge saved">✦</div>}
      {state === "attention" && <div className="gem-badge attention">!</div>}
    </div>
  );
}

export default Gem;
