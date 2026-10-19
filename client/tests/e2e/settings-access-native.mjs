// The summary is an asynchronous read consumer, separate from wizard loading.
// Observe its settled layout before computing coordinates for the next action.
export async function waitForAccessSummary(session) {
  await session.poll("(()=>{const summary=document.querySelector('[data-access-summary]');return !!summary&&!summary.querySelector('[role=status]');})()");
}
