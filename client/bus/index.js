import mitt from "mitt";
import { RETAINED_TOPICS, TOPICS } from "./topics.js";

const emitter = mitt();
const retained = new Map();

export function subscribe(topic, handler) {
  if (RETAINED_TOPICS.has(topic)) {
    let active = true;
    // Live delivery and replay share the publication identity fence. A nested
    // publication may supersede an outer emit before its later listeners run.
    const receive = publication => {
      if (active && retained.get(topic) === publication) handler(publication.payload);
    };
    emitter.on(topic, receive);
    const current = retained.get(topic);
    if (current) queueMicrotask(() => {
      // A live publication supersedes this queued snapshot; never replay backwards.
      receive(current);
    });
    return () => { active = false; emitter.off(topic, receive); };
  }
  emitter.on(topic, handler);
  return () => emitter.off(topic, handler);
}

export function publish(topic, payload) {
  if (RETAINED_TOPICS.has(topic)) {
    const publication = { payload };
    retained.set(topic, publication);
    emitter.emit(topic, publication);
  } else emitter.emit(topic, payload);
}

export { RETAINED_TOPICS, TOPICS };
