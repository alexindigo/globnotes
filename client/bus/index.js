import mitt from "mitt";
import { TOPICS } from "./topics.js";

const emitter = mitt();

export function subscribe(topic, handler) {
  emitter.on(topic, handler);
  return () => emitter.off(topic, handler);
}

export function publish(topic, payload) {
  emitter.emit(topic, payload);
}

export { TOPICS };
