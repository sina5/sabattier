// A minimal zustand-style store: create((set, get) => initialState).
// Listeners run synchronously after every set(), with the new and old state.
export function create(init) {
  let state;
  const listeners = new Set();
  const get = () => state;
  const set = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    const prev = state;
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state, prev);
  };
  state = init(set, get);
  return {
    getState: get,
    setState: set,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
