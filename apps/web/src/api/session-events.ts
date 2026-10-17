// Cuando la API responde 401 `AUTH_REQUIRED` (la sesión venció o se cerró en otra pestaña), el
// cliente avisa aquí y el layout lleva a "Entrar" (spec F7 §4.11), sin que cada página lo maneje.

type Listener = () => void;
const listeners = new Set<Listener>();

/** Suscribe a "la sesión ya no vale"; devuelve cómo desuscribirse. */
export function onSessionExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifySessionExpired(): void {
  for (const listener of listeners) listener();
}
