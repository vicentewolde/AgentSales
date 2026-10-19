/**
 * Abre una dirección en esta misma pestaña (la autorización de Mercado Libre, F8-T19). Es un módulo
 * aparte para que las pruebas lo reemplacen: jsdom no navega.
 */
export function goTo(url: string): void {
  window.location.assign(url);
}
