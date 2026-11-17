/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rib.js — the Rib feature's data (DOM-free; 0.4 P20). brep-rib.js builds it with OpenCascade.
 *
 *   rib { sketch, t, side: 'mid' | 'front' | 'back', flip }
 *     An open chain of lines in a sketch (one line, or several end to end) is the rib's free edge. The rib fills the sketch
 *     plane from that edge to the body, on the side toward the body's centre of mass (flip: the other side; the same whichever
 *     end was drawn first), `t` thick across the plane: centred on it
 *     (mid) or all on the side of the plane's normal (front) or against it (back). The chain's end lines are carried on
 *     until they meet the body, so it may stop short of the walls. A side where the edge never meets the body is refused.
 */
import { registerParamField } from './params-part.js';
import { t } from './i18n.js';

// the type's name for people, read when shown (a getter: never translated at import)
export const RIB_LABELS = { get rib() { return t('model.feature.rib'); } };
export const RIB_BASE = { rib: 'Rib' };
export const RIB_EXACT_ONLY = ['rib'];
export const RIB_SIDES = ['mid', 'front', 'back'];
export const RIB_DEFAULTS = { rib: () => ({ sketch: null, t: 3, side: 'mid', flip: false }) };

registerParamField('rib', 't', { get label() { return t('rib.param.t'); }, kind: 'length', min: 1e-4, max: 1e5 });

/** Fill g from the untrusted feature f; c = part.js's reader context. → true for a rib. */
export function readRib(f, g, c) {
  if (f.type !== 'rib') return false;
  const need = (ok, key) => { if (!ok) throw new Error(t(key, { name: g.name })); };   // key: "{name}: … is bad."
  need(c.ids.has(f.sketch) && c.types.get(f.sketch) === 'sketch', 'model.file.bad.its_sketch');
  need(typeof f.t === 'number' && Number.isFinite(f.t) && f.t >= 1e-4 && f.t <= 1e5, 'model.file.bad.its_thickness');
  need(RIB_SIDES.includes(f.side), 'model.file.bad.its_side');
  Object.assign(g, { sketch: f.sketch, t: f.t, side: f.side, flip: f.flip === true });
  return true;
}
export const usesRib = (part) => part.features.some((f) => f.type === 'rib');
