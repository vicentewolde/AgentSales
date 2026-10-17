import type { Broker } from "@agentsales/core";
import { type FormEvent, useId } from "react";
import type { BrokerFields } from "../../queries/brokers.js";
import { ErrorAlert } from "../ErrorAlert.js";

const fieldClass = "mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm";

/** Lo que manda el formulario: la marca, el `slug` al crear y, del administrador, los ajustes. */
export type BrandFormValues = BrokerFields & { slug?: string };

/** Un texto vacío borra un campo opcional (`null`); los obligatorios van tal cual (la API valida). */
const optional = (value: FormDataEntryValue | null) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? null : text;
};
const required = (value: FormDataEntryValue | null) => (typeof value === "string" ? value : "");

/**
 * La marca de un corredor (spec F7 §4.6): crear (con `slug`) o editar. Con `admin`, además, si es
 * propio y su tope de IA. Las reglas las revisa la API (las de la hoja Corredor) y el error dice
 * qué campo no sirve.
 */
export function BrandForm({
  broker,
  withSlug = false,
  admin = false,
  submitLabel,
  pending,
  error,
  onSubmit,
}: {
  broker?: Broker;
  withSlug?: boolean;
  admin?: boolean;
  submitLabel: string;
  pending: boolean;
  error: Error | null;
  onSubmit: (values: BrandFormValues) => void;
}) {
  const id = useId();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const cap = optional(form.get("cap"));
    onSubmit({
      ...(withSlug ? { slug: required(form.get("slug")).trim() } : {}),
      name: required(form.get("name")),
      brandName: required(form.get("brandName")),
      primaryColor: required(form.get("primaryColor")),
      secondaryColor: optional(form.get("secondaryColor")),
      whatsapp: optional(form.get("whatsapp")),
      email: optional(form.get("email")),
      instagramHandle: optional(form.get("instagramHandle")),
      website: optional(form.get("website")),
      tone: optional(form.get("tone")),
      fixedHashtags: required(form.get("fixedHashtags"))
        .split(/[\s,]+/)
        .filter(Boolean),
      ...(admin
        ? {
            operatorOwned: form.get("operatorOwned") === "on",
            llmMonthlyCapUsd: cap === null ? null : Number(cap.replace(",", ".")),
          }
        : {}),
    });
  };
  const field = (name: string, label: string, value: string | null | undefined, hint?: string) => (
    <div>
      <label htmlFor={`${id}-${name}`} className="text-sm font-medium">
        {label}
      </label>
      <input id={`${id}-${name}`} name={name} defaultValue={value ?? ""} className={fieldClass} />
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
  return (
    <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-2">
      {withSlug && field("slug", "Identificador", "", "minúsculas, números y guiones (no cambia)")}
      {field("name", "Nombre de la persona", broker?.name)}
      {field("brandName", "Marca", broker?.brandName)}
      {field("primaryColor", "Color primario", broker?.primaryColor, "#RRGGBB")}
      {field("secondaryColor", "Color secundario", broker?.secondaryColor, "vacío: el primario")}
      {field("whatsapp", "WhatsApp", broker?.whatsapp, "con código de país (Portal lo exige)")}
      {field("email", "Correo", broker?.email)}
      {field("instagramHandle", "Instagram", broker?.instagramHandle)}
      {field("website", "Sitio web", broker?.website)}
      {field("tone", "Tono de los textos", broker?.tone)}
      {field(
        "fixedHashtags",
        "Hashtags fijos",
        broker?.fixedHashtags.join(" "),
        "separados por espacio",
      )}
      {admin && (
        <>
          <div>
            <label htmlFor={`${id}-cap`} className="text-sm font-medium">
              Tope de IA del mes (US$)
            </label>
            <input
              id={`${id}-cap`}
              name="cap"
              inputMode="decimal"
              defaultValue={broker?.llmMonthlyCapUsd ?? ""}
              className={fieldClass}
            />
            <p className="mt-1 text-xs text-slate-500">vacío: sin tope</p>
          </div>
          <label className="flex items-center gap-2 self-center text-sm">
            <input
              type="checkbox"
              name="operatorOwned"
              defaultChecked={broker?.operatorOwned ?? false}
            />
            Corredor propio (usa tu plan de Claude y el formulario automático de Marketplace)
          </label>
        </>
      )}
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Guardando…" : submitLabel}
        </button>
        {error && <ErrorAlert error={error} />}
      </div>
    </form>
  );
}
