/**
 * El secreto del webhook de leads de cada corredor (F10-T04, ADR-0033 punto 4). Solo se guarda su
 * hash: el secreto en claro se muestra una vez al generarlo.
 */
export interface LeadWebhookKeyRepository {
  /** El hash vigente del corredor, o `null` si nunca generó uno. */
  getHash(brokerId: string): Promise<string | null>;
  /** Guarda el hash nuevo; el anterior deja de servir (rotar). */
  setHash(brokerId: string, secretHash: string): Promise<void>;
}
