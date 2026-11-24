// SPDX-License-Identifier: LGPL-3.0-only
/** Trusted participant integration only. No bytes, writer or installer escapes.
 * A plain PublicationOutcome is deliberately not a completion capability. */
export interface SettledPublicationSet {
  readonly identity: object;
  readonly members: readonly object[];
}
const issued = new WeakMap<object, {
  readonly settled: () => SettledPublicationSet;
  readonly peerRequirements: ((members: readonly object[]) => boolean)[];
}>();
/** The native set owns settlement and revalidates every member's binding. */
export function registerParticipantCompletion(
  participant: object,
  settled: () => SettledPublicationSet,
): void {
  if (issued.has(participant)) {
    throw new TypeError("Participant already bound.");
  }
  issued.set(participant, { settled, peerRequirements: [] });
}

/** Both endpoints acquire the same requirement on registration, even if the
 * opposite endpoint hasn't been prepared yet. Only native handles can bind. */
export function definePublicationPeerPair<L extends object, R extends object>(
  matches: (left: L, right: R) => boolean,
) {
  const left = new WeakMap<object, L>();
  const right = new WeakMap<object, R>();
  function bind<T extends object, U extends object>(
    participant: object,
    facts: T,
    own: WeakMap<object, T>,
    opposite: WeakMap<object, U>,
    match: (ownFacts: T, peerFacts: U) => boolean,
  ) {
    const binding = issued.get(participant);
    if (!binding || own.has(participant) || opposite.has(participant)) {
      throw new TypeError("Publication requires issued distinct peers.");
    }
    own.set(participant, facts);
    binding.peerRequirements.push((members) =>
      members.some((member) => {
        const peer = opposite.get(member);
        return peer !== undefined && match(facts, peer);
      })
    );
  }
  return Object.freeze({
    left: (participant: object, facts: L) =>
      bind(participant, facts, left, right, matches),
    right: (participant: object, facts: R) =>
      bind(participant, facts, right, left, (r, l) => matches(l, r)),
  });
}

export function assertPublicationPeers(members: readonly object[]): void {
  for (const participant of members) {
    const binding = issued.get(participant);
    if (
      !binding || !binding.peerRequirements.every((require) => require(members))
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
