// Feature-owned admission for the retained inventory policy controller. A
// committed write whose refresh was superseded needs an explicit native Review.
export async function settleSettingsInventory(session, expected) {
  const writes = [];
  const stop = session.page.onEvent(event => {
    if (event.method === "Network.requestWillBeSent" && event.params.request.method === "PUT" &&
      /\/_\/api\/plugin-host\/(?:policy|[^/]+\/enabled)(?:\?|$)/.test(event.params.request.url)) {
      writes.push({ url: event.params.request.url, body: event.params.request.postData });
    }
  });
  let reviewed = false;
  try {
    await session.poll(`(${expected}) && (!document.querySelector('[data-inventory-recovery]') || [...document.querySelectorAll('[data-inventory-recovery] button')].some(button=>button.textContent.trim()==='Review current policy'&&!button.disabled))`);
    // Callers can enter immediately after native click, before its deferred
    // original PUT dispatch. Keep those requests as evidence, but start the
    // no-replay interval only once the committed/settled outcome is observed.
    const acknowledgedWriteCount = writes.length;
    if (await session.evaluate("!!document.querySelector('[data-inventory-recovery]')")) {
      const committed = await session.evaluate("[...document.querySelectorAll('[role=alert]')].some(element=>element.textContent.includes('Policy saved;'))");
      if (!committed) throw Error("Inventory did not acknowledge its write; recovery is not a successful fixture precondition");
      await session.button("Review current policy", '[data-inventory-recovery]');
      reviewed = true;
    }
    await session.poll(`(${expected}) && !document.querySelector('[data-inventory-recovery]')`);
    const additionalPolicyPuts = writes.length - acknowledgedWriteCount;
    if (additionalPolicyPuts) throw Error(`Inventory Review sent an additional policy PUT: ${JSON.stringify(writes.slice(acknowledgedWriteCount))}`);
    return { explicitCommittedPolicyReview: reviewed, additionalPolicyPuts, policyRequestsWhileWaitingForAcknowledgement: writes.slice(0, acknowledgedWriteCount), retainedChoiceSettled: true };
  } finally { stop(); }
}
