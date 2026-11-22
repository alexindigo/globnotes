// SPDX-License-Identifier: LGPL-3.0-only
/** Trusted participant integration only. No bytes, writer or installer escapes.
 * A plain PublicationOutcome is deliberately not a completion capability. */
export interface SettledPublicationSet {
  readonly identity: object;
  readonly members: readonly object[];
}
const issued = new WeakMap<object, {
  readonly settled: () => SettledPublicationSet;
  readonly peers: Set<object>;
}>();
export function registerParticipantCompletion(
  participant: object,
  settled: () => SettledPublicationSet,
): void {
  if (issued.has(participant)) {
    throw new TypeError("Participant already bound.");
  }
  issued.set(participant, { settled, peers: new Set() });
}
export function requirePublicationPeer(
  participant: object,
  peer: object,
): void {
  const binding = issued.get(participant);
  if (!binding || !issued.has(peer) || participant === peer) {
    throw new TypeError("Publication requires issued distinct peers.");
  }
  binding.peers.add(peer);
}
export function assertPublicationPeers(members: readonly object[]): void {
  for (const participant of members) {
    const binding = issued.get(participant);
    if (
      !binding || [...binding.peers].find((peer) => !members.includes(peer))
    ) {
      throw new TypeError("Publication set is missing a required peer.");
    }
  }
}
export function settledPublication(participant: object): SettledPublicationSet {
  const binding = issued.get(participant);
  if (!binding) {
    throw new TypeError("Completion requires an issued participant.");
  }
  return binding.settled();
}
