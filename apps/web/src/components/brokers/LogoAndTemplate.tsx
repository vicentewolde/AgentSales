import type { Broker } from "@agentsales/core";
import { type ChangeEvent, useId } from "react";
import { useBrokerTemplateHref, useUploadLogo } from "../../queries/brokers.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { FILE_INPUT } from "../ui/styles.js";

/** El logo (PNG, JPEG o WebP de hasta 5 MB) y la planilla de Excel del corredor (spec F7 §4.6). */
export function LogoAndTemplate({ broker }: { broker: Broker }) {
  const upload = useUploadLogo(broker.id);
  const templateHref = useBrokerTemplateHref(broker.id);
  const id = useId();
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file !== undefined) upload.mutate(file);
    event.target.value = "";
  };
  return (
    <section aria-label="Logo y planilla" className="mt-4">
      <h2 className="text-lg font-semibold">Logo y planilla</h2>
      <p className="mt-1 text-sm text-fg-muted">
        {broker.logoMediaId === null ? "Todavía no tiene logo." : "Ya tiene logo."} PNG, JPEG o WebP
        de hasta 5 MB. Lo ya preparado no cambia: prepara de nuevo solo las imágenes.
      </p>
      <label htmlFor={id} className="mt-2 inline-block text-sm font-medium">
        Subir logo
      </label>
      <input
        id={id}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={pick}
        disabled={upload.isPending}
        className={`ml-2 ${FILE_INPUT}`}
      />
      <div role="status">
        {upload.isPending && <p className="text-sm text-fg-muted">Subiendo…</p>}
        {upload.isSuccess && <p className="text-sm text-success-800">Logo guardado.</p>}
      </div>
      {upload.error && <ErrorAlert error={upload.error} />}
      <p className="mt-3 text-sm">
        <a
          href={templateHref}
          download
          className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-900"
        >
          Bajar la planilla de Excel
        </a>{" "}
        <span className="text-fg-muted">
          (con la hoja Corredor llena; una planilla vieja puede deshacer lo que edites aquí)
        </span>
      </p>
    </section>
  );
}
