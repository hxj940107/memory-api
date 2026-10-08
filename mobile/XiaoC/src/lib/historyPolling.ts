// One foreground timer per focused chat; cleanup also removes the AppState listener.
export function startHistoryPolling({
  appState,
  refresh,
  setTimer = setInterval,
  clearTimer = clearInterval,
}: {
  appState: {
    currentState: string | null;
    addEventListener: (event: "change", listener: (state: string) => void) => { remove: () => void };
  };
  refresh: () => void;
  setTimer?: typeof setInterval;
  clearTimer?: typeof clearInterval;
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const startTimer = () => {
    if (timer === null) timer = setTimer(refresh, 30_000);
  };
  if (appState.currentState === "active") startTimer();
  const subscription = appState.addEventListener("change", (state) => {
    if (state === "active") {
      startTimer();
      refresh();
    } else {
      stopTimer();
    }
  });
  return () => {
    stopTimer();
    subscription.remove();
  };
}
