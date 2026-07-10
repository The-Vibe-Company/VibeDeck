export async function runWithFinalStateBroadcast(
  operation,
  { getState, broadcast, onBroadcastError = () => {} },
) {
  let completedState;
  try {
    completedState = await operation();
    return completedState;
  } finally {
    try {
      broadcast(completedState ?? getState());
    } catch (error) {
      onBroadcastError(error);
    }
  }
}
