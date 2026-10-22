import type { BrokerView } from "@agentsales/api/contracts";
import { effectivePublishMode } from "@agentsales/core";
import { type FormEvent, useId, useState } from "react";
import { useUpdateBroker } from "../../queries/brokers.js";
import { useHealth } from "../../queries/health.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Field.js";

/**
 * El interruptor del modo en vivo de la marca (F9.5-T22, ADR-0036), en la ficha del corredor (solo
 * el administrador). Explica las dos llaves y, para encender, pide escribir el identificador (slug)
 * de la marca: publicar de verdad es una decisión que se escribe. Apagar no pide confirmación. Un
 * corredor que no es propio no se enciende.
 */
export function LiveSwitch({ broker }: { broker: BrokerView }) {
  const update = useUpdateBroker(broker.id);
  const health = useHealth();
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const server = health.data?.publishMode;
  const today = server === undefined ? undefined : effectivePublishMode(server, broker);

  const turnOn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    update.mutate(
      { liveEnabled: true, liveConfirm: typed.trim() },
      {
        onSuccess: () => {
          setConfirming(false);
          setTyped("");
        },
      },
    );
  };
  const turnOff = () => {
    setConfirming(false);
    update.mutate({ liveEnabled: false });
  };

  return (
    <section aria-label="Modo en vivo" className="mt-6">
      <h2 className="text-lg font-semibold">Modo en vivo</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Lo que publiques en {broker.brandName} sale de verdad en las redes solo con las dos llaves
        abiertas: el servidor en vivo (la pone el operador en el servidor, <code>PUBLISH_MODE</code>
        ) y esta marca encendida. Con cualquiera apagada, todo se simula.
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        <li>
          Servidor:{" "}
          <strong>
            {server === undefined ? "…" : server === "live" ? "en vivo" : "en simulación"}
          </strong>
        </li>
        <li>
          Esta marca: <strong>{broker.liveEnabled ? "encendida" : "apagada"}</strong>
        </li>
        <li role="status">
          Hoy publica:{" "}
          <strong className={today === "live" ? "text-danger-700" : undefined}>
            {today === undefined ? "…" : today === "live" ? "de verdad" : "en simulación"}
          </strong>
        </li>
      </ul>
      {!broker.operatorOwned && (
        <p className="mt-2 text-sm text-fg-muted">
          Esta marca no es propia: solo lo propio del operador puede publicar en vivo.
        </p>
      )}
      {broker.operatorOwned && !broker.liveEnabled && !confirming && (
        <div className="mt-3">
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Encender el modo en vivo
          </Button>
        </div>
      )}
      {broker.operatorOwned && !broker.liveEnabled && confirming && (
        <form onSubmit={turnOn} className="mt-3 space-y-2" aria-label="Confirmar el modo en vivo">
          <p role="alert" className="text-sm font-medium text-danger-700">
            Al encenderlo, lo que publiques en {broker.brandName} saldrá de verdad
            {server === "live"
              ? " desde ahora."
              : " apenas el operador ponga el servidor en vivo (hoy está en simulación)."}
          </p>
          <label htmlFor={`${id}-slug`} className="block text-sm font-medium">
            Para confirmar, escribe <code>{broker.slug}</code>
          </label>
          <Input
            id={`${id}-slug`}
            value={typed}
            autoComplete="off"
            autoFocus
            onChange={(event) => setTyped(event.target.value)}
            className="max-w-xs"
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="danger"
              disabled={typed.trim() !== broker.slug}
              loading={update.isPending}
            >
              Encender
            </Button>
            <Button
              variant="link"
              onClick={() => {
                setConfirming(false);
                setTyped("");
              }}
            >
              Cancelar
            </Button>
          </div>
        </form>
      )}
      {broker.liveEnabled && (
        <div className="mt-3">
          <Button variant="secondary" loading={update.isPending} onClick={turnOff}>
            Apagar el modo en vivo
          </Button>
        </div>
      )}
      {update.error && <ErrorAlert error={update.error} />}
    </section>
  );
}
