// Bounded event buffer with a polling cursor. The UI asks GET /api/events?since=<last seq> and sees the stop as it happens.
// Strings are redacted and made inert when the event is stored; numbers, booleans and enums pass through.
import { redactText } from './redaction.js';
import { revealText } from './sanitize.js';

export const EVENT_CAP = 500;

const clean = (v, depth = 0) => {
  if (typeof v === 'string') return revealText(redactText(v), 300);
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [revealText(k, 64), clean(x, depth + 1)]));
  return undefined;
};

// `onEmit(event)` is called with each stored event right after it was stamped, once, in order (the run-observability log uses it).
export function createEvents({ clock, cap = EVENT_CAP, onEmit = () => {} } = {}) {
  let seq = 0;
  let buf = [];
  return {
    emit(type, agentId, data = {}) {
      seq += 1;
      const event = Object.freeze({ seq, at: clock.iso(), type, agentId: agentId === null || agentId === undefined ? null : clean(String(agentId)), data: clean(data) });
      buf.push(event);
      if (buf.length > cap) buf = buf.slice(buf.length - cap);
      onEmit(event);
      return seq;
    },
    // `next` is the cursor to pass back as `since`. `oldest` lets a slow client notice that it missed events.
    list({ since = 0, limit = 200 } = {}) {
      const events = buf.filter((e) => e.seq > since).slice(0, limit).map((e) => structuredClone(e));
      return { events, next: events.length ? events[events.length - 1].seq : Math.max(since, 0), head: seq, oldest: buf.length ? buf[0].seq : seq + 1 };
    },
    clear() { buf = []; },
    get head() { return seq; },
    get size() { return buf.length; },
  };
}
